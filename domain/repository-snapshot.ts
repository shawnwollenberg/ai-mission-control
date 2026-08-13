import { canonicalHash, canonicalJson } from "@/lib/canonical-json";
import { ValidationFailedError } from "@/lib/application-errors";

export type RepositoryManifestEntry = {
  path: string;
  type: "file" | "symlink" | "submodule";
  mode: "100644" | "100755" | "120000" | "160000";
  size: number;
  contentSha256: string;
  gitObjectId: string | null;
  symlinkTarget: string | null;
};
export type RepositorySubmoduleState = {
  path: string;
  commit: string;
  status: "clean" | "modified" | "uninitialized" | "conflict";
};
export type CompleteRepositoryStateV3 = {
  schemaVersion: "complete_repository_state/3";
  repositoryIdentity: string;
  repositoryRootIdentity: string;
  baseBranch: string;
  baseCommit: string;
  headCommit: string;
  cleanWorktree: boolean;
  trackedStatusHash: string;
  trackedStatusEmpty: boolean;
  trackedIndexHash: string;
  trackedManifestHash: string;
  trackedCount: number;
  trackedContentMatchesIndex: boolean;
  trackedManifest: RepositoryManifestEntry[];
  untrackedPolicyId: "include-untracked/1";
  untrackedManifestHash: string;
  untrackedCount: number;
  untrackedManifest: RepositoryManifestEntry[];
  ignoredPolicyId: "runtime-relevant-ignored/1";
  relevantIgnoredManifestHash: string;
  relevantIgnoredCount: number;
  relevantIgnoredManifest: RepositoryManifestEntry[];
  submoduleStatusHash: string;
  submodules: RepositorySubmoduleState[];
  snapshotHash: string;
};
export type CompleteRepositoryStateV2 = {
  schemaVersion: "complete_repository_state/2";
  headCommit: string;
  trackedStatusHash: string;
  trackedStatusEmpty: boolean;
  trackedIndexHash: string;
  trackedManifestHash: string;
  trackedCount: number;
  trackedContentMatchesIndex: boolean;
  untrackedManifestHash: string;
  untrackedCount: number;
  ignoredPolicyId: "runtime-relevant-ignored/1";
  relevantIgnoredManifestHash: string;
  relevantIgnoredCount: number;
  submoduleStatusHash: string;
  snapshotHash: string;
};
export type CompleteRepositoryState = CompleteRepositoryStateV2 | CompleteRepositoryStateV3;

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
function exactKeys(row: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw new ValidationFailedError(`${label} contains unsupported fields`);
}
function safePath(value: unknown) {
  const path = String(value ?? "");
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new ValidationFailedError("Repository manifest path is unsafe");
  return path;
}
function parseManifest(value: unknown, label: string, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new ValidationFailedError(`${label} is invalid or exceeds its bounded size`);
  const seen = new Set<string>();
  const entries = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ValidationFailedError(`${label} entry is invalid`);
    const row = item as Record<string, unknown>;
    exactKeys(row, ["path", "type", "mode", "size", "contentSha256", "gitObjectId", "symlinkTarget"], label);
    const path = safePath(row.path);
    if (seen.has(path)) throw new ValidationFailedError(`${label} contains a duplicate path`);
    seen.add(path);
    const type = String(row.type ?? "");
    const mode = String(row.mode ?? "");
    const size = Number(row.size);
    const contentSha256 = String(row.contentSha256 ?? "");
    const gitObjectId = row.gitObjectId === null ? null : String(row.gitObjectId ?? "");
    const symlinkTarget = row.symlinkTarget === null ? null : String(row.symlinkTarget ?? "");
    if (
      !["file", "symlink", "submodule"].includes(type) ||
      !["100644", "100755", "120000", "160000"].includes(mode) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 1_000_000_000 ||
      !HASH.test(contentSha256) ||
      (gitObjectId !== null && !COMMIT.test(gitObjectId)) ||
      (symlinkTarget !== null && (!symlinkTarget || symlinkTarget.length > 4096)) ||
      (type === "symlink") !== (mode === "120000") ||
      (type === "submodule") !== (mode === "160000") ||
      (type === "symlink") !== (symlinkTarget !== null)
    )
      throw new ValidationFailedError(`${label} entry fields are invalid`);
    return { path, type, mode, size, contentSha256, gitObjectId, symlinkTarget } as RepositoryManifestEntry;
  });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
function parseSubmodules(value: unknown) {
  if (!Array.isArray(value) || value.length > 1024)
    throw new ValidationFailedError("Repository submodule state is invalid or exceeds its bounded size");
  const seen = new Set<string>();
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new ValidationFailedError("Repository submodule entry is invalid");
      const row = item as Record<string, unknown>;
      exactKeys(row, ["path", "commit", "status"], "Repository submodule entry");
      const path = safePath(row.path);
      if (seen.has(path)) throw new ValidationFailedError("Repository submodule state contains a duplicate path");
      seen.add(path);
      const commit = String(row.commit ?? "");
      const status = String(row.status ?? "");
      if (!COMMIT.test(commit) || !["clean", "modified", "uninitialized", "conflict"].includes(status))
        throw new ValidationFailedError("Repository submodule entry fields are invalid");
      return { path, commit, status } as RepositorySubmoduleState;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
function parseV2(row: Record<string, unknown>, expectedCommit?: string): CompleteRepositoryStateV2 {
  const allowed = [
    "schemaVersion",
    "headCommit",
    "trackedStatusHash",
    "trackedStatusEmpty",
    "trackedIndexHash",
    "trackedManifestHash",
    "trackedCount",
    "trackedContentMatchesIndex",
    "untrackedManifestHash",
    "untrackedCount",
    "ignoredPolicyId",
    "relevantIgnoredManifestHash",
    "relevantIgnoredCount",
    "submoduleStatusHash",
    "snapshotHash",
  ];
  exactKeys(row, allowed, "Complete repository state");
  const state = {
    schemaVersion: "complete_repository_state/2" as const,
    headCommit: String(row.headCommit ?? ""),
    trackedStatusHash: String(row.trackedStatusHash ?? ""),
    trackedStatusEmpty: row.trackedStatusEmpty === true,
    trackedIndexHash: String(row.trackedIndexHash ?? ""),
    trackedManifestHash: String(row.trackedManifestHash ?? ""),
    trackedCount: Number(row.trackedCount),
    trackedContentMatchesIndex: row.trackedContentMatchesIndex === true,
    untrackedManifestHash: String(row.untrackedManifestHash ?? ""),
    untrackedCount: Number(row.untrackedCount),
    ignoredPolicyId: String(row.ignoredPolicyId ?? "") as "runtime-relevant-ignored/1",
    relevantIgnoredManifestHash: String(row.relevantIgnoredManifestHash ?? ""),
    relevantIgnoredCount: Number(row.relevantIgnoredCount),
    submoduleStatusHash: String(row.submoduleStatusHash ?? ""),
  };
  if (
    state.ignoredPolicyId !== "runtime-relevant-ignored/1" ||
    !COMMIT.test(state.headCommit) ||
    (expectedCommit !== undefined && state.headCommit !== expectedCommit) ||
    [
      state.trackedStatusHash,
      state.trackedIndexHash,
      state.trackedManifestHash,
      state.untrackedManifestHash,
      state.relevantIgnoredManifestHash,
      state.submoduleStatusHash,
    ].some((hash) => !HASH.test(hash)) ||
    [state.trackedCount, state.untrackedCount, state.relevantIgnoredCount].some(
      (count) => !Number.isSafeInteger(count) || count < 0 || count > 100_000,
    )
  )
    throw new ValidationFailedError("Complete repository state is invalid");
  const snapshotHash = String(row.snapshotHash ?? "");
  if (snapshotHash !== canonicalHash(state))
    throw new ValidationFailedError("Complete repository snapshot hash is invalid");
  if (Buffer.byteLength(canonicalJson(state)) > 262_144)
    throw new ValidationFailedError("Complete repository snapshot exceeds the immutable artifact size limit");
  return { ...state, snapshotHash };
}
function parseV3(
  row: Record<string, unknown>,
  expected: { commit?: string; branch?: string } = {},
): CompleteRepositoryStateV3 {
  const allowed = [
    "schemaVersion",
    "repositoryIdentity",
    "repositoryRootIdentity",
    "baseBranch",
    "baseCommit",
    "headCommit",
    "cleanWorktree",
    "trackedStatusHash",
    "trackedStatusEmpty",
    "trackedIndexHash",
    "trackedManifestHash",
    "trackedCount",
    "trackedContentMatchesIndex",
    "trackedManifest",
    "untrackedPolicyId",
    "untrackedManifestHash",
    "untrackedCount",
    "untrackedManifest",
    "ignoredPolicyId",
    "relevantIgnoredManifestHash",
    "relevantIgnoredCount",
    "relevantIgnoredManifest",
    "submoduleStatusHash",
    "submodules",
    "snapshotHash",
  ];
  exactKeys(row, allowed, "Complete repository state v3");
  const trackedManifest = parseManifest(row.trackedManifest, "Tracked repository manifest", 100_000);
  const untrackedManifest = parseManifest(row.untrackedManifest, "Untracked repository manifest", 2048);
  const relevantIgnoredManifest = parseManifest(
    row.relevantIgnoredManifest,
    "Relevant ignored repository manifest",
    2048,
  );
  const submodules = parseSubmodules(row.submodules);
  const state = {
    schemaVersion: "complete_repository_state/3" as const,
    repositoryIdentity: String(row.repositoryIdentity ?? ""),
    repositoryRootIdentity: String(row.repositoryRootIdentity ?? ""),
    baseBranch: String(row.baseBranch ?? ""),
    baseCommit: String(row.baseCommit ?? ""),
    headCommit: String(row.headCommit ?? ""),
    cleanWorktree: row.cleanWorktree === true,
    trackedStatusHash: String(row.trackedStatusHash ?? ""),
    trackedStatusEmpty: row.trackedStatusEmpty === true,
    trackedIndexHash: String(row.trackedIndexHash ?? ""),
    trackedManifestHash: String(row.trackedManifestHash ?? ""),
    trackedCount: Number(row.trackedCount),
    trackedContentMatchesIndex: row.trackedContentMatchesIndex === true,
    trackedManifest,
    untrackedPolicyId: String(row.untrackedPolicyId ?? "") as "include-untracked/1",
    untrackedManifestHash: String(row.untrackedManifestHash ?? ""),
    untrackedCount: Number(row.untrackedCount),
    untrackedManifest,
    ignoredPolicyId: String(row.ignoredPolicyId ?? "") as "runtime-relevant-ignored/1",
    relevantIgnoredManifestHash: String(row.relevantIgnoredManifestHash ?? ""),
    relevantIgnoredCount: Number(row.relevantIgnoredCount),
    relevantIgnoredManifest,
    submoduleStatusHash: String(row.submoduleStatusHash ?? ""),
    submodules,
  };
  if (
    !HASH.test(state.repositoryIdentity) ||
    !HASH.test(state.repositoryRootIdentity) ||
    !state.baseBranch ||
    state.baseBranch.length > 200 ||
    !COMMIT.test(state.baseCommit) ||
    !COMMIT.test(state.headCommit) ||
    state.baseCommit !== state.headCommit ||
    (expected.commit !== undefined && state.headCommit !== expected.commit) ||
    (expected.branch !== undefined && state.baseBranch !== expected.branch) ||
    state.cleanWorktree !== (state.trackedStatusEmpty && untrackedManifest.length === 0) ||
    state.trackedCount !== trackedManifest.length ||
    state.untrackedCount !== untrackedManifest.length ||
    state.relevantIgnoredCount !== relevantIgnoredManifest.length ||
    state.untrackedPolicyId !== "include-untracked/1" ||
    state.ignoredPolicyId !== "runtime-relevant-ignored/1" ||
    [
      state.trackedStatusHash,
      state.trackedIndexHash,
      state.trackedManifestHash,
      state.untrackedManifestHash,
      state.relevantIgnoredManifestHash,
      state.submoduleStatusHash,
    ].some((hash) => !HASH.test(hash)) ||
    state.trackedManifestHash !== canonicalHash(trackedManifest) ||
    state.untrackedManifestHash !== canonicalHash(untrackedManifest) ||
    state.relevantIgnoredManifestHash !== canonicalHash(relevantIgnoredManifest) ||
    state.submoduleStatusHash !== canonicalHash(submodules)
  )
    throw new ValidationFailedError("Complete repository state v3 is invalid");
  const snapshotHash = String(row.snapshotHash ?? "");
  if (snapshotHash !== canonicalHash(state))
    throw new ValidationFailedError("Complete repository snapshot hash is invalid");
  if (Buffer.byteLength(canonicalJson(state)) > 262_144)
    throw new ValidationFailedError("Complete repository snapshot exceeds the immutable artifact size limit");
  return { ...state, snapshotHash };
}
export function parseCompleteRepositoryState(
  value: unknown,
  expected: { commit?: string; branch?: string } = {},
): CompleteRepositoryState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Complete repository state is required");
  const row = value as Record<string, unknown>;
  if (row.schemaVersion === "complete_repository_state/2") return parseV2(row, expected.commit);
  if (row.schemaVersion === "complete_repository_state/3") return parseV3(row, expected);
  throw new ValidationFailedError("Complete repository state schema is unsupported");
}
export function repositorySnapshotBytes(state: CompleteRepositoryState) {
  const document = { ...state } as Record<string, unknown>;
  delete document.snapshotHash;
  const bytes = Buffer.from(canonicalJson(document));
  if (canonicalHash(document) !== state.snapshotHash)
    throw new ValidationFailedError("Repository snapshot artifact does not match its state hash");
  return bytes;
}

export function assertRepositorySnapshotAuthority(actualSnapshotSha256: string, approvedSnapshotSha256: string) {
  if (
    !/^[a-f0-9]{64}$/.test(actualSnapshotSha256) ||
    !/^[a-f0-9]{64}$/.test(approvedSnapshotSha256) ||
    actualSnapshotSha256 !== approvedSnapshotSha256
  )
    throw new ValidationFailedError("Implementation repository state drifted from the approved consensus snapshot", {
      reason_code: "REPOSITORY_DRIFT_REJECTED",
    });
}
