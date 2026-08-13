import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import type { AcceptanceCandidateBindings } from "./acceptance-requirement-evidence";
export type AcceptanceResourceCandidateBindings = Omit<AcceptanceCandidateBindings, "repositorySnapshotSha256">;

export const ACCEPTANCE_RESOURCE_INVENTORY_VERSION = "acceptance-resource-inventory/1" as const;
export const acceptanceResourceTypes = [
  "disposable_database",
  "database_process",
  "postgres_data_directory",
  "mission_control_server",
  "listener",
  "mission_agent_process",
  "provider_subprocess",
  "process_group",
  "disposable_repository",
  "worktree",
  "snapshot_artifact",
  "temporary_directory",
  "sandbox_root",
  "registry_copy",
  "evidence_directory",
  "diagnostic_artifact",
  "source_checkpoint_artifact",
  "review_artifact",
  "cleanup_artifact",
  "finalizer_proof_artifact",
  "final_evidence_index",
  "final_acceptance_report",
  "local_implementation_commit",
  "other_run_scoped_resource",
] as const;
export type AcceptanceResourceType = (typeof acceptanceResourceTypes)[number];
export type AcceptanceResourceTerminalState =
  | "deleted"
  | "stopped"
  | "deactivated"
  | "retained_with_approved_reason"
  | "never_created"
  | "spawn_failed"
  | "creation_failed"
  | "cleanup_failed_unsafe_identity"
  | "cleanup_failed";

export type AcceptanceResourceRecord = Readonly<{
  resourceId: string;
  type: AcceptanceResourceType;
  identity: Readonly<Record<string, string | number>>;
  creatingStep: string;
  createdAt: string;
  cleanupPolicy: "delete" | "stop" | "deactivate" | "retain_evidence_only";
  expectedTerminalState: Exclude<AcceptanceResourceTerminalState, "cleanup_failed">;
  dependsOn?: readonly string[];
  retentionPolicyIdentity?: string;
  lifecycleState?:
    | "planned"
    | "creation_reserved"
    | "spawned"
    | "identity_verified"
    | "readiness_pending"
    | "readiness_failed"
    | "created"
    | "verified"
    | "creation_failed"
    | "sealed";
  reservationIdentity?: string;
  reservedAt?: string;
  creationFailure?: string;
}>;
export type AcceptanceResourceOutcome = Readonly<{
  resourceId: string;
  acceptanceRunId: string;
  state: AcceptanceResourceTerminalState;
  completedAt: string;
  retainedReason?: string;
  retentionPolicyIdentity?: string;
  observation: Readonly<{
    resourceId: string;
    resourceType: AcceptanceResourceType;
    expectedTerminalState: Exclude<
      AcceptanceResourceTerminalState,
      "cleanup_failed" | "cleanup_failed_unsafe_identity"
    >;
    observedTerminalState: AcceptanceResourceTerminalState;
    cleanupAction: string;
    probeIdentity: string;
    cleanupStartedAt: string;
    cleanupCompletedAt: string;
    [key: string]: unknown;
  }>;
  cleanupEvidenceIdentity: string;
}>;

const validTime = (value: string) => Number.isFinite(Date.parse(value));
const identityHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export class AcceptanceResourceInventory {
  readonly schemaVersion = ACCEPTANCE_RESOURCE_INVENTORY_VERSION;
  private readonly resources = new Map<string, AcceptanceResourceRecord>();
  private readonly outcomes = new Map<string, AcceptanceResourceOutcome>();
  private sealed = false;
  private repositorySnapshotSha256: string | undefined;

  constructor(
    readonly acceptanceRunId: string,
    readonly candidateBindings: AcceptanceResourceCandidateBindings,
    readonly harnessIdentity: string,
    readonly createdAt: string,
  ) {
    if (!acceptanceRunId || !validTime(createdAt) || !/^[a-f0-9]{64}$/.test(harnessIdentity))
      throw new Error("Acceptance resource inventory header is invalid");
  }

  static fromJournalSnapshot(snapshot: Record<string, unknown>) {
    const { sha256, ...baseSnapshot } = snapshot;
    const candidateBindings = snapshot.candidateBindings as Record<string, string | null> | undefined;
    const resources = snapshot.resources as AcceptanceResourceRecord[] | undefined;
    const outcomes = snapshot.outcomes as AcceptanceResourceOutcome[] | undefined;
    if (
      snapshot.schemaVersion !== ACCEPTANCE_RESOURCE_INVENTORY_VERSION ||
      sha256 !== identityHash(baseSnapshot) ||
      !candidateBindings ||
      !Array.isArray(resources) ||
      !Array.isArray(outcomes) ||
      outcomes.length
    )
      throw new Error("Authoritative bootstrap resource inventory is invalid or already closed");
    const { repositorySnapshotSha256, ...preSnapshotBindings } = candidateBindings;
    const inventory = new AcceptanceResourceInventory(
      String(snapshot.acceptanceRunId),
      preSnapshotBindings as AcceptanceResourceCandidateBindings,
      String(snapshot.harnessIdentity),
      String(snapshot.createdAt),
    );
    const pending = new Map(resources.map((resource) => [resource.resourceId, resource]));
    while (pending.size) {
      let advanced = false;
      for (const [resourceId, resource] of Array.from(pending.entries())) {
        if ((resource.dependsOn ?? []).some((dependency: string) => pending.has(dependency))) continue;
        inventory.register(resource);
        pending.delete(resourceId);
        advanced = true;
      }
      if (!advanced) throw new Error("Authoritative bootstrap resource inventory contains cyclic dependencies");
    }
    if (repositorySnapshotSha256) inventory.bindRepositorySnapshot(repositorySnapshotSha256);
    return inventory;
  }

  bindRepositorySnapshot(repositorySnapshotSha256: string) {
    if (this.repositorySnapshotSha256 || !/^[a-f0-9]{64}$/.test(repositorySnapshotSha256))
      throw new Error("Acceptance resource repository snapshot binding is invalid or already set");
    this.repositorySnapshotSha256 = repositorySnapshotSha256;
  }

  register(record: AcceptanceResourceRecord) {
    if (this.sealed) throw new Error("Acceptance resource inventory is sealed");
    if (
      !record.resourceId ||
      !acceptanceResourceTypes.includes(record.type) ||
      !validTime(record.createdAt) ||
      !record.creatingStep ||
      !Object.keys(record.identity).length ||
      (record.cleanupPolicy === "retain_evidence_only" &&
        (!record.retentionPolicyIdentity || !/^[a-f0-9]{64}$/.test(record.retentionPolicyIdentity)))
    )
      throw new Error("Acceptance resource registration is invalid");
    if ((record.dependsOn ?? []).some((resourceId) => !this.resources.has(resourceId)))
      throw new Error(`Acceptance resource dependency is not registered: ${record.resourceId}`);
    if (this.resources.has(record.resourceId))
      throw new Error(`Acceptance resource already registered: ${record.resourceId}`);
    this.resources.set(
      record.resourceId,
      Object.freeze({
        ...record,
        lifecycleState: record.lifecycleState ?? "created",
        identity: Object.freeze({ ...record.identity }),
      }),
    );
  }

  reserve(record: AcceptanceResourceRecord) {
    if (
      record.lifecycleState !== "creation_reserved" ||
      !record.reservationIdentity ||
      !/^[a-f0-9]{64}$/.test(record.reservationIdentity) ||
      !record.reservedAt ||
      !validTime(record.reservedAt)
    )
      throw new Error(`Acceptance resource reservation is invalid: ${record.resourceId}`);
    this.register(record);
  }

  markCreated(resourceId: string, actualIdentity: Readonly<Record<string, string | number>>, createdAt: string) {
    if (this.sealed || !validTime(createdAt) || !Object.keys(actualIdentity).length)
      throw new Error(`Acceptance resource created transition is invalid: ${resourceId}`);
    const reserved = this.resources.get(resourceId);
    if (!reserved || reserved.lifecycleState !== "creation_reserved")
      throw new Error(`Acceptance resource was not reserved before creation: ${resourceId}`);
    this.resources.set(
      resourceId,
      Object.freeze({
        ...reserved,
        identity: Object.freeze({ ...reserved.identity, ...actualIdentity }),
        lifecycleState: "created" as const,
        createdAt,
      }),
    );
  }

  transitionCreation(
    resourceId: string,
    expectedState: AcceptanceResourceRecord["lifecycleState"],
    nextState: "spawned" | "identity_verified" | "readiness_pending" | "readiness_failed" | "created",
    actualIdentity: Readonly<Record<string, string | number>>,
    transitionedAt: string,
  ) {
    if (this.sealed || !validTime(transitionedAt) || !Object.keys(actualIdentity).length)
      throw new Error(`Acceptance resource creation transition is invalid: ${resourceId}`);
    const current = this.resources.get(resourceId);
    if (!current || current.lifecycleState !== expectedState)
      throw new Error(`Acceptance resource creation transition order is invalid: ${resourceId}`);
    this.resources.set(
      resourceId,
      Object.freeze({
        ...current,
        identity: Object.freeze({ ...current.identity, ...actualIdentity }),
        lifecycleState: nextState,
        createdAt: transitionedAt,
      }),
    );
  }

  bindCreatedIdentity(
    resourceId: string,
    actualIdentity: Readonly<Record<string, string | number>>,
    transitionedAt: string,
  ) {
    if (this.sealed || !validTime(transitionedAt) || !Object.keys(actualIdentity).length)
      throw new Error(`Acceptance resource identity binding is invalid: ${resourceId}`);
    const current = this.resources.get(resourceId);
    if (!current || current.lifecycleState !== "created")
      throw new Error(`Acceptance resource identity binding requires a created resource: ${resourceId}`);
    this.resources.set(
      resourceId,
      Object.freeze({ ...current, identity: Object.freeze({ ...current.identity, ...actualIdentity }) }),
    );
  }

  markVerified(resourceId: string, verifiedIdentity: Readonly<Record<string, string | number>>, verifiedAt: string) {
    if (this.sealed || !validTime(verifiedAt) || !Object.keys(verifiedIdentity).length)
      throw new Error(`Acceptance resource verification transition is invalid: ${resourceId}`);
    const current = this.resources.get(resourceId);
    if (!current || current.lifecycleState !== "created")
      throw new Error(`Acceptance resource verification requires a created resource: ${resourceId}`);
    this.resources.set(
      resourceId,
      Object.freeze({
        ...current,
        identity: Object.freeze({ ...current.identity, ...verifiedIdentity }),
        lifecycleState: "verified" as const,
        createdAt: verifiedAt,
      }),
    );
  }

  markCreationFailed(resourceId: string, failure: string) {
    if (this.sealed || !failure) throw new Error(`Acceptance resource failed transition is invalid: ${resourceId}`);
    const reserved = this.resources.get(resourceId);
    if (!reserved || reserved.lifecycleState !== "creation_reserved")
      throw new Error(`Acceptance resource failure lacked a reservation: ${resourceId}`);
    this.resources.set(
      resourceId,
      Object.freeze({
        ...reserved,
        lifecycleState: "creation_failed" as const,
        creationFailure: failure,
        expectedTerminalState: "creation_failed" as const,
      }),
    );
  }

  recordOutcome(outcome: AcceptanceResourceOutcome) {
    if (this.sealed) throw new Error("Acceptance resource inventory is sealed");
    const resource = this.resources.get(outcome.resourceId);
    if (!resource || outcome.acceptanceRunId !== this.acceptanceRunId || !validTime(outcome.completedAt))
      throw new Error(`Acceptance resource outcome binding is invalid: ${outcome.resourceId}`);
    if (this.outcomes.has(outcome.resourceId))
      throw new Error(`Acceptance resource outcome already recorded: ${outcome.resourceId}`);
    if (outcome.state === "retained_with_approved_reason" && !outcome.retainedReason)
      throw new Error(`Retained acceptance resource omitted approved reason: ${outcome.resourceId}`);
    if (
      outcome.state === "retained_with_approved_reason" &&
      outcome.retentionPolicyIdentity !== resource.retentionPolicyIdentity
    )
      throw new Error(`Retained acceptance resource policy identity changed: ${outcome.resourceId}`);
    if (
      outcome.observation.resourceId !== outcome.resourceId ||
      outcome.observation.resourceType !== resource.type ||
      outcome.observation.expectedTerminalState !== resource.expectedTerminalState ||
      outcome.observation.observedTerminalState !== outcome.state ||
      !outcome.observation.cleanupAction ||
      !outcome.observation.probeIdentity ||
      !validTime(outcome.observation.cleanupStartedAt) ||
      !validTime(outcome.observation.cleanupCompletedAt) ||
      outcome.observation.cleanupCompletedAt < outcome.observation.cleanupStartedAt
    )
      throw new Error(`Acceptance resource cleanup observation is invalid: ${outcome.resourceId}`);
    if (
      !/^[a-f0-9]{64}$/.test(outcome.cleanupEvidenceIdentity) ||
      outcome.cleanupEvidenceIdentity !== identityHash(outcome.observation)
    )
      throw new Error(`Acceptance resource cleanup evidence identity is invalid: ${outcome.resourceId}`);
    this.outcomes.set(
      outcome.resourceId,
      Object.freeze({ ...outcome, observation: Object.freeze({ ...outcome.observation }) }),
    );
  }

  snapshot() {
    if (!this.repositorySnapshotSha256) throw new Error("Acceptance resource repository snapshot is not bound");
    return this.journalSnapshot();
  }

  journalSnapshot() {
    const resources = Array.from(this.resources.values()).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    const outcomes = Array.from(this.outcomes.values()).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    const base = {
      schemaVersion: this.schemaVersion,
      acceptanceRunId: this.acceptanceRunId,
      candidateBindings: { ...this.candidateBindings, repositorySnapshotSha256: this.repositorySnapshotSha256 ?? null },
      harnessIdentity: this.harnessIdentity,
      createdAt: this.createdAt,
      resourceTypes: acceptanceResourceTypes,
      resources,
      outcomes,
    };
    return Object.freeze({ ...base, sha256: identityHash(base) });
  }

  hasResource(resourceId: string) {
    return this.resources.has(resourceId);
  }

  resourceRecords() {
    return Array.from(this.resources.values());
  }

  outcomeRecords() {
    return Array.from(this.outcomes.values());
  }

  sealForSuccess() {
    const snapshot = this.snapshot();
    if (!snapshot.resources.length) throw new Error("Acceptance resource inventory is empty");
    for (const resource of snapshot.resources) {
      const outcome = this.outcomes.get(resource.resourceId);
      if (!outcome) throw new Error(`Acceptance resource cleanup outcome is missing: ${resource.resourceId}`);
      if (outcome.state !== resource.expectedTerminalState)
        throw new Error(`Acceptance resource terminal state is invalid: ${resource.resourceId}`);
    }
    if (snapshot.outcomes.length !== snapshot.resources.length)
      throw new Error("Acceptance resource cleanup contains an unregistered outcome");
    this.sealed = true;
    return this.snapshot();
  }
}

export function adoptPersistedAcceptanceInventoryForTerminalCleanup(
  current: AcceptanceResourceInventory,
  persistedSnapshot: Record<string, unknown>,
) {
  const persisted = AcceptanceResourceInventory.fromJournalSnapshot(persistedSnapshot);
  const currentSnapshot = current.journalSnapshot();
  const latestSnapshot = persisted.journalSnapshot();
  const currentBindings = currentSnapshot.candidateBindings as AcceptanceCandidateBindings;
  const latestBindings = latestSnapshot.candidateBindings as AcceptanceCandidateBindings;
  const withoutRepositorySnapshot = (bindings: AcceptanceCandidateBindings) => {
    const rest = { ...bindings } as Record<string, unknown>;
    delete rest.repositorySnapshotSha256;
    return rest;
  };
  if (
    persisted.acceptanceRunId !== current.acceptanceRunId ||
    identityHash(withoutRepositorySnapshot(latestBindings)) !==
      identityHash(withoutRepositorySnapshot(currentBindings)) ||
    (latestBindings.repositorySnapshotSha256 &&
      currentBindings.repositorySnapshotSha256 &&
      latestBindings.repositorySnapshotSha256 !== currentBindings.repositorySnapshotSha256)
  )
    throw new Error("Terminal cleanup inventory authority binding changed");
  const mergeExactById = <T extends { resourceId: string }>(left: readonly T[], right: readonly T[]) => {
    const merged = new Map(left.map((record) => [record.resourceId, record]));
    for (const record of right) {
      const existing = merged.get(record.resourceId);
      if (existing && identityHash(existing) !== identityHash(record))
        throw new Error(`Terminal cleanup inventory resource conflict: ${record.resourceId}`);
      merged.set(record.resourceId, record);
    }
    return Array.from(merged.values()).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  };
  const resources = mergeExactById(
    currentSnapshot.resources as AcceptanceResourceRecord[],
    latestSnapshot.resources as AcceptanceResourceRecord[],
  );
  const outcomes = mergeExactById(
    currentSnapshot.outcomes as AcceptanceResourceOutcome[],
    latestSnapshot.outcomes as AcceptanceResourceOutcome[],
  );
  const mergedBase = {
    ...latestSnapshot,
    candidateBindings: {
      ...latestBindings,
      repositorySnapshotSha256:
        currentBindings.repositorySnapshotSha256 ?? latestBindings.repositorySnapshotSha256 ?? null,
    },
    resources,
    outcomes,
  } as Record<string, unknown>;
  delete mergedBase.sha256;
  return AcceptanceResourceInventory.fromJournalSnapshot({ ...mergedBase, sha256: identityHash(mergedBase) });
}

export function extendAcceptanceResourceInventorySnapshot(
  snapshot: Record<string, unknown>,
  records: readonly AcceptanceResourceRecord[],
) {
  const existingResources = snapshot.resources;
  const existingOutcomes = snapshot.outcomes;
  if (snapshot.schemaVersion !== ACCEPTANCE_RESOURCE_INVENTORY_VERSION || !Array.isArray(existingResources))
    throw new Error("Acceptance resource inventory snapshot is invalid");
  if (Array.isArray(existingOutcomes) && existingOutcomes.length)
    throw new Error("Closed acceptance resource inventory cannot be extended");
  const resources = [...(existingResources as AcceptanceResourceRecord[])];
  const ids = new Set(resources.map((resource) => resource.resourceId));
  for (const record of records) {
    if (ids.has(record.resourceId)) throw new Error(`Acceptance resource already registered: ${record.resourceId}`);
    if (
      !record.resourceId ||
      !acceptanceResourceTypes.includes(record.type) ||
      !validTime(record.createdAt) ||
      !record.creatingStep ||
      !Object.keys(record.identity).length ||
      record.cleanupPolicy !== "retain_evidence_only" ||
      record.expectedTerminalState !== "retained_with_approved_reason" ||
      !record.retentionPolicyIdentity ||
      !/^[a-f0-9]{64}$/.test(record.retentionPolicyIdentity) ||
      (record.dependsOn ?? []).some((resourceId) => !ids.has(resourceId))
    )
      throw new Error(`Finalization resource registration is invalid: ${record.resourceId}`);
    ids.add(record.resourceId);
    resources.push(Object.freeze({ ...record, identity: Object.freeze({ ...record.identity }) }));
  }
  resources.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  const base = { ...snapshot };
  delete base.sha256;
  const extended = { ...base, resources };
  return Object.freeze({ ...extended, sha256: identityHash(extended) });
}

export function assertExactAcceptanceResourceReconciliation(snapshot: Record<string, unknown>) {
  if (!Array.isArray(snapshot.resources) || !Array.isArray(snapshot.outcomes))
    throw new Error("Acceptance resource reconciliation sets are missing");
  const resourceIds = (snapshot.resources as Record<string, unknown>[]).map((resource) => String(resource.resourceId));
  const outcomeIds = (snapshot.outcomes as Record<string, unknown>[]).map((outcome) => String(outcome.resourceId));
  if (new Set(resourceIds).size !== resourceIds.length)
    throw new Error("Acceptance resource registration is duplicated");
  if (new Set(outcomeIds).size !== outcomeIds.length)
    throw new Error("Acceptance resource terminal evidence is duplicated");
  const missing = resourceIds.filter((resourceId: string) => !outcomeIds.includes(resourceId));
  const extra = outcomeIds.filter((resourceId: string) => !resourceIds.includes(resourceId));
  if (missing.length || extra.length)
    throw new Error(
      `Acceptance resource reconciliation mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`,
    );
  return true;
}

export function orderAcceptanceResourcesForCleanup(resources: readonly AcceptanceResourceRecord[]) {
  const byId = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: AcceptanceResourceRecord[] = [];
  const visit = (resource: AcceptanceResourceRecord) => {
    if (visiting.has(resource.resourceId)) throw new Error(`Cleanup dependency cycle: ${resource.resourceId}`);
    if (visited.has(resource.resourceId)) return;
    visiting.add(resource.resourceId);
    for (const dependencyId of resource.dependsOn ?? [])
      if (!byId.has(dependencyId)) throw new Error(`Cleanup dependency is unregistered: ${dependencyId}`);
    for (const dependent of resources) if ((dependent.dependsOn ?? []).includes(resource.resourceId)) visit(dependent);
    ordered.push(resource);
    visiting.delete(resource.resourceId);
    visited.add(resource.resourceId);
  };
  for (const resource of resources) visit(resource);
  return ordered;
}

export function assertAcceptanceCleanupAuthority(args: {
  acceptanceRunId: string;
  candidateBindings: Record<string, unknown>;
  inventory: Record<string, unknown>;
}) {
  const { sha256, ...base } = args.inventory;
  const inventoryBindings = args.inventory.candidateBindings as Record<string, unknown> | undefined;
  if (
    args.inventory.schemaVersion !== ACCEPTANCE_RESOURCE_INVENTORY_VERSION ||
    args.inventory.acceptanceRunId !== args.acceptanceRunId ||
    sha256 !== identityHash(base) ||
    !inventoryBindings ||
    identityHash(args.candidateBindings) !== identityHash(inventoryBindings) ||
    args.inventory.harnessIdentity !== args.candidateBindings.realAcceptanceHarnessSha256 ||
    args.inventory.harnessIdentity !== inventoryBindings.realAcceptanceHarnessSha256
  )
    throw new Error("Cleanup harness/candidate/inventory authority binding changed");
  return true;
}

export function appendSealedRetainedArtifact(
  snapshot: Record<string, unknown>,
  record: AcceptanceResourceRecord,
  artifact: { sha256: string; size: number; createdAt: string; sealedAt: string },
) {
  assertExactAcceptanceResourceReconciliation(snapshot);
  if (
    record.cleanupPolicy !== "retain_evidence_only" ||
    record.expectedTerminalState !== "retained_with_approved_reason" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0 ||
    !validTime(artifact.createdAt) ||
    !validTime(artifact.sealedAt) ||
    artifact.sealedAt < artifact.createdAt ||
    !record.retentionPolicyIdentity
  )
    throw new Error(`Sealed finalization artifact is invalid: ${record.resourceId}`);
  const plannedResources = Array.isArray(snapshot.plannedResources)
    ? ([...snapshot.plannedResources] as AcceptanceResourceRecord[])
    : [];
  const plannedIndex = plannedResources.findIndex((candidate) => candidate.resourceId === record.resourceId);
  if (plannedIndex < 0) throw new Error(`Finalization resource was not planned before creation: ${record.resourceId}`);
  plannedResources.splice(plannedIndex, 1);
  const resources = [...(snapshot.resources as AcceptanceResourceRecord[])];
  const outcomes = [...(snapshot.outcomes as AcceptanceResourceOutcome[])];
  if (resources.some((resource) => resource.resourceId === record.resourceId))
    throw new Error(`Finalization resource already exists: ${record.resourceId}`);
  const sealedRecord = {
    ...record,
    identity: {
      ...record.identity,
      artifactSha256: artifact.sha256,
      artifactSize: artifact.size,
      artifactCreatedAt: artifact.createdAt,
      artifactSealedAt: artifact.sealedAt,
    },
  };
  const observation = {
    resourceId: record.resourceId,
    resourceType: record.type,
    expectedTerminalState: record.expectedTerminalState,
    observedTerminalState: "retained_with_approved_reason" as const,
    cleanupAction: "seal_and_retain_finalization_artifact",
    probeIdentity: `probe:final_bytes_sha256:${artifact.sha256}`,
    cleanupStartedAt: artifact.sealedAt,
    cleanupCompletedAt: artifact.sealedAt,
    retainedPathExistsAtCleanup: true,
    retainedArtifactSha256: artifact.sha256,
    retainedArtifactSize: artifact.size,
    retainedArtifactCreatedAt: artifact.createdAt,
    retainedArtifactSealedAt: artifact.sealedAt,
  };
  resources.push(sealedRecord);
  outcomes.push({
    resourceId: record.resourceId,
    acceptanceRunId: String(snapshot.acceptanceRunId),
    state: "retained_with_approved_reason",
    completedAt: artifact.sealedAt,
    retainedReason: "bounded disposable acceptance evidence retained for local review",
    retentionPolicyIdentity: record.retentionPolicyIdentity,
    observation,
    cleanupEvidenceIdentity: identityHash(observation),
  });
  resources.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  outcomes.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  const base: Record<string, unknown> = { ...snapshot, resources, outcomes, plannedResources };
  delete base.sha256;
  return Object.freeze({ ...base, sha256: identityHash(base) });
}

export function planAcceptanceFinalizationResources(
  snapshot: Record<string, unknown>,
  records: readonly AcceptanceResourceRecord[],
) {
  const resources = (snapshot.resources as AcceptanceResourceRecord[] | undefined) ?? [];
  const existingPlans = (snapshot.plannedResources as AcceptanceResourceRecord[] | undefined) ?? [];
  const ids = new Set([...resources, ...existingPlans].map((resource) => resource.resourceId));
  const plannedResources = [...existingPlans];
  for (const record of records) {
    if (
      ids.has(record.resourceId) ||
      record.cleanupPolicy !== "retain_evidence_only" ||
      record.expectedTerminalState !== "retained_with_approved_reason" ||
      !record.retentionPolicyIdentity
    )
      throw new Error(`Finalization resource plan is invalid: ${record.resourceId}`);
    ids.add(record.resourceId);
    plannedResources.push(record);
  }
  plannedResources.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  const base: Record<string, unknown> = { ...snapshot, plannedResources };
  delete base.sha256;
  return Object.freeze({ ...base, sha256: identityHash(base) });
}
