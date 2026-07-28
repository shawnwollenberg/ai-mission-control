import { createHash } from "node:crypto";
import {
  NAMED_CANARY_ID,
  REPLACEMENT_BOOTSTRAP_PROTOCOL,
  SOURCE_SHA256,
  SOURCE_VERSION,
  TARGET_SHA256,
  TARGET_VERSION,
  authorizationChecksum,
  validateReplacementAuthorization,
  verifyReplacementRelease,
  type ReplacementAuthorization,
  type ReplacementState,
} from "../integrations/mission-agent/replacement-bootstrap";
import { canonicalJson } from "../integrations/mission-agent/release-authority";

export const REPLACEMENT_OPERATOR_VERSION = "replacement-bootstrap-operator-v1" as const;
export const REQUIRED_PRODUCTION_SCHEMA = "0028" as const;
export const TARGET_PRODUCTION_SCHEMA = "0029" as const;
export const MIGRATION_0029_SHA256 = "c58f48d1455489af81eef8efd3143fd54595f278d8d675e8aa08d3e9a2a09caa";

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type OperatorMode = "dry-run" | "disposable" | "production";

export type AgentSnapshot = {
  agentId: string;
  hostIdentity: string;
  workspaceId: string;
  repositoryId: string;
  repositoryFingerprint: string;
  version: string;
  artifactSha256: string;
  serviceDefinitionSha256: string;
  healthy: boolean;
  connected: boolean;
  activeMission: boolean;
  activeLease: boolean;
  duplicateAgent: boolean;
  heartbeatSequence: number;
  runtimeVersion: string;
  runtimeExecutable: string;
  capabilityCompatible: boolean;
  rollbackAvailable: boolean;
};

export type HostOperation =
  | "inspect"
  | "inventory"
  | "verify_rollback"
  | "stage_node"
  | "stage_release"
  | "stage_service"
  | "drain"
  | "undrain"
  | "stop"
  | "atomic_switch"
  | "start"
  | "verify_identity"
  | "verify_heartbeats"
  | "verify_capabilities"
  | "restore_artifact"
  | "restore_service"
  | "restart_rollback"
  | "observe";

export type OperationReceipt = {
  operationId: string;
  operation: HostOperation;
  agentId: typeof NAMED_CANARY_ID;
  authorizationChecksum: string;
  status: "succeeded";
  evidenceChecksum: string;
  completedAt: string;
  details: {
    artifactSha256: string;
    serviceDefinitionSha256: string;
    nodeExecutableSha256: string | null;
    owner: string;
    mode: string;
    identityPreserved: boolean;
    heartbeatSequence: number;
  };
};

export type BackupReceipt = {
  backupId: string;
  sha256: string;
  sizeBytes: number;
  encrypted: true;
  mode: "0600";
  verified: true;
  owner: string;
  storageIdentity: string;
  encryptionIdentity: string;
  retention: string;
  restoreValidation: string;
  preMigrationSchema: "0028";
  completedAt: string;
};

export type SmokeReceipt = {
  missionId: string;
  executionId: string;
  finalState: "completed";
  readOnly: true;
  projectionConsistent: true;
  duplicateExecution: false;
  unauthorizedSideEffect: false;
  evidenceChecksum: string;
  repositoryId: string;
  repositoryFingerprint: string;
  assignedAt: string;
  startedAt: string;
  completedAt: string;
  heartbeatSequence: number;
  policyDecision: "allowed-read-only";
  approvalDecision: "not-required-read-only";
  liveProjectionHash: string;
  replayProjectionHash: string;
};

export type PreflightReport = {
  operatorVersion: typeof REPLACEMENT_OPERATOR_VERSION;
  mode: OperatorMode;
  mutationPerformed: false;
  authorizationId: string;
  agentId: typeof NAMED_CANARY_ID;
  authorizationChecksum: string;
  databaseTime: string;
  schemaVersion: typeof REQUIRED_PRODUCTION_SCHEMA;
  checks: Record<string, true>;
  checksum: string;
};

export type ReplacementEvidenceBundle = {
  evidenceVersion: "1";
  operatorVersion: typeof REPLACEMENT_OPERATOR_VERSION;
  mode: OperatorMode;
  authorizationId: string;
  authorizationChecksum: string;
  disposition: "completed" | "rolled_back";
  preflight: PreflightReport;
  backup: BackupReceipt;
  migration: { from: "0028"; to: "0029"; checksum: string; health: 200; readiness: 200 };
  transitions: Array<{ from: ReplacementState; to: ReplacementState; evidenceChecksum: string }>;
  hostReceipts: OperationReceipt[];
  smoke: SmokeReceipt | null;
  finalSnapshot: AgentSnapshot;
  otherAgentsModified: false;
  productionTrafficChanged: false;
  broaderRolloutStarted: false;
  checksum: string;
};

export interface ReplacementOperatorStore {
  databaseTime(): Promise<Date>;
  schemaVersion(): Promise<string>;
  loadAuthorization(authorizationId: string): Promise<ReplacementAuthorization | null>;
  approvalStatus(input: {
    approvalId: string;
    authorizationChecksum: string;
    databaseTime: Date;
  }): Promise<{ granted: boolean; approvedBy: string; expiresAt: Date }>;
  preMigrationAuthorizationCount(agentId: string): Promise<number>;
  executionState(authorizationId: string): Promise<{
    state: ReplacementState;
    executionCount: number;
    revoked: boolean;
    concurrentExecutions: number;
  }>;
  transition(input: {
    authorizationId: string;
    expected: ReplacementState;
    next: ReplacementState;
    actor: string;
    evidenceChecksum: string;
  }): Promise<void>;
  createBackup(authorizationChecksum: string): Promise<BackupReceipt>;
  applyMigration0029(expectedChecksum: typeof MIGRATION_0029_SHA256): Promise<void>;
  initializeAfterMigration(authorization: ReplacementAuthorization): Promise<void>;
  applicationHealth(): Promise<{ health: 200; readiness: 200 }>;
}

export interface ReplacementHost {
  inspect(authorization: ReplacementAuthorization): Promise<AgentSnapshot>;
  perform(operation: HostOperation, authorization: ReplacementAuthorization): Promise<OperationReceipt>;
  readJournal(authorization: ReplacementAuthorization): Promise<{
    authorizationChecksum: string;
    lastCompletedOperation: HostOperation | null;
    nextSafeOperation: HostOperation;
    rollbackAvailable: boolean;
    checksumValid: boolean;
  } | null>;
}

export interface ReplacementReleaseAssets {
  signedManifestText(): Promise<string>;
  artifact(): Promise<Uint8Array>;
  trustActive(signingKeyId: string): Promise<boolean>;
}

export interface ReplacementSmokeMission {
  run(authorization: ReplacementAuthorization): Promise<SmokeReceipt>;
}

export type ReplacementOperatorDependencies = {
  store: ReplacementOperatorStore;
  host: ReplacementHost;
  release: ReplacementReleaseAssets;
  smoke: ReplacementSmokeMission;
};

function assertSnapshot(authorization: ReplacementAuthorization, snapshot: AgentSnapshot): void {
  if (
    snapshot.agentId !== authorization.agentId ||
    snapshot.hostIdentity !== authorization.hostIdentity ||
    snapshot.workspaceId !== authorization.workspaceId ||
    snapshot.repositoryId !== authorization.repositoryId ||
    snapshot.repositoryFingerprint !== authorization.repositoryFingerprint ||
    snapshot.version !== SOURCE_VERSION ||
    snapshot.artifactSha256 !== SOURCE_SHA256 ||
    snapshot.serviceDefinitionSha256 !== authorization.serviceReplacement.currentDefinitionSha256 ||
    !snapshot.healthy ||
    !snapshot.connected ||
    snapshot.activeMission ||
    snapshot.activeLease ||
    snapshot.duplicateAgent ||
    !snapshot.rollbackAvailable
  )
    throw new Error("Named-canary snapshot does not satisfy replacement preflight.");
}

export async function replacementPreflight(input: {
  mode: OperatorMode;
  authorizationId: string;
  assertedAgentId: string;
  actor: string;
  dependencies: ReplacementOperatorDependencies;
}): Promise<{ authorization: ReplacementAuthorization; report: PreflightReport; snapshot: AgentSnapshot }> {
  if (input.assertedAgentId !== NAMED_CANARY_ID) throw new Error("Named-agent assertion mismatch.");
  const databaseTime = await input.dependencies.store.databaseTime();
  const authorization = await input.dependencies.store.loadAuthorization(input.authorizationId);
  if (!authorization) throw new Error("Replacement authorization not found.");
  validateReplacementAuthorization(authorization, { now: databaseTime });
  if (
    authorization.authorizationId !== input.authorizationId ||
    authorization.protocolVersion !== REPLACEMENT_BOOTSTRAP_PROTOCOL ||
    authorization.operatorIdentity !== input.actor
  )
    throw new Error("Replacement authorization identity or operator mismatch.");
  const fingerprint = authorizationChecksum(authorization);
  const approval = await input.dependencies.store.approvalStatus({
    approvalId: authorization.approvalId,
    authorizationChecksum: fingerprint,
    databaseTime,
  });
  if (!approval.granted || approval.approvedBy !== authorization.approvedBy || approval.expiresAt <= databaseTime)
    throw new Error("Governed approval is not active or does not bind the authorization fingerprint.");
  if ((await input.dependencies.store.preMigrationAuthorizationCount(authorization.agentId)) !== 1)
    throw new Error("Expected exactly one governed pre-migration authorization for the named agent.");
  if ((await input.dependencies.store.schemaVersion()) !== REQUIRED_PRODUCTION_SCHEMA)
    throw new Error("Replacement preflight requires production schema 0028.");
  const snapshot = await input.dependencies.host.inspect(authorization);
  assertSnapshot(authorization, snapshot);
  const signedManifestText = await input.dependencies.release.signedManifestText();
  const artifact = await input.dependencies.release.artifact();
  verifyReplacementRelease({ signedManifestText, artifact, now: databaseTime });
  if (!(await input.dependencies.release.trustActive(authorization.targetSigningKeyId)))
    throw new Error("Production release trust is not active.");
  const journal = await input.dependencies.host.readJournal(authorization);
  if (journal && (!journal.checksumValid || journal.authorizationChecksum !== fingerprint))
    throw new Error("Host journal is corrupt or belongs to another authorization.");
  const checks = {
    authorizationSchema: true,
    protocol: true,
    approvalFingerprint: true,
    databaseExpiry: true,
    preMigrationAuthorizationUnique: true,
    namedAgent: true,
    currentRelease: true,
    hostIdentity: true,
    repositoryIdentity: true,
    agentHealth: true,
    noActiveMissionOrLease: true,
    schema0028: true,
    exactTargetRelease: true,
    productionTrust: true,
    nodeRuntimeBinding: true,
    serviceDefinitionBinding: true,
    rollbackAvailable: true,
    operatorRole: true,
    noConcurrentExecution: true,
  } as const;
  const unsigned = {
    operatorVersion: REPLACEMENT_OPERATOR_VERSION,
    mode: input.mode,
    mutationPerformed: false as const,
    authorizationId: authorization.authorizationId,
    agentId: NAMED_CANARY_ID,
    authorizationChecksum: fingerprint,
    databaseTime: databaseTime.toISOString(),
    schemaVersion: REQUIRED_PRODUCTION_SCHEMA,
    checks,
  };
  return { authorization, snapshot, report: { ...unsigned, checksum: sha256(canonicalJson(unsigned)) } };
}

const forward: Array<[ReplacementState, ReplacementState]> = [
  ["approved", "draining"],
  ["draining", "verified"],
  ["verified", "staged"],
  ["staged", "replacing"],
  ["replacing", "starting"],
  ["starting", "connected"],
  ["connected", "accepted"],
  ["accepted", "completed"],
];

export async function executeReplacementBootstrap(input: {
  mode: Exclude<OperatorMode, "dry-run">;
  authorizationId: string;
  assertedAgentId: string;
  actor: string;
  acknowledge: typeof REPLACEMENT_BOOTSTRAP_PROTOCOL;
  dependencies: ReplacementOperatorDependencies;
}): Promise<ReplacementEvidenceBundle> {
  if (input.acknowledge !== REPLACEMENT_BOOTSTRAP_PROTOCOL)
    throw new Error("Explicit operator acknowledgment required.");
  const { authorization, report } = await replacementPreflight(input);
  const receipts: OperationReceipt[] = [];
  const transitions: ReplacementEvidenceBundle["transitions"] = [];
  let backup: BackupReceipt | null = null;
  let migrationCompleted = false;
  let executionStarted = false;
  let drained = false;
  let drainAttempted = false;

  const operate = async (operation: HostOperation) => {
    const receipt = await input.dependencies.host.perform(operation, authorization);
    if (
      receipt.operation !== operation ||
      receipt.agentId !== NAMED_CANARY_ID ||
      receipt.authorizationChecksum !== authorizationChecksum(authorization) ||
      !SHA256.test(receipt.evidenceChecksum)
    )
      throw new Error(`Host operation receipt mismatch for ${operation}.`);
    receipts.push(receipt);
  };
  const move = async (from: ReplacementState, to: ReplacementState) => {
    const evidenceChecksum = sha256(canonicalJson({ from, to, receipt: receipts.at(-1) ?? null }));
    await input.dependencies.store.transition({
      authorizationId: authorization.authorizationId,
      expected: from,
      next: to,
      actor: authorization.operatorIdentity,
      evidenceChecksum,
    });
    transitions.push({ from, to, evidenceChecksum });
  };
  const rollback = async (cause: unknown): Promise<ReplacementEvidenceBundle> => {
    const current = transitions.at(-1)?.to ?? "approved";
    if (current !== "failed") await move(current, "failed");
    await move("failed", "rolling_back");
    for (const operation of ["restore_artifact", "restore_service", "restart_rollback"] as const)
      await operate(operation);
    const restored = await input.dependencies.host.inspect(authorization);
    if (
      restored.version !== SOURCE_VERSION ||
      restored.artifactSha256 !== SOURCE_SHA256 ||
      restored.agentId !== NAMED_CANARY_ID ||
      !restored.connected ||
      !restored.healthy
    )
      throw new AggregateError([cause], "Replacement and rollback verification both failed.");
    await move("rolling_back", "rolled_back");
    return finish("rolled_back", restored, null);
  };
  const finish = (
    disposition: "completed" | "rolled_back",
    finalSnapshot: AgentSnapshot,
    smoke: SmokeReceipt | null,
  ): ReplacementEvidenceBundle => {
    if (!backup || !migrationCompleted) throw new Error("Replacement evidence is incomplete.");
    const unsigned = {
      evidenceVersion: "1" as const,
      operatorVersion: REPLACEMENT_OPERATOR_VERSION,
      mode: input.mode,
      authorizationId: authorization.authorizationId,
      authorizationChecksum: authorizationChecksum(authorization),
      disposition,
      preflight: report,
      backup,
      migration: {
        from: "0028" as const,
        to: "0029" as const,
        checksum: MIGRATION_0029_SHA256,
        health: 200 as const,
        readiness: 200 as const,
      },
      transitions,
      hostReceipts: receipts,
      smoke,
      finalSnapshot,
      otherAgentsModified: false as const,
      productionTrafficChanged: false as const,
      broaderRolloutStarted: false as const,
    };
    return { ...unsigned, checksum: sha256(canonicalJson(unsigned)) };
  };

  try {
    backup = await input.dependencies.store.createBackup(authorizationChecksum(authorization));
    if (!backup.verified || !SHA256.test(backup.sha256)) throw new Error("Backup verification failed.");
    await input.dependencies.store.applyMigration0029(MIGRATION_0029_SHA256);
    migrationCompleted = true;
    if ((await input.dependencies.store.schemaVersion()) !== TARGET_PRODUCTION_SCHEMA)
      throw new Error("Migration did not produce exact schema 0029.");
    const health = await input.dependencies.store.applicationHealth();
    if (health.health !== 200 || health.readiness !== 200) throw new Error("Application degraded after migration.");
    await input.dependencies.store.initializeAfterMigration(authorization);
    const initialized = await input.dependencies.store.executionState(authorization.authorizationId);
    if (
      initialized.state !== "approved" ||
      initialized.executionCount !== 0 ||
      initialized.revoked ||
      initialized.concurrentExecutions !== 1
    )
      throw new Error("Post-migration bootstrap initialization did not produce one approved unconsumed execution.");

    await operate("inventory");
    await operate("verify_rollback");
    drainAttempted = true;
    await operate("drain");
    drained = true;
    await move("approved", "draining");
    await operate("stage_node");
    await operate("stage_release");
    await move("draining", "verified");
    await operate("stage_service");
    await move("verified", "staged");
    await move("staged", "replacing");
    executionStarted = true;
    await operate("stop");
    await operate("atomic_switch");
    await operate("start");
    await move("replacing", "starting");
    for (const operation of ["verify_identity", "verify_heartbeats", "verify_capabilities"] as const)
      await operate(operation);
    const connected = await input.dependencies.host.inspect(authorization);
    if (
      connected.version !== TARGET_VERSION ||
      connected.artifactSha256 !== TARGET_SHA256 ||
      connected.runtimeVersion !== authorization.nodeRuntime.version ||
      connected.runtimeExecutable !== authorization.nodeRuntime.executablePath ||
      !connected.capabilityCompatible ||
      !connected.connected ||
      !connected.healthy ||
      connected.duplicateAgent
    )
      throw new Error("Post-start identity, runtime, heartbeat, or capability acceptance failed.");
    await move("starting", "connected");
    const smoke = await input.dependencies.smoke.run(authorization);
    if (
      smoke.finalState !== "completed" ||
      !smoke.readOnly ||
      !smoke.projectionConsistent ||
      smoke.duplicateExecution ||
      smoke.unauthorizedSideEffect
    )
      throw new Error("Governed replacement smoke mission failed.");
    await move("connected", "accepted");
    await operate("observe");
    const finalSnapshot = await input.dependencies.host.inspect(authorization);
    await move("accepted", "completed");
    return finish("completed", finalSnapshot, smoke);
  } catch (error) {
    if (!executionStarted) {
      if (drained || drainAttempted) await operate("undrain");
      throw error;
    }
    return rollback(error);
  }
}

export const replacementForwardTransitions = forward;

const journalOperationOrder: HostOperation[] = [
  "inventory",
  "verify_rollback",
  "drain",
  "stage_node",
  "stage_release",
  "stage_service",
  "stop",
  "atomic_switch",
  "start",
  "verify_identity",
  "verify_heartbeats",
  "verify_capabilities",
  "observe",
];

export function reconcileReplacementRecovery(input: {
  databaseState: ReplacementState;
  journal: {
    authorizationChecksum: string;
    lastCompletedOperation: HostOperation | null;
    nextSafeOperation: HostOperation;
    rollbackAvailable: boolean;
    checksumValid: boolean;
  };
  expectedAuthorizationChecksum: string;
}): {
  action: "resume" | "transition" | "rollback" | "halt";
  operation?: HostOperation;
  transition?: { expected: ReplacementState; next: ReplacementState };
  reason: string;
} {
  if (
    !input.journal.checksumValid ||
    input.journal.authorizationChecksum !== input.expectedAuthorizationChecksum ||
    !input.journal.rollbackAvailable
  )
    return { action: "halt", reason: "Journal integrity, authorization binding, or rollback availability failed." };
  if (input.databaseState === "failed" || input.databaseState === "rolling_back")
    return { action: "rollback", reason: "A durable rollback state must continue restoration to terminal." };
  const lastIndex = input.journal.lastCompletedOperation
    ? journalOperationOrder.indexOf(input.journal.lastCompletedOperation)
    : -1;
  const nextIndex = journalOperationOrder.indexOf(input.journal.nextSafeOperation);
  if (nextIndex !== lastIndex + 1) return { action: "halt", reason: "Journal operation sequence is noncanonical." };
  if (["completed", "rolled_back", "revoked", "expired"].includes(input.databaseState))
    return { action: "halt", reason: "Database execution is terminal." };
  const transitionOnlyBoundaries: Array<{
    state: ReplacementState;
    last: HostOperation;
    nextOperation: HostOperation;
    nextState: ReplacementState;
  }> = [
    { state: "approved", last: "drain", nextOperation: "stage_node", nextState: "draining" },
    { state: "draining", last: "stage_release", nextOperation: "stage_service", nextState: "verified" },
    { state: "verified", last: "stage_service", nextOperation: "stop", nextState: "staged" },
    { state: "staged", last: "stage_service", nextOperation: "stop", nextState: "replacing" },
  ];
  const transitionOnly = transitionOnlyBoundaries.find(
    (boundary) =>
      boundary.state === input.databaseState &&
      boundary.last === input.journal.lastCompletedOperation &&
      boundary.nextOperation === input.journal.nextSafeOperation,
  );
  if (transitionOnly)
    return {
      action: "transition",
      transition: { expected: transitionOnly.state, next: transitionOnly.nextState },
      reason: "Host receipt is durable and the database transition is one canonical step behind.",
    };
  const resumableBoundaries: Partial<Record<ReplacementState, Array<[HostOperation | null, HostOperation]>>> = {
    approved: [
      [null, "inventory"],
      ["inventory", "verify_rollback"],
      ["verify_rollback", "drain"],
    ],
    draining: [
      ["drain", "stage_node"],
      ["stage_node", "stage_release"],
    ],
    verified: [["stage_release", "stage_service"]],
    replacing: [["stage_service", "stop"]],
  };
  const boundaryAllowed = resumableBoundaries[input.databaseState]?.some(
    ([last, next]) => last === input.journal.lastCompletedOperation && next === input.journal.nextSafeOperation,
  );
  if (lastIndex >= journalOperationOrder.indexOf("atomic_switch"))
    return { action: "rollback", reason: "A non-idempotent host mutation began; deterministic rollback is required." };
  if (
    input.databaseState === "replacing" &&
    input.journal.lastCompletedOperation === "stop" &&
    input.journal.nextSafeOperation === "atomic_switch"
  )
    return {
      action: "rollback",
      reason: "The consumed execution stopped the agent; rollback avoids replay ambiguity.",
    };
  if (input.databaseState === "starting")
    return { action: "rollback", reason: "Database state is ahead of a safely resumable host journal." };
  if (!boundaryAllowed)
    return { action: "halt", reason: "Database state and host journal are not at a canonical resumable boundary." };
  return {
    action: "resume",
    operation: input.journal.nextSafeOperation,
    reason: "Next operation is idempotent and ordered.",
  };
}

export async function recoverReplacementBootstrap(input: {
  authorizationId: string;
  assertedAgentId: string;
  actor: string;
  dependencies: ReplacementOperatorDependencies;
}): Promise<{ disposition: "halted" | "resumed" | "rolled_back"; reason: string; receipts: OperationReceipt[] }> {
  if (input.assertedAgentId !== NAMED_CANARY_ID) throw new Error("Named-agent assertion mismatch.");
  if ((await input.dependencies.store.schemaVersion()) !== TARGET_PRODUCTION_SCHEMA)
    return { disposition: "halted", reason: "No post-0029 execution exists to recover.", receipts: [] };
  const authorization = await input.dependencies.store.loadAuthorization(input.authorizationId);
  if (!authorization) throw new Error("Recovery authorization is unavailable.");
  validateReplacementAuthorization(authorization, { now: new Date(authorization.approvedAt) });
  if (authorization.operatorIdentity !== input.actor) throw new Error("Recovery operator identity mismatch.");
  const state = await input.dependencies.store.executionState(input.authorizationId);
  const journal = await input.dependencies.host.readJournal(authorization);
  if (!journal) return { disposition: "halted", reason: "No host journal exists.", receipts: [] };
  const decision = reconcileReplacementRecovery({
    databaseState: state.state,
    journal,
    expectedAuthorizationChecksum: authorizationChecksum(authorization),
  });
  if (decision.action === "transition" && decision.transition) {
    if (decision.transition.next === "replacing")
      validateReplacementAuthorization(authorization, { now: await input.dependencies.store.databaseTime() });
    await input.dependencies.store.transition({
      authorizationId: authorization.authorizationId,
      expected: decision.transition.expected,
      next: decision.transition.next,
      actor: authorization.operatorIdentity,
      evidenceChecksum: sha256(canonicalJson({ recovery: "transition-only", journal, decision })),
    });
    return { disposition: "resumed", reason: decision.reason, receipts: [] };
  }
  if (decision.action === "resume" && decision.operation) {
    const receipt = await input.dependencies.host.perform(decision.operation, authorization);
    if (
      receipt.operation !== decision.operation ||
      receipt.agentId !== NAMED_CANARY_ID ||
      receipt.authorizationChecksum !== authorizationChecksum(authorization) ||
      !SHA256.test(receipt.evidenceChecksum)
    )
      throw new Error("Recovery operation receipt is not bound to the authorization and requested operation.");
    if (decision.operation === "stage_release") {
      await input.dependencies.store.transition({
        authorizationId: authorization.authorizationId,
        expected: "draining",
        next: "verified",
        actor: authorization.operatorIdentity,
        evidenceChecksum: receipt.evidenceChecksum,
      });
    }
    if (decision.operation === "stage_service") {
      await input.dependencies.store.transition({
        authorizationId: authorization.authorizationId,
        expected: "verified",
        next: "staged",
        actor: authorization.operatorIdentity,
        evidenceChecksum: receipt.evidenceChecksum,
      });
    }
    return { disposition: "resumed", reason: decision.reason, receipts: [receipt] };
  }
  if (decision.action !== "rollback") return { disposition: "halted", reason: decision.reason, receipts: [] };
  const receipts: OperationReceipt[] = [];
  if (!["failed", "rolling_back"].includes(state.state)) {
    await input.dependencies.store.transition({
      authorizationId: authorization.authorizationId,
      expected: state.state,
      next: "failed",
      actor: authorization.operatorIdentity,
      evidenceChecksum: sha256(canonicalJson({ recovery: "failed", journal })),
    });
  }
  if (state.state !== "rolling_back") {
    await input.dependencies.store.transition({
      authorizationId: authorization.authorizationId,
      expected: "failed",
      next: "rolling_back",
      actor: authorization.operatorIdentity,
      evidenceChecksum: sha256(canonicalJson({ recovery: "rolling_back", journal })),
    });
  }
  for (const operation of ["restore_artifact", "restore_service", "restart_rollback"] as const) {
    const receipt = await input.dependencies.host.perform(operation, authorization);
    if (
      receipt.operation !== operation ||
      receipt.agentId !== NAMED_CANARY_ID ||
      receipt.authorizationChecksum !== authorizationChecksum(authorization) ||
      !SHA256.test(receipt.evidenceChecksum)
    )
      throw new Error(`Recovery rollback receipt mismatch for ${operation}.`);
    receipts.push(receipt);
  }
  const restored = await input.dependencies.host.inspect(authorization);
  if (
    restored.version !== SOURCE_VERSION ||
    restored.artifactSha256 !== SOURCE_SHA256 ||
    restored.agentId !== NAMED_CANARY_ID ||
    !restored.healthy ||
    !restored.connected
  )
    throw new Error("Interrupted replacement rollback did not restore the exact source agent.");
  await input.dependencies.store.transition({
    authorizationId: authorization.authorizationId,
    expected: "rolling_back",
    next: "rolled_back",
    actor: authorization.operatorIdentity,
    evidenceChecksum: sha256(canonicalJson({ recovery: "rolled_back", receipts })),
  });
  return { disposition: "rolled_back", reason: decision.reason, receipts };
}
