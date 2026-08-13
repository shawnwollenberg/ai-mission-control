import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { canonicalHash } from "@/lib/canonical-json";
import { ValidationFailedError } from "@/lib/application-errors";

export const FILESYSTEM_WRITE_AUTHORITY_VERSION = "filesystem-write-authority/1" as const;
export const FILESYSTEM_WRITE_FORBIDDEN = "FILESYSTEM_WRITE_FORBIDDEN" as const;

export type FilesystemWriteAuthority = Readonly<{
  schemaVersion: typeof FILESYSTEM_WRITE_AUTHORITY_VERSION;
  acceptanceRunId: string;
  candidateArtifactSha256: string;
  workspaceId: string;
  missionId: string;
  childMissionId: string | null;
  executionId: string;
  assignmentId: string;
  assignmentAttempt: number;
  providerAttemptId: string;
  agentId: string;
  provider: string;
  model: string;
  runtimeProfileId: string;
  repositoryId: string;
  repositorySnapshotSha256: string;
  worktreeIdentitySha256: string;
  approvedWritableRoots: readonly string[];
  readOnlyRoots: readonly string[];
  temporaryRoot: string;
  sandboxRoot: string;
  artifactStagingRoot: string | null;
  authoritySha256: string;
}>;

export type FilesystemWriteDecision = Readonly<{
  schemaVersion: "filesystem-write-decision/1";
  authoritySha256: string;
  providerAttemptId: string;
  operation: "create" | "modify" | "delete" | "rename";
  requestedPathIdentitySha256: string;
  canonicalTargetPath: string;
  canonicalApprovedRoots: readonly string[];
  allowed: boolean;
  reasonCode: typeof FILESYSTEM_WRITE_FORBIDDEN | null;
}>;

const inside = (root: string, target: string) => {
  const suffix = relative(root, target);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
};

async function canonicalCreationTarget(requestedPath: string) {
  if (!isAbsolute(requestedPath)) throw new ValidationFailedError("Filesystem write path must be absolute");
  const lexical = normalize(resolve(requestedPath));
  const missing: string[] = [];
  let cursor = lexical;
  for (;;) {
    try {
      await lstat(cursor);
      const existing = await realpath(cursor);
      if (!(await stat(existing)).isDirectory() && missing.length > 0)
        throw new ValidationFailedError("Filesystem write path parent is not a directory", {
          reason_code: FILESYSTEM_WRITE_FORBIDDEN,
        });
      return join(existing, ...missing.reverse());
    } catch (error) {
      if (["ELOOP", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))
        throw new ValidationFailedError("Filesystem write path contains a symlink loop", {
          reason_code: FILESYSTEM_WRITE_FORBIDDEN,
        });
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor || cursor === parse(cursor).root)
        throw new ValidationFailedError("Filesystem write path has no canonical existing parent", {
          reason_code: FILESYSTEM_WRITE_FORBIDDEN,
        });
      missing.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

export async function createFilesystemWriteAuthority(
  input: Omit<FilesystemWriteAuthority, "schemaVersion" | "authoritySha256">,
): Promise<FilesystemWriteAuthority> {
  if (
    !Number.isSafeInteger(input.assignmentAttempt) ||
    input.assignmentAttempt < 1 ||
    !new RegExp(`^${input.assignmentAttempt}-[1-9]\\d*$`).test(input.providerAttemptId) ||
    ![input.candidateArtifactSha256, input.repositorySnapshotSha256, input.worktreeIdentitySha256].every((value) =>
      /^[a-f0-9]{64}$/.test(value),
    ) ||
    ![
      input.acceptanceRunId,
      input.workspaceId,
      input.missionId,
      input.executionId,
      input.assignmentId,
      input.agentId,
      input.provider,
      input.model,
      input.runtimeProfileId,
      input.repositoryId,
    ].every((value) => typeof value === "string" && value.length > 0)
  )
    throw new ValidationFailedError("Filesystem write authority execution binding is invalid");
  const approvedWritableRoots = Array.from(
    new Set(await Promise.all(input.approvedWritableRoots.map((root) => realpath(root)))),
  ).sort();
  const readOnlyRoots = Array.from(
    new Set(await Promise.all(input.readOnlyRoots.map((root) => realpath(root)))),
  ).sort();
  if (!approvedWritableRoots.length)
    throw new ValidationFailedError("Filesystem write authority has no writable roots");
  for (const root of approvedWritableRoots) {
    if (!isAbsolute(root) || root === parse(root).root)
      throw new ValidationFailedError("Filesystem write authority contains a broad writable root");
  }
  const unsigned = {
    ...input,
    schemaVersion: FILESYSTEM_WRITE_AUTHORITY_VERSION,
    approvedWritableRoots,
    readOnlyRoots,
    temporaryRoot: await realpath(input.temporaryRoot),
    sandboxRoot: await realpath(input.sandboxRoot),
    artifactStagingRoot: input.artifactStagingRoot ? await realpath(input.artifactStagingRoot) : null,
  };
  return Object.freeze({ ...unsigned, authoritySha256: canonicalHash(unsigned) });
}

export async function evaluateFilesystemWrite(
  authority: FilesystemWriteAuthority,
  requestedPath: string,
  operation: FilesystemWriteDecision["operation"],
): Promise<FilesystemWriteDecision> {
  const { authoritySha256, ...unsigned } = authority;
  if (authority.schemaVersion !== FILESYSTEM_WRITE_AUTHORITY_VERSION || canonicalHash(unsigned) !== authoritySha256)
    throw new ValidationFailedError("Filesystem write authority identity changed", {
      reason_code: FILESYSTEM_WRITE_FORBIDDEN,
    });
  const canonicalTargetPath = await canonicalCreationTarget(requestedPath);
  const canonicalApprovedRoots = await Promise.all(authority.approvedWritableRoots.map((root) => realpath(root)));
  const allowed = canonicalApprovedRoots.some((root) => inside(root, canonicalTargetPath));
  const decision = {
    schemaVersion: "filesystem-write-decision/1" as const,
    authoritySha256,
    providerAttemptId: authority.providerAttemptId,
    operation,
    requestedPathIdentitySha256: canonicalHash({ requestedPath }),
    canonicalTargetPath,
    canonicalApprovedRoots: canonicalApprovedRoots.sort(),
    allowed,
    reasonCode: allowed ? null : FILESYSTEM_WRITE_FORBIDDEN,
  };
  if (!allowed)
    throw new ValidationFailedError("Provider filesystem write is outside its governed authority", {
      reason_code: FILESYSTEM_WRITE_FORBIDDEN,
      filesystem_write_decision: decision,
    });
  return decision;
}
