import { ValidationFailedError } from "@/lib/application-errors";
import { canonicalHash } from "@/lib/canonical-json";

export const DISPOSABLE_LOCAL_IMPLEMENTATION_PROFILE = "disposable_local_implementation/1" as const;
export const PRODUCTION_READ_ONLY_PLANNING_PROFILE = "production_read_only_planning/1" as const;
export const productionReadOnlyPlanningOperations = [
  "inspect_repository",
  "prepare_project_brain_context",
  "generate_structured_plan",
  "critique_plan",
  "revise_plan",
  "review_canonical_plan",
] as const;

export type DisposableRepositoryAuthority = {
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
export type ProductionReadOnlyPlanningAuthority = {
  schemaVersion: "repository-authority/1";
  profile: typeof PRODUCTION_READ_ONLY_PLANNING_PROFILE;
  readAllowed: true;
  isolatedWorktreeWriteAllowed: false;
  missionAgentLocalCommitAllowed: false;
  providerDirectCommitAllowed: false;
  pushAllowed: false;
  pullRequestAllowed: false;
  mergeAllowed: false;
  publicationAllowed: false;
  deploymentAllowed: false;
  infrastructureMutationAllowed: false;
  planningAgentIds: string[];
  allowedOperations: readonly [...typeof productionReadOnlyPlanningOperations];
};
export type RepositoryAuthority = DisposableRepositoryAuthority | ProductionReadOnlyPlanningAuthority;

export function disposableLocalImplementationAuthority(
  implementationAgentIds: string[],
): DisposableRepositoryAuthority {
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

export function productionReadOnlyPlanningAuthority(planningAgentIds: string[]): ProductionReadOnlyPlanningAuthority {
  const ids = Array.from(new Set(planningAgentIds)).sort();
  if (!ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
    throw new ValidationFailedError("Production read-only planning authority requires explicit planning agents");
  return {
    schemaVersion: "repository-authority/1",
    profile: PRODUCTION_READ_ONLY_PLANNING_PROFILE,
    readAllowed: true,
    isolatedWorktreeWriteAllowed: false,
    missionAgentLocalCommitAllowed: false,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    planningAgentIds: ids,
    allowedOperations: [...productionReadOnlyPlanningOperations],
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

export function assertDisposableLocalImplementationAuthority(value: unknown): DisposableRepositoryAuthority {
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

export function assertProductionReadOnlyPlanningAuthority(value: unknown): ProductionReadOnlyPlanningAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Repository authority is missing");
  const row = value as Record<string, unknown>;
  const expected = productionReadOnlyPlanningAuthority(
    Array.isArray(row.planningAgentIds) ? row.planningAgentIds.map(String) : [],
  );
  if (canonicalHash(row) !== canonicalHash(expected))
    throw new ValidationFailedError("Repository authority is not the exact production read-only planning profile");
  return expected;
}

export function assertRepositoryAuthority(value: unknown): RepositoryAuthority {
  const profile = (value as Record<string, unknown> | null)?.profile;
  return profile === PRODUCTION_READ_ONLY_PLANNING_PROFILE
    ? assertProductionReadOnlyPlanningAuthority(value)
    : assertDisposableLocalImplementationAuthority(value);
}

export function assertProductionReadOnlyMissionAdmission(input: {
  authority: ProductionReadOnlyPlanningAuthority;
  runtimeMode: string;
  planningOnly?: boolean;
  plannerAgentIds: string[];
  preferredExecutorAgentId?: string;
  preferredExecutorModelId?: string;
}) {
  if (input.runtimeMode !== "production")
    throw new ValidationFailedError("Production read-only planning authority requires production runtime mode");
  if (input.planningOnly !== true || input.preferredExecutorAgentId || input.preferredExecutorModelId)
    throw new ValidationFailedError("Production read-only authority requires an explicit planning-only mission");
  if (input.plannerAgentIds.some((agentId) => !input.authority.planningAgentIds.includes(agentId)))
    throw new ValidationFailedError("A planning participant is outside production read-only repository authority");
  return input.authority;
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

export function assertProductionReadOnlyPlanningAuthorityProjection(input: {
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
  const authority = assertProductionReadOnlyPlanningAuthority(input.authority);
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
    input.isolatedWorktreeWriteAllowed ||
    input.missionAgentLocalCommitAllowed ||
    input.providerDirectCommitAllowed ||
    input.pushAllowed ||
    input.pullRequestAllowed ||
    input.mergeAllowed ||
    input.publicationAllowed ||
    input.deploymentAllowed ||
    input.infrastructureMutationAllowed
  )
    throw new ValidationFailedError("Production read-only planning authority contains mutation capability");
  return authority;
}

export function assertRepositoryAuthorityProjection(
  input: Parameters<typeof assertDisposableRepositoryAuthorityProjection>[0],
) {
  return (input.authority as Record<string, unknown> | null)?.profile === PRODUCTION_READ_ONLY_PLANNING_PROFILE
    ? assertProductionReadOnlyPlanningAuthorityProjection(input)
    : assertDisposableRepositoryAuthorityProjection(input);
}
