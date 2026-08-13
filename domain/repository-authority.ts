import { ValidationFailedError } from "@/lib/application-errors";
import { canonicalHash } from "@/lib/canonical-json";

export const DISPOSABLE_LOCAL_IMPLEMENTATION_PROFILE = "disposable_local_implementation/1" as const;

export type RepositoryAuthority = {
  schemaVersion: "repository-authority/1";
  profile: typeof DISPOSABLE_LOCAL_IMPLEMENTATION_PROFILE;
  readAllowed: true;
  isolatedWorktreeWriteAllowed: true;
  missionAgentLocalCommitAllowed: true;
  providerDirectCommitAllowed: false;
  pushAllowed: false;
  pullRequestAllowed: false;
  mergeAllowed: false;
  publicationAllowed: false;
  deploymentAllowed: false;
  infrastructureMutationAllowed: false;
  implementationAgentIds: string[];
};

export function disposableLocalImplementationAuthority(implementationAgentIds: string[]): RepositoryAuthority {
  const ids = Array.from(new Set(implementationAgentIds)).sort();
  if (!ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
    throw new ValidationFailedError("Disposable repository authority requires explicit implementation agents");
  return {
    schemaVersion: "repository-authority/1",
    profile: DISPOSABLE_LOCAL_IMPLEMENTATION_PROFILE,
    readAllowed: true,
    isolatedWorktreeWriteAllowed: true,
    missionAgentLocalCommitAllowed: true,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    implementationAgentIds: ids,
  };
}

export function repositoryAuthorityHash(authority: RepositoryAuthority) {
  return canonicalHash(authority);
}

export function repositoryAuthorityBindingHash(authority: RepositoryAuthority, commandId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(commandId))
    throw new ValidationFailedError("Repository authority binding requires a command identity");
  return canonicalHash({ schemaVersion: "repository-authority-binding/1", authority, commandId });
}

export function assertDisposableLocalImplementationAuthority(value: unknown): RepositoryAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Repository authority is missing");
  const row = value as Record<string, unknown>;
  const expected = disposableLocalImplementationAuthority(
    Array.isArray(row.implementationAgentIds) ? row.implementationAgentIds.map(String) : [],
  );
  if (canonicalHash(row) !== canonicalHash(expected))
    throw new ValidationFailedError("Repository authority is not the exact disposable local implementation profile");
  return expected;
}

export function assertDisposableRepositoryAuthorityProjection(input: {
  authority: unknown;
  authorityHash: string | null;
  authorityCommandId: string | null;
  authorityReceiptCount: number;
  readAllowed: boolean;
  writeAllowed: boolean;
  commitAllowed: boolean;
  isolatedWorktreeWriteAllowed: boolean;
  missionAgentLocalCommitAllowed: boolean;
  providerDirectCommitAllowed: boolean;
  pushAllowed: boolean;
  pullRequestAllowed: boolean;
  mergeAllowed: boolean;
  publicationAllowed: boolean;
  deploymentAllowed: boolean;
  infrastructureMutationAllowed: boolean;
}) {
  const authority = assertDisposableLocalImplementationAuthority(input.authority);
  if (
    !input.authorityHash ||
    !input.authorityCommandId ||
    input.authorityReceiptCount < 1 ||
    repositoryAuthorityBindingHash(authority, input.authorityCommandId) !== input.authorityHash
  )
    throw new ValidationFailedError("Repository authority binding or authenticated receipt is incomplete");
  if (
    !input.readAllowed ||
    input.writeAllowed ||
    input.commitAllowed ||
    !input.isolatedWorktreeWriteAllowed ||
    !input.missionAgentLocalCommitAllowed
  )
    throw new ValidationFailedError(
      "Repository authority must use narrow isolated-worktree and Mission Agent commit capabilities, not legacy generic write or commit",
    );
  if (
    input.providerDirectCommitAllowed ||
    input.pushAllowed ||
    input.pullRequestAllowed ||
    input.mergeAllowed ||
    input.publicationAllowed ||
    input.deploymentAllowed ||
    input.infrastructureMutationAllowed
  )
    throw new ValidationFailedError(
      "Direct commit, push, PR, publication, deployment, and infrastructure authority must remain disabled",
    );
  return authority;
}
