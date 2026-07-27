import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  NAMED_CANARY_ID,
  NODE_EXECUTABLE,
  NODE_VERSION,
  SOURCE_SHA256,
  SOURCE_VERSION,
  TARGET_SHA256,
  TARGET_VERSION,
  authorizationChecksum,
  type ReplacementAuthorization,
  type ReplacementState,
} from "../integrations/mission-agent/replacement-bootstrap";
import {
  MIGRATION_0029_SHA256,
  type AgentSnapshot,
  type HostOperation,
  type OperationReceipt,
  type ReplacementOperatorDependencies,
} from "./replacement-bootstrap-operator";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type DisposableOptions = {
  failAt?: HostOperation | "smoke";
  interruptAfter?: HostOperation;
  initialSchema?: "0028" | "0029";
  initialState?: ReplacementState;
  journal?: {
    lastCompletedOperation: HostOperation | null;
    nextSafeOperation: HostOperation;
    checksumValid?: boolean;
  };
  initialTargetInstalled?: boolean;
  failAfterDrainEffect?: boolean;
};

export async function createDisposableReplacementDependencies(
  authorization: ReplacementAuthorization,
  options: DisposableOptions = {},
): Promise<
  ReplacementOperatorDependencies & { inspectState(): { operations: HostOperation[]; state: ReplacementState } }
> {
  let schema = options.initialSchema ?? "0028";
  let state: ReplacementState = options.initialState ?? "approved";
  let executionCount = 0;
  let version = SOURCE_VERSION as string;
  let artifactSha256 = SOURCE_SHA256 as string;
  let serviceDefinitionSha256 = authorization.serviceReplacement.currentDefinitionSha256 as string;
  let runtimeVersion = "24.10.0";
  let runtimeExecutable = "/usr/local/Cellar/node/24.10.0/bin/node";
  let stopped = false;
  let drained = false;
  let capabilityCompatible = false;
  let heartbeatSequence = 100;
  let terminal = false;
  const operations: HostOperation[] = [];
  let journalLast = options.journal?.lastCompletedOperation ?? null;
  let journalNext = options.journal?.nextSafeOperation ?? "inventory";
  const databaseNow = new Date("2026-07-28T00:00:00.000Z");
  if (options.initialTargetInstalled) {
    version = TARGET_VERSION;
    artifactSha256 = TARGET_SHA256;
    serviceDefinitionSha256 = authorization.serviceReplacement.targetDefinitionSha256;
    stopped = true;
  }

  const snapshot = (): AgentSnapshot => ({
    agentId: NAMED_CANARY_ID,
    hostIdentity: authorization.hostIdentity,
    workspaceId: authorization.workspaceId,
    repositoryId: authorization.repositoryId,
    repositoryFingerprint: authorization.repositoryFingerprint,
    version,
    artifactSha256,
    serviceDefinitionSha256,
    healthy: !stopped,
    connected: !stopped,
    activeMission: false,
    activeLease: false,
    duplicateAgent: false,
    heartbeatSequence,
    runtimeVersion,
    runtimeExecutable,
    capabilityCompatible,
    rollbackAvailable: true,
  });

  const perform = async (operation: HostOperation): Promise<OperationReceipt> => {
    if (terminal) throw new Error("Disposable host execution is terminal.");
    if (options.failAt === operation) throw new Error(`Injected disposable failure at ${operation}.`);
    if (options.interruptAfter === operation && operations.includes(operation))
      throw new Error(`Repeated non-idempotent operation rejected: ${operation}.`);
    operations.push(operation);
    if (options.journal && operation === journalNext) {
      const order: HostOperation[] = [
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
      journalLast = operation;
      journalNext = order[order.indexOf(operation) + 1] ?? operation;
    }
    if (operation === "drain") drained = true;
    if (operation === "drain" && options.failAfterDrainEffect)
      throw new Error("Injected uncertain-effect drain failure.");
    if (operation === "undrain") drained = false;
    if (operation === "stop") stopped = true;
    if (operation === "atomic_switch") {
      if (!stopped || !drained) throw new Error("Atomic switch requires drained and stopped agent.");
      version = TARGET_VERSION;
      artifactSha256 = TARGET_SHA256;
      serviceDefinitionSha256 = authorization.serviceReplacement.targetDefinitionSha256;
    }
    if (operation === "start") {
      if (operations.filter((item) => item === "start").length > 1) throw new Error("Repeated start rejected.");
      stopped = false;
      runtimeVersion = NODE_VERSION;
      runtimeExecutable = NODE_EXECUTABLE;
      heartbeatSequence += 1;
    }
    if (operation === "verify_heartbeats") heartbeatSequence += 3;
    if (operation === "verify_capabilities") capabilityCompatible = true;
    if (operation === "restore_artifact") {
      version = SOURCE_VERSION;
      artifactSha256 = SOURCE_SHA256;
      capabilityCompatible = false;
    }
    if (operation === "restore_service")
      serviceDefinitionSha256 = authorization.serviceReplacement.rollbackDefinitionSha256;
    if (operation === "restart_rollback") {
      stopped = false;
      runtimeVersion = "24.10.0";
      runtimeExecutable = "/usr/local/Cellar/node/24.10.0/bin/node";
      heartbeatSequence += 3;
      terminal = true;
    }
    return {
      operationId: randomUUID(),
      operation,
      agentId: NAMED_CANARY_ID,
      authorizationChecksum: authorizationChecksum(authorization),
      status: "succeeded",
      evidenceChecksum: sha256(`${operation}:${operations.length}`),
      completedAt: new Date(databaseNow.getTime() + operations.length * 1000).toISOString(),
      details: {
        artifactSha256,
        serviceDefinitionSha256,
        nodeExecutableSha256: runtimeVersion === NODE_VERSION ? authorization.nodeRuntime.executableSha256 : null,
        owner: "fixture:fixture",
        mode: operation.includes("service") ? "0600" : "0700",
        identityPreserved: true,
        heartbeatSequence,
      },
    };
  };

  return {
    store: {
      async databaseTime() {
        return databaseNow;
      },
      async schemaVersion() {
        return schema;
      },
      async loadAuthorization(id) {
        return id === authorization.authorizationId ? authorization : null;
      },
      async approvalStatus(input) {
        return {
          granted: input.authorizationChecksum === authorizationChecksum(authorization),
          approvedBy: authorization.approvedBy,
          expiresAt: new Date(authorization.expiresAt),
        };
      },
      async preMigrationAuthorizationCount() {
        return 1;
      },
      async executionState() {
        return { state, executionCount, revoked: false, concurrentExecutions: 1 };
      },
      async transition(input) {
        if (input.expected !== state)
          throw new Error(`Disposable CAS mismatch: expected ${input.expected}, got ${state}.`);
        state = input.next;
        if (input.next === "replacing") executionCount = 1;
      },
      async createBackup() {
        return {
          backupId: `disposable-${randomUUID()}`,
          sha256: sha256("disposable-production-backup"),
          sizeBytes: 4096,
          encrypted: true,
          mode: "0600",
          verified: true,
          owner: "fixture:fixture",
          storageIdentity: "disposable-encrypted-volume",
          encryptionIdentity: "disposable-kms-fixture",
          retention: "until disposable validation completes",
          restoreValidation: "pg_restore --list fixture passed",
          preMigrationSchema: "0028",
          completedAt: databaseNow.toISOString(),
        };
      },
      async applyMigration0029(checksum) {
        if (checksum !== MIGRATION_0029_SHA256) throw new Error("Disposable migration checksum mismatch.");
        schema = "0029";
      },
      async initializeAfterMigration() {},
      async applicationHealth() {
        return { health: 200, readiness: 200 };
      },
    },
    host: {
      async inspect() {
        return snapshot();
      },
      perform,
      async readJournal() {
        return options.journal
          ? {
              authorizationChecksum: authorizationChecksum(authorization),
              lastCompletedOperation: journalLast,
              nextSafeOperation: journalNext,
              rollbackAvailable: true,
              checksumValid: options.journal.checksumValid ?? true,
            }
          : null;
      },
    },
    release: {
      async signedManifestText() {
        return readFile("release/mission-agent-0.7.2/signed-manifest-v3.json", "utf8");
      },
      async artifact() {
        return Uint8Array.from(await readFile("public/mission-agent-0.7.2.mjs"));
      },
      async trustActive() {
        return true;
      },
    },
    smoke: {
      async run() {
        if (options.failAt === "smoke") throw new Error("Injected disposable smoke failure.");
        return {
          missionId: randomUUID(),
          executionId: randomUUID(),
          finalState: "completed",
          readOnly: true,
          projectionConsistent: true,
          duplicateExecution: false,
          unauthorizedSideEffect: false,
          evidenceChecksum: sha256("disposable-smoke"),
          repositoryId: authorization.repositoryId,
          repositoryFingerprint: authorization.repositoryFingerprint,
          assignedAt: databaseNow.toISOString(),
          startedAt: new Date(databaseNow.getTime() + 1000).toISOString(),
          completedAt: new Date(databaseNow.getTime() + 2000).toISOString(),
          heartbeatSequence,
          policyDecision: "allowed-read-only",
          approvalDecision: "not-required-read-only",
          liveProjectionHash: sha256("projection"),
          replayProjectionHash: sha256("projection"),
        };
      },
    },
    inspectState() {
      return { operations: [...operations], state };
    },
  };
}
