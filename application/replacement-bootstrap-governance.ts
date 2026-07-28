import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import {
  NAMED_CANARY_ID,
  NODE_EXECUTABLE,
  NODE_VERSION,
  ROLLBACK_INVENTORY_SHA256,
  SOURCE_SHA256,
  TARGET_SERVICE_SHA256,
  TARGET_SHA256,
  authorizationChecksum,
  validateReplacementAuthorization,
  type ReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap";
import {
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { deriveSigningKey } from "../remote-agent/protocol";
import {
  REPLACEMENT_PROVIDER,
  expectedOperation,
  fixedConditionChecksum,
  fixedOperationChecksum,
  intentState,
  replacementOperationDefinitions,
  replacementForwardOperations,
  replacementRollbackOperations,
  stateAfterAcceptedOperation,
  type ReplacementExecutionState,
} from "./replacement-bootstrap-state-machine";
import type { LocalOperationReceipt } from "./replacement-bootstrap-local-operator";
import type { LocalReplacementOperation } from "./replacement-bootstrap-local-journal";
import { assertDisposableReplacementDatabase } from "./replacement-bootstrap-safety-gate";
import {
  missionAgentCapabilityProjectionFromEvent,
  missionAgentHeartbeatProjectionFromEvent,
} from "./mission-agent-capability-projector";
import type { DomainEvent } from "../lib/postgres-event-store";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const capabilityReplayEvent = (input: { occurred_at: Date; payload: Record<string, unknown> }): DomainEvent => ({
  position: 0,
  eventId: "00000000-0000-4000-8000-000000000000",
  eventType: "agent.mission_agent_artifact_checksum_verified",
  eventSchemaVersion: 1,
  aggregateType: "agent",
  aggregateId: NAMED_CANARY_ID,
  aggregateVersion: 0,
  workspaceId: "00000000-0000-4000-8000-000000000000",
  correlationId: "replacement-security-replay",
  actorType: "agent",
  actorId: NAMED_CANARY_ID,
  occurredAt: input.occurred_at.toISOString(),
  payload: input.payload,
  metadata: {},
});

export type ReplacementClaim = {
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  credentialId: string;
  agentId: string;
  operatorIdentity: string;
  providerIdentifier: typeof REPLACEMENT_PROVIDER;
  generation: 1;
  state: ReplacementExecutionState;
  lastAcceptedSequence: number;
  claimedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
};

export type IssuedReplacementCredential = {
  credentialId: string;
  secret: string;
  executionId: string;
  claimGeneration: 1;
  authorizationFingerprint: string;
  scopeChecksum: string;
  expiresAt: string;
};

async function persistValidatedProcessObservation(input: {
  client: PoolClient;
  workspaceId: string;
  claim: ReplacementClaim;
  receipt: LocalOperationReceipt;
  rollback: boolean;
}): Promise<void> {
  const value = input.receipt.observation;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Running-process observation is required.");
  const startIntent = await input.client.query<{ created_at: Date; expected_host: string }>(
    `SELECT i.created_at,b.authorization_record->>'hostIdentity' expected_host
       FROM mission_agent_replacement_mutation_intents i
       JOIN mission_agent_replacement_bootstraps b
         ON b.workspace_id=i.workspace_id AND b.authorization_id=i.authorization_id
      WHERE i.workspace_id=$1 AND i.authorization_id=$2 AND i.execution_id=$3
        AND operation=$4 AND status IN ('prepared','completed')
      ORDER BY i.sequence DESC LIMIT 1`,
    [
      input.workspaceId,
      input.claim.authorizationId,
      input.claim.executionId,
      input.rollback ? "restart_prior_service" : "start_service",
    ],
  );
  const intentAt = startIntent.rows[0]?.created_at;
  const expectedHost = startIntent.rows[0]?.expected_host;
  const processStartedAt = new Date(String(value.processStartedAt));
  const expectedNode = input.rollback ? "/usr/local/Cellar/node/24.10.0/bin/node" : NODE_EXECUTABLE;
  const expectedVersion = input.rollback ? "v24.10.0" : `v${NODE_VERSION}`;
  const expectedArtifact = input.rollback
    ? "/Users/shawnwollenberg/.mission-agent/mission-agent-0.6.8.mjs"
    : "/Users/shawnwollenberg/.mission-agent/mission-agent-0.7.2.mjs";
  const expectedChecksum = input.rollback ? SOURCE_SHA256 : TARGET_SHA256;
  const expectedPlist = input.rollback
    ? "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898"
    : TARGET_SERVICE_SHA256;
  if (
    !(intentAt instanceof Date) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 1 ||
    !Number.isSafeInteger(value.parentPid) ||
    !Number.isFinite(processStartedAt.getTime()) ||
    processStartedAt < intentAt ||
    value.observationVersion !== "mission-agent-process-v1" ||
    value.hostIdentity !== expectedHost ||
    value.agentId !== NAMED_CANARY_ID ||
    value.serviceLabel !== "com.wallyweb.mission-agent" ||
    value.nodeExecutable !== expectedNode ||
    value.nodeVersion !== expectedVersion ||
    value.artifactPath !== expectedArtifact ||
    value.artifactChecksum !== expectedChecksum ||
    value.launchdPlistChecksum !== expectedPlist ||
    value.processArgumentsChecksum !== sha256(`${expectedNode} ${expectedArtifact} run`) ||
    value.processOwner !== "shawnwollenberg"
  )
    throw new Error("Running-process observation does not bind the exact replacement runtime.");
  const evidence = { ...value, observedForOperation: input.receipt.operation };
  const evidenceChecksum = sha256(canonicalJson(evidence));
  await input.client.query(
    `INSERT INTO mission_agent_replacement_evidence(
      workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
      observed_at,expires_at
    ) VALUES($1,$2,$3,'process',$4,$5::jsonb,clock_timestamp(),$6)`,
    [
      input.workspaceId,
      input.claim.authorizationId,
      input.claim.executionId,
      evidenceChecksum,
      JSON.stringify(evidence),
      input.claim.expiresAt,
    ],
  );
}

async function requireFreshHeartbeatCapabilitiesAndProjection(input: {
  client: PoolClient;
  workspaceId: string;
  claim: ReplacementClaim;
}): Promise<void> {
  const processes = await input.client.query<{ evidence: Record<string, unknown> }>(
    `SELECT evidence FROM mission_agent_replacement_evidence
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND evidence_type='process'
      ORDER BY observed_at`,
    [input.workspaceId, input.claim.authorizationId, input.claim.executionId],
  );
  if (processes.rows.length < 2) throw new Error("Repeated running-process observations are required.");
  const pids = new Set(processes.rows.map((row) => row.evidence.pid));
  const startedAt = new Date(String(processes.rows[0]?.evidence.processStartedAt));
  if (pids.size !== 1 || !Number.isFinite(startedAt.getTime()))
    throw new Error("Running-process observations do not identify one stable process.");
  const state = await input.client.query<{
    status: string;
    last_heartbeat_at: Date | null;
    mission_agent_version: string | null;
    mission_agent_artifact_checksum: string | null;
    mission_agent_checksum_status: string;
    mission_agent_manifest_version: string | null;
    mission_agent_capability_expires_at: Date | null;
    advertised_version: string | null;
    advertised_checksum: string | null;
    manifest_version: string | null;
    checksum_status: string | null;
    observed_at: Date | null;
    freshness_expires_at: Date | null;
    repository_id: string;
    repository_fingerprint: string | null;
    expected_fingerprint: string;
    source_fingerprint: string | null;
  }>(
    `SELECT a.status,a.last_heartbeat_at,a.mission_agent_version,a.mission_agent_artifact_checksum,
            a.mission_agent_checksum_status,a.mission_agent_manifest_version,
            a.mission_agent_capability_expires_at,p.advertised_version,p.advertised_checksum,
            p.manifest_version,p.checksum_status,p.observed_at,p.freshness_expires_at,
            r.repository_id,r.repository_fingerprint,b.authorization_record->>'repositoryFingerprint' expected_fingerprint,
            (SELECT i.fingerprint FROM repository_identities i
              WHERE i.workspace_id=r.workspace_id AND i.repository_id=r.repository_id
                AND i.migration_status='active'
              ORDER BY i.verified_at DESC NULLS LAST,i.created_at DESC LIMIT 1) source_fingerprint
       FROM agents a
       JOIN mission_agent_replacement_bootstraps b
         ON b.workspace_id=a.workspace_id AND b.agent_id=a.agent_id
       JOIN repositories r ON r.workspace_id=a.workspace_id
         AND r.repository_id=(b.authorization_record->>'repositoryId')::uuid
       LEFT JOIN mission_agent_capability_projections p
         ON p.workspace_id=a.workspace_id AND p.agent_id=a.agent_id
      WHERE a.workspace_id=$1 AND a.agent_id=$2 AND b.authorization_id=$3`,
    [input.workspaceId, input.claim.agentId, input.claim.authorizationId],
  );
  const row = state.rows[0];
  const heartbeats = await input.client.query<{
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(
    `SELECT occurred_at,payload FROM events
        WHERE workspace_id=$1 AND aggregate_type='agent' AND aggregate_id=$2
          AND event_type='agent.heartbeat_received' AND occurred_at>$3
        ORDER BY aggregate_version DESC LIMIT 3`,
    [input.workspaceId, input.claim.agentId, startedAt],
  );
  const checksumEvent = await input.client.query<{
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(
    `SELECT occurred_at,payload FROM events
      WHERE workspace_id=$1 AND aggregate_type='agent' AND aggregate_id=$2
        AND event_type='agent.mission_agent_artifact_checksum_verified'
        AND occurred_at>$3
      ORDER BY aggregate_version DESC LIMIT 1`,
    [input.workspaceId, input.claim.agentId, startedAt],
  );
  const heartbeatPayloads = heartbeats.rows.map((item) => item.payload);
  const heartbeatReleaseCompatible = heartbeatPayloads.every((payload) => {
    const artifact = payload.artifact as Record<string, unknown> | undefined;
    const release = payload.release as Record<string, unknown> | undefined;
    const identity = payload.repositoryIdentity as Record<string, unknown> | undefined;
    return (
      payload.missionAgentVersion === "0.7.2" &&
      artifact?.sha256 === TARGET_SHA256 &&
      artifact?.manifestVersion === "3" &&
      artifact?.releaseAuthorityVersion === "v2" &&
      artifact?.canonicalizationVersion === "release-manifest-json-v3" &&
      release?.authorityVersion === "v2" &&
      release?.manifestVersion === "3" &&
      release?.canonicalizationVersion === "release-manifest-json-v3" &&
      release?.signingKeyId === "mission-agent-release-2026-01" &&
      release?.sourceCommit === "31b45c98f2ffba613b56cd23819ba8b0c9c09a43" &&
      identity?.stableProtocolVersion === "2" &&
      identity?.activationAcknowledgementVersion === "1"
    );
  });
  const authorizationRecord = await input.client.query<{
    repository_id: string;
    repository_fingerprint: string;
  }>(
    `SELECT authorization_record->>'repositoryId' repository_id,
            authorization_record->>'repositoryFingerprint' repository_fingerprint
       FROM mission_agent_replacement_bootstraps
      WHERE workspace_id=$1 AND authorization_id=$2`,
    [input.workspaceId, input.claim.authorizationId],
  );
  const expectedRepository = authorizationRecord.rows[0];
  const heartbeatIdentityCompatible =
    !!expectedRepository &&
    heartbeatPayloads.every((payload) => {
      const identity = payload.repositoryIdentity as Record<string, unknown> | undefined;
      const repositories = Array.isArray(identity?.repositories)
        ? (identity.repositories as Record<string, unknown>[])
        : [];
      return repositories.some(
        (repository) =>
          repository.repositoryId === expectedRepository.repository_id &&
          repository.fingerprint === expectedRepository.repository_fingerprint,
      );
    });
  const verifiedEvent = checksumEvent.rows[0];
  const replayedCapability = verifiedEvent
    ? missionAgentCapabilityProjectionFromEvent(capabilityReplayEvent(verifiedEvent))
    : null;
  const clock = await input.client.query<{ now: Date }>("SELECT clock_timestamp() now");
  const now = clock.rows[0]?.now;
  if (
    !row ||
    !(now instanceof Date) ||
    row.status !== "active" ||
    !row.last_heartbeat_at ||
    row.last_heartbeat_at <= startedAt ||
    row.mission_agent_version !== "0.7.2" ||
    row.mission_agent_artifact_checksum !== TARGET_SHA256 ||
    row.mission_agent_checksum_status !== "verified" ||
    row.mission_agent_manifest_version !== "3" ||
    !row.mission_agent_capability_expires_at ||
    row.mission_agent_capability_expires_at <= now ||
    row.advertised_version !== "0.7.2" ||
    row.advertised_checksum !== TARGET_SHA256 ||
    row.manifest_version !== "3" ||
    row.checksum_status !== "verified" ||
    !row.observed_at ||
    row.observed_at <= startedAt ||
    !row.freshness_expires_at ||
    row.freshness_expires_at <= now ||
    row.repository_fingerprint !== row.expected_fingerprint ||
    row.repository_fingerprint !== row.source_fingerprint ||
    heartbeats.rows.length < 3 ||
    !heartbeatReleaseCompatible ||
    !heartbeatIdentityCompatible ||
    !verifiedEvent ||
    !replayedCapability ||
    verifiedEvent.payload.advertisedVersion !== row.advertised_version ||
    verifiedEvent.payload.advertisedChecksum !== row.advertised_checksum ||
    verifiedEvent.payload.expectedChecksum !== TARGET_SHA256 ||
    verifiedEvent.payload.manifestVersion !== row.manifest_version ||
    verifiedEvent.payload.status !== row.checksum_status
  )
    throw new Error("Fresh heartbeat, capability, or repository projection evidence is incomplete.");
  const liveProjection = {
    status: row.status,
    heartbeatAt: row.last_heartbeat_at.toISOString(),
    agentVersion: row.mission_agent_version,
    artifactChecksum: row.mission_agent_artifact_checksum,
    manifestVersion: row.mission_agent_manifest_version,
    capabilityObservedAt: row.observed_at.toISOString(),
    capabilityExpiresAt: row.freshness_expires_at.toISOString(),
    checksumStatus: row.checksum_status,
    repositoryFingerprint: row.repository_fingerprint,
  };
  const latestHeartbeat = heartbeats.rows[0]!;
  const replayedHeartbeat = missionAgentHeartbeatProjectionFromEvent({
    position: 0,
    eventId: randomUUID(),
    workspaceId: input.workspaceId,
    aggregateType: "agent",
    aggregateId: input.claim.agentId,
    aggregateVersion: 1,
    eventType: "agent.heartbeat_received",
    eventSchemaVersion: 1,
    occurredAt: latestHeartbeat.occurred_at.toISOString(),
    actorType: "agent",
    actorId: input.claim.agentId,
    correlationId: input.claim.executionId,
    causationId: undefined,
    payload: latestHeartbeat.payload,
    metadata: {},
  });
  if (!replayedHeartbeat) throw new Error("Latest heartbeat cannot be replayed.");
  const replayedRepositoryFingerprint = replayedHeartbeat.repositoryFingerprints[row.repository_id];
  if (
    !replayedRepositoryFingerprint ||
    replayedRepositoryFingerprint !== row.source_fingerprint ||
    replayedRepositoryFingerprint !== row.repository_fingerprint
  )
    throw new Error("Repository identity does not equal authenticated event reconstruction.");
  const replayedProjection = {
    status: replayedHeartbeat.status,
    heartbeatAt: replayedHeartbeat.heartbeatAt.toISOString(),
    agentVersion: replayedHeartbeat.agentVersion,
    artifactChecksum: replayedHeartbeat.artifactChecksum,
    manifestVersion: replayedHeartbeat.manifestVersion,
    capabilityObservedAt: replayedCapability.observedAt.toISOString(),
    capabilityExpiresAt: replayedCapability.freshnessExpiresAt.toISOString(),
    checksumStatus: replayedCapability.checksumStatus,
    repositoryFingerprint: replayedRepositoryFingerprint,
  };
  const liveProjectionChecksum = sha256(canonicalJson(liveProjection));
  const replayedProjectionChecksum = sha256(canonicalJson(replayedProjection));
  if (liveProjectionChecksum !== replayedProjectionChecksum)
    throw new Error("Mission Agent projection does not equal deterministic event reconstruction.");
  const evidence = {
    ...liveProjection,
    liveProjectionChecksum,
    replayedProjectionChecksum,
    repositoryIdentitySourceChecksum: sha256(canonicalJson({ repositoryFingerprint: row.source_fingerprint })),
    repositoryIdentityEventReplayChecksum: sha256(
      canonicalJson({ repositoryFingerprint: replayedRepositoryFingerprint }),
    ),
    consecutiveHeartbeatCount: 3,
    releaseAuthorityVersion: "v2",
    canonicalization: "release-manifest-json-v3",
    identityProtocolVersion: "2",
    activationProtocolVersion: "1",
    nodeMajor: 22,
    processId: Array.from(pids)[0],
  };
  const evidenceChecksum = sha256(canonicalJson(evidence));
  await input.client.query(
    `INSERT INTO mission_agent_replacement_evidence(
      workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
      observed_at,expires_at
    ) VALUES($1,$2,$3,'heartbeat-capability',$4,$5::jsonb,clock_timestamp(),$6),
            ($1,$2,$3,'projection',$4,$5::jsonb,clock_timestamp(),$6)
    ON CONFLICT DO NOTHING`,
    [
      input.workspaceId,
      input.claim.authorizationId,
      input.claim.executionId,
      evidenceChecksum,
      JSON.stringify(evidence),
      input.claim.expiresAt,
    ],
  );
}

async function requireRollbackEquivalence(input: {
  client: PoolClient;
  workspaceId: string;
  claim: ReplacementClaim;
}): Promise<void> {
  const process = await input.client.query<{ evidence: Record<string, unknown> }>(
    `SELECT evidence FROM mission_agent_replacement_evidence
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND evidence_type='process'
        AND evidence->>'artifactChecksum'=$4
      ORDER BY observed_at DESC LIMIT 2`,
    [input.workspaceId, input.claim.authorizationId, input.claim.executionId, SOURCE_SHA256],
  );
  if (process.rows.length < 2 || new Set(process.rows.map((row) => row.evidence.pid)).size !== 1)
    throw new Error("Rollback requires repeated observations of one restored 0.6.8 process.");
  const startedAt = new Date(String(process.rows[0]?.evidence.processStartedAt));
  const state = await input.client.query<{
    version: string | null;
    checksum: string | null;
    heartbeat: Date | null;
    capability_version: string | null;
    capability_checksum: string | null;
    capability_status: string | null;
    capability_observed_at: Date | null;
    capability_expires_at: Date | null;
    repository_id: string;
    repository_fingerprint: string | null;
    expected_fingerprint: string;
    source_fingerprint: string | null;
  }>(
    `SELECT a.mission_agent_version version,a.mission_agent_artifact_checksum checksum,
            a.last_heartbeat_at heartbeat,p.advertised_version capability_version,
            p.advertised_checksum capability_checksum,p.checksum_status capability_status,
            p.observed_at capability_observed_at,p.freshness_expires_at capability_expires_at,
            r.repository_id,r.repository_fingerprint,
            b.authorization_record->>'repositoryFingerprint' expected_fingerprint,
            (SELECT i.fingerprint FROM repository_identities i
              WHERE i.workspace_id=r.workspace_id AND i.repository_id=r.repository_id
                AND i.migration_status='active'
              ORDER BY i.verified_at DESC NULLS LAST,i.created_at DESC LIMIT 1) source_fingerprint
       FROM agents a
       JOIN mission_agent_replacement_bootstraps b
         ON b.workspace_id=a.workspace_id AND b.agent_id=a.agent_id
       JOIN repositories r ON r.workspace_id=a.workspace_id
         AND r.repository_id=(b.authorization_record->>'repositoryId')::uuid
       LEFT JOIN mission_agent_capability_projections p
         ON p.workspace_id=a.workspace_id AND p.agent_id=a.agent_id
      WHERE a.workspace_id=$1 AND a.agent_id=$2 AND b.authorization_id=$3`,
    [input.workspaceId, input.claim.agentId, input.claim.authorizationId],
  );
  const row = state.rows[0];
  const heartbeats = await input.client.query<{
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(
    `SELECT occurred_at,payload FROM events WHERE workspace_id=$1 AND aggregate_type='agent' AND aggregate_id=$2
         AND event_type='agent.heartbeat_received' AND occurred_at>$3
       ORDER BY aggregate_version DESC LIMIT 3`,
    [input.workspaceId, input.claim.agentId, startedAt],
  );
  const capabilityEvent = await input.client.query<{
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(
    `SELECT occurred_at,payload FROM events
      WHERE workspace_id=$1 AND aggregate_type='agent' AND aggregate_id=$2
        AND event_type='agent.mission_agent_artifact_checksum_verified' AND occurred_at>$3
      ORDER BY aggregate_version DESC LIMIT 1`,
    [input.workspaceId, input.claim.agentId, startedAt],
  );
  const priorProcessesExact = process.rows.every(
    ({ evidence }) =>
      evidence.nodeExecutable === "/usr/local/Cellar/node/24.10.0/bin/node" &&
      evidence.nodeVersion === "v24.10.0" &&
      evidence.launchdPlistChecksum === "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898" &&
      evidence.targetProcessAbsent === true,
  );
  const inventoryObservation = process.rows.find(
    ({ evidence }) => evidence.rollbackInventoryChecksum === ROLLBACK_INVENTORY_SHA256,
  )?.evidence;
  const rollbackInventoryExact =
    !!inventoryObservation &&
    inventoryObservation.artifactByteLength === 117277 &&
    inventoryObservation.artifactMode === "0700" &&
    inventoryObservation.artifactChecksum === SOURCE_SHA256 &&
    inventoryObservation.plistByteLength === 2308 &&
    inventoryObservation.plistMode === "0600" &&
    inventoryObservation.plistChecksum === "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898" &&
    inventoryObservation.configurationByteLength === 2034 &&
    inventoryObservation.configurationMode === "0600" &&
    inventoryObservation.configurationChecksum === "8db02e81b4b09945e164d7789e690ea7c3ad97ffb5e892ab7de559de38517742" &&
    inventoryObservation.owner === "shawnwollenberg" &&
    inventoryObservation.group === "staff" &&
    inventoryObservation.credentialMetadataPresent === true &&
    inventoryObservation.credentialStorage === "macOS Keychain" &&
    inventoryObservation.credentialItemClass === "generic-password" &&
    inventoryObservation.credentialService === "Mission Agent" &&
    inventoryObservation.credentialAccount === input.claim.agentId &&
    inventoryObservation.credentialMetadataChecksum ===
      sha256(
        canonicalJson({
          itemClass: "generic-password",
          service: "Mission Agent",
          account: input.claim.agentId,
        }),
      ) &&
    canonicalJson(inventoryObservation.environmentNames) === canonicalJson(["MISSION_AGENT_HOME", "PATH"]) &&
    canonicalJson(inventoryObservation.environmentValueChecksums) ===
      canonicalJson({
        MISSION_AGENT_HOME: "0974bb09ab4b18256c3a16bb4c6997a1ce50d68d8317a0c1d1634ed5f68f526d",
        PATH: "34e696b0c29cbb879f48eb2d4e321f21f0e3eb053d495e010e8d867ae0ed926f",
      }) &&
    inventoryObservation.standardOutputPath === "/Users/shawnwollenberg/.mission-agent/mission-agent.log" &&
    inventoryObservation.standardErrorPath === "/Users/shawnwollenberg/.mission-agent/mission-agent-error.log" &&
    inventoryObservation.runAtLoad === true &&
    inventoryObservation.keepAlive === true;
  const priorHeartbeatsExact = heartbeats.rows.every((heartbeat) => {
    const artifact = heartbeat.payload.artifact as Record<string, unknown> | undefined;
    return heartbeat.payload.missionAgentVersion === "0.6.8" && artifact?.sha256 === SOURCE_SHA256;
  });
  const replayCapability = capabilityEvent.rows[0];
  const replayedCapability = replayCapability
    ? missionAgentCapabilityProjectionFromEvent(capabilityReplayEvent(replayCapability))
    : null;
  if (
    !row ||
    row.version !== "0.6.8" ||
    row.checksum !== SOURCE_SHA256 ||
    !row.heartbeat ||
    row.heartbeat <= startedAt ||
    row.capability_version !== "0.6.8" ||
    row.capability_checksum !== SOURCE_SHA256 ||
    row.repository_fingerprint !== row.expected_fingerprint ||
    row.repository_fingerprint !== row.source_fingerprint ||
    heartbeats.rows.length < 3 ||
    !priorProcessesExact ||
    !rollbackInventoryExact ||
    !priorHeartbeatsExact ||
    !replayCapability ||
    !replayedCapability ||
    replayCapability.payload.advertisedVersion !== row.capability_version ||
    replayCapability.payload.advertisedChecksum !== row.capability_checksum
  )
    throw new Error(
      `Prior-version heartbeat, capability, identity, or projection equivalence failed: ${canonicalJson({
        rowPresent: !!row,
        processCount: process.rows.length,
        priorProcessesExact,
        rollbackInventoryExact,
        heartbeatCount: heartbeats.rows.length,
        priorHeartbeatsExact,
        capabilityEventPresent: !!replayCapability,
        heartbeatAfterProcess: !!row?.heartbeat && row.heartbeat > startedAt,
        repositoryMatch: !!row && row.repository_fingerprint === row.expected_fingerprint,
      })}`,
    );
  const liveProjection = {
    version: row.version,
    artifactChecksum: row.checksum,
    heartbeatAt: row.heartbeat.toISOString(),
    capabilityVersion: row.capability_version,
    capabilityChecksum: row.capability_checksum,
    capabilityStatus: row.capability_status,
    capabilityObservedAt: row.capability_observed_at?.toISOString() ?? null,
    capabilityExpiresAt: row.capability_expires_at?.toISOString() ?? null,
    repositoryFingerprint: row.repository_fingerprint,
  };
  const latestRollbackHeartbeat = heartbeats.rows[0]!;
  const replayedRollbackHeartbeat = missionAgentHeartbeatProjectionFromEvent({
    position: 0,
    eventId: randomUUID(),
    workspaceId: input.workspaceId,
    aggregateType: "agent",
    aggregateId: input.claim.agentId,
    aggregateVersion: 1,
    eventType: "agent.heartbeat_received",
    eventSchemaVersion: 1,
    occurredAt: latestRollbackHeartbeat.occurred_at.toISOString(),
    actorType: "agent",
    actorId: input.claim.agentId,
    correlationId: input.claim.executionId,
    causationId: undefined,
    payload: latestRollbackHeartbeat.payload,
    metadata: {},
  });
  if (!replayedRollbackHeartbeat) throw new Error("Rollback heartbeat cannot be replayed.");
  const replayedRepositoryFingerprint = replayedRollbackHeartbeat.repositoryFingerprints[row.repository_id];
  if (
    !replayedRepositoryFingerprint ||
    replayedRepositoryFingerprint !== row.source_fingerprint ||
    replayedRepositoryFingerprint !== row.repository_fingerprint
  )
    throw new Error("Rollback repository identity does not equal authenticated event reconstruction.");
  const replayedProjection = {
    version: replayedRollbackHeartbeat.agentVersion,
    artifactChecksum: replayedRollbackHeartbeat.artifactChecksum,
    heartbeatAt: replayedRollbackHeartbeat.heartbeatAt.toISOString(),
    capabilityVersion: replayedCapability.advertisedVersion,
    capabilityChecksum: replayedCapability.advertisedChecksum,
    capabilityStatus: replayedCapability.checksumStatus,
    capabilityObservedAt: replayedCapability.observedAt.toISOString(),
    capabilityExpiresAt: replayedCapability.freshnessExpiresAt.toISOString(),
    repositoryFingerprint: replayedRepositoryFingerprint,
  };
  const liveProjectionChecksum = sha256(canonicalJson(liveProjection));
  const replayedProjectionChecksum = sha256(canonicalJson(replayedProjection));
  if (liveProjectionChecksum !== replayedProjectionChecksum)
    throw new Error("Prior-version projection does not equal deterministic event reconstruction.");
  const evidence = {
    evidenceVersion: "replacement-rollback-equivalence-v1",
    authorizationId: input.claim.authorizationId,
    executionId: input.claim.executionId,
    agentId: input.claim.agentId,
    version: row.version,
    artifactChecksum: row.checksum,
    plistChecksum: process.rows[0]?.evidence.launchdPlistChecksum,
    nodeExecutable: process.rows[0]?.evidence.nodeExecutable,
    processId: process.rows[0]?.evidence.pid,
    consecutiveHeartbeatCount: 3,
    repositoryFingerprint: row.repository_fingerprint,
    targetProcessAbsent: process.rows.every((item) => item.evidence.targetProcessAbsent === true),
    liveProjectionChecksum,
    replayedProjectionChecksum,
    repositoryIdentitySourceChecksum: sha256(canonicalJson({ repositoryFingerprint: row.source_fingerprint })),
    repositoryIdentityEventReplayChecksum: sha256(
      canonicalJson({ repositoryFingerprint: replayedRepositoryFingerprint }),
    ),
    projectionReplayEqual: liveProjectionChecksum === replayedProjectionChecksum,
    rollbackInventoryChecksum: inventoryObservation.rollbackInventoryChecksum,
    rollbackInventoryExact,
  };
  const evidenceChecksum = sha256(canonicalJson(evidence));
  await input.client.query(
    `INSERT INTO mission_agent_replacement_evidence(
      workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
      observed_at,expires_at
    ) VALUES($1,$2,$3,'rollback-equivalence',$4,$5::jsonb,clock_timestamp(),$6)`,
    [
      input.workspaceId,
      input.claim.authorizationId,
      input.claim.executionId,
      evidenceChecksum,
      JSON.stringify(evidence),
      input.claim.expiresAt,
    ],
  );
}

function credentialScope(input: {
  authorization: ReplacementAuthorization;
  executionId: string;
  credentialId: string;
}) {
  return {
    authorizationId: input.authorization.authorizationId,
    executionId: input.executionId,
    credentialId: input.credentialId,
    agentId: input.authorization.agentId,
    providerIdentifier: REPLACEMENT_PROVIDER,
    authorizationFingerprint: authorizationChecksum(input.authorization),
    targetArtifactSha256: input.authorization.targetArtifactSha256,
    nodeExecutableSha256: input.authorization.nodeRuntime.executableSha256,
    targetPlistSha256: input.authorization.serviceReplacement.targetDefinitionSha256,
    allowedOperations: [...replacementForwardOperations, ...replacementRollbackOperations],
    maximumReceiptSequence: replacementForwardOperations.length + replacementRollbackOperations.length,
  };
}

export async function issueReplacementCredentialAndClaim(input: {
  client: PoolClient;
  authorization: ReplacementAuthorization;
  executionId: string;
  authenticatedApprover: string;
}): Promise<IssuedReplacementCredential> {
  if (!UUID.test(input.executionId)) throw new Error("Replacement execution ID is malformed.");
  await input.client.query("BEGIN");
  try {
    await assertDisposableReplacementDatabase(input.client);
    const clock = await input.client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date)) throw new Error("PostgreSQL clock is unavailable.");
    validateReplacementAuthorization(input.authorization, { now });
    const fingerprint = authorizationChecksum(input.authorization);
    const authorization = await input.client.query<{
      state: string;
      authorization_checksum: string;
      execution_count: number;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT state,authorization_checksum,execution_count,expires_at,revoked_at
         FROM mission_agent_replacement_bootstraps
        WHERE workspace_id=$1 AND authorization_id=$2 AND agent_id=$3
        FOR UPDATE`,
      [input.authorization.workspaceId, input.authorization.authorizationId, input.authorization.agentId],
    );
    const row = authorization.rows[0];
    const approval = await input.client.query<{
      status: string;
      decided_by: string | null;
      action_hash: string;
      expires_at: Date | null;
    }>(
      `SELECT status,decided_by,action_hash,expires_at
         FROM approval_projections
        WHERE workspace_id=$1 AND approval_id=$2
        FOR UPDATE`,
      [input.authorization.workspaceId, input.authorization.approvalId],
    );
    const approved = approval.rows[0];
    if (
      !row ||
      row.state !== "approved" ||
      row.authorization_checksum !== fingerprint ||
      row.execution_count !== 0 ||
      row.revoked_at !== null ||
      row.expires_at <= now ||
      !approved ||
      approved.status !== "granted" ||
      approved.decided_by !== input.authenticatedApprover ||
      input.authenticatedApprover !== input.authorization.approvedBy ||
      approved.action_hash !== fingerprint ||
      (approved.expires_at !== null && approved.expires_at <= now)
    )
      throw new Error("Replacement authorization and approval are not atomically issuable.");
    const active = await input.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM mission_agent_replacement_execution_claims
        WHERE workspace_id=$1 AND agent_id=$2 AND completed_at IS NULL`,
      [input.authorization.workspaceId, input.authorization.agentId],
    );
    if (Number(active.rows[0]?.count ?? "0") !== 0)
      throw new Error("A replacement execution already owns the named agent.");

    const credentialId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const verifier = deriveSigningKey(secret);
    const scope = credentialScope({ authorization: input.authorization, executionId: input.executionId, credentialId });
    const scopeChecksum = sha256(canonicalJson(scope));
    await input.client.query(
      `INSERT INTO agent_credentials(
        workspace_id,credential_id,agent_id,version,secret_verifier,status,
        allowed_protocol_versions,created_at,expires_at,verified_at
      )
      SELECT $1,$2,$3,coalesce(max(version),0)+1,$4,'active',$5::jsonb,$6,$7,$6
        FROM agent_credentials
       WHERE workspace_id=$1 AND agent_id=$3`,
      [
        input.authorization.workspaceId,
        credentialId,
        NAMED_CANARY_ID,
        verifier,
        JSON.stringify([REPLACEMENT_CREDENTIAL_PROTOCOL]),
        now,
        input.authorization.expiresAt,
      ],
    );
    await input.client.query(
      `INSERT INTO mission_agent_replacement_credentials(
        workspace_id,credential_id,authorization_id,execution_id,agent_id,provider_identifier,
        authorization_fingerprint,scope_checksum,allowed_operations,verifier_fingerprint,
        issued_at,expires_at,maximum_receipt_sequence
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
      [
        input.authorization.workspaceId,
        credentialId,
        input.authorization.authorizationId,
        input.executionId,
        input.authorization.agentId,
        REPLACEMENT_PROVIDER,
        fingerprint,
        scopeChecksum,
        JSON.stringify(scope.allowedOperations),
        sha256(verifier),
        now,
        input.authorization.expiresAt,
        scope.maximumReceiptSequence,
      ],
    );
    await input.client.query(
      `INSERT INTO mission_agent_replacement_execution_claims(
        workspace_id,authorization_id,execution_id,credential_id,agent_id,operator_identity,
        provider_identifier,authorization_fingerprint,generation,state,last_accepted_sequence,
        claimed_at,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'claimed',0,$9,$10)`,
      [
        input.authorization.workspaceId,
        input.authorization.authorizationId,
        input.executionId,
        credentialId,
        input.authorization.agentId,
        input.authorization.operatorIdentity,
        REPLACEMENT_PROVIDER,
        fingerprint,
        now,
        input.authorization.expiresAt,
      ],
    );
    await input.client.query(
      `UPDATE mission_agent_replacement_bootstraps
          SET state='draining',execution_count=1,consumed_at=$3,updated_at=$3
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_count=0 AND state='approved'`,
      [input.authorization.workspaceId, input.authorization.authorizationId, now],
    );
    await input.client.query("COMMIT");
    return {
      credentialId,
      secret,
      executionId: input.executionId,
      claimGeneration: 1,
      authorizationFingerprint: fingerprint,
      scopeChecksum,
      expiresAt: input.authorization.expiresAt,
    };
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function lockClaim(input: {
  client: PoolClient;
  workspaceId: string;
  authorizationId: string;
  executionId: string;
  credentialId: string;
  agentId: string;
  providerIdentifier: string;
  authorizationFingerprint: string;
  claimGeneration: number;
  allowExpired?: boolean;
}): Promise<{ claim: ReplacementClaim; verifier: string; authorizationRevokedAt: Date | null }> {
  const result = await input.client.query<{
    authorization_id: string;
    execution_id: string;
    authorization_fingerprint: string;
    credential_id: string;
    agent_id: string;
    operator_identity: string;
    provider_identifier: typeof REPLACEMENT_PROVIDER;
    generation: 1;
    state: ReplacementExecutionState;
    last_accepted_sequence: number;
    claimed_at: Date;
    expires_at: Date;
    completed_at: Date | null;
    credential_expires_at: Date;
    credential_revoked_at: Date | null;
    credential_consumed_at: Date | null;
    secret_verifier: string;
    credential_status: string;
    authorization_revoked_at: Date | null;
    authorization_state: string;
    scope_checksum: string;
    allowed_operations: LocalReplacementOperation[];
    maximum_receipt_sequence: number;
    authorization_record: ReplacementAuthorization;
  }>(
    `SELECT c.*,rc.expires_at credential_expires_at,rc.revoked_at credential_revoked_at,
            rc.consumed_at credential_consumed_at,ac.secret_verifier,ac.status credential_status,
            rc.scope_checksum,rc.allowed_operations,rc.maximum_receipt_sequence,
            b.revoked_at authorization_revoked_at,b.state authorization_state,b.authorization_record
       FROM mission_agent_replacement_execution_claims c
       JOIN mission_agent_replacement_credentials rc
         ON rc.workspace_id=c.workspace_id AND rc.credential_id=c.credential_id
       JOIN agent_credentials ac
         ON ac.workspace_id=c.workspace_id AND ac.credential_id=c.credential_id
       JOIN mission_agent_replacement_bootstraps b
         ON b.workspace_id=c.workspace_id AND b.authorization_id=c.authorization_id
      WHERE c.workspace_id=$1 AND c.authorization_id=$2 AND c.execution_id=$3
      FOR UPDATE OF c,rc,ac,b`,
    [input.workspaceId, input.authorizationId, input.executionId],
  );
  const row = result.rows[0];
  const nowResult = await input.client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = nowResult.rows[0]?.now;
  if (
    !row ||
    !(now instanceof Date) ||
    row.credential_id !== input.credentialId ||
    row.agent_id !== input.agentId ||
    row.provider_identifier !== input.providerIdentifier ||
    row.authorization_fingerprint !== input.authorizationFingerprint ||
    row.generation !== input.claimGeneration ||
    (!input.allowExpired && (row.expires_at <= now || row.credential_expires_at <= now)) ||
    row.completed_at !== null ||
    row.credential_revoked_at !== null ||
    row.credential_consumed_at !== null ||
    row.authorization_revoked_at !== null ||
    row.credential_status !== "active" ||
    ["revoked", "expired", "completed", "rolled_back"].includes(row.authorization_state)
  )
    throw new Error("Replacement execution claim ownership is invalid, stale, expired, or terminal.");
  const expectedScope = credentialScope({
    authorization: row.authorization_record,
    executionId: row.execution_id,
    credentialId: row.credential_id,
  });
  if (
    row.scope_checksum !== sha256(canonicalJson(expectedScope)) ||
    canonicalJson(row.allowed_operations) !== canonicalJson(expectedScope.allowedOperations) ||
    row.maximum_receipt_sequence !== expectedScope.maximumReceiptSequence ||
    row.authorization_fingerprint !== authorizationChecksum(row.authorization_record)
  )
    throw new Error("Replacement credential scope is not bound to the durable authorization.");
  return {
    claim: {
      authorizationId: row.authorization_id,
      executionId: row.execution_id,
      authorizationFingerprint: row.authorization_fingerprint,
      credentialId: row.credential_id,
      agentId: row.agent_id,
      operatorIdentity: row.operator_identity,
      providerIdentifier: row.provider_identifier,
      generation: row.generation,
      state: row.state,
      lastAcceptedSequence: row.last_accepted_sequence,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
    },
    verifier: row.secret_verifier,
    authorizationRevokedAt: row.authorization_revoked_at,
  };
}

type ReplacementRequestBinding = {
  requestMessageId: string;
  requestNonce: string;
  requestBodyChecksum: string;
};

async function consumeReplacementRequest(input: {
  client: PoolClient;
  workspaceId: string;
  claim: ReplacementClaim;
  binding: ReplacementRequestBinding;
  requestType: string;
}): Promise<void> {
  if (
    !UUID.test(input.binding.requestMessageId) ||
    input.binding.requestNonce.length < 24 ||
    !SHA256.test(input.binding.requestBodyChecksum)
  )
    throw new Error("Replacement request replay binding is malformed.");
  await input.client.query(
    `INSERT INTO agent_protocol_receipts(
      workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      input.workspaceId,
      input.claim.agentId,
      input.binding.requestMessageId,
      input.binding.requestNonce,
      input.binding.requestBodyChecksum,
      JSON.stringify({
        type: input.requestType,
        authorizationId: input.claim.authorizationId,
        executionId: input.claim.executionId,
      }),
      input.claim.expiresAt,
    ],
  );
}

export type MutationIntentRequest = {
  authorizationId: string;
  executionId: string;
  credentialId: string;
  agentId: string;
  providerIdentifier: typeof REPLACEMENT_PROVIDER;
  authorizationFingerprint: string;
  claimGeneration: 1;
  operationId: string;
  operation: LocalReplacementOperation;
  sequence: number;
  fixedArgumentsChecksum: string;
  expectedPreconditionChecksum: string;
  expectedPostconditionChecksum: string;
};

export async function createReplacementMutationIntent(input: {
  client: PoolClient;
  workspaceId: string;
  authenticatedCredentialId: string;
  authenticatedAgentId: string;
  request: MutationIntentRequest;
  binding: ReplacementRequestBinding;
}): Promise<{ intentChecksum: string; retryPolicy: "inspect-then-once" | "never" }> {
  await input.client.query("BEGIN");
  try {
    if (
      input.request.credentialId !== input.authenticatedCredentialId ||
      input.request.agentId !== input.authenticatedAgentId
    )
      throw new Error("Mutation intent credential binding does not match the authenticated caller.");
    const locked = await lockClaim({
      client: input.client,
      workspaceId: input.workspaceId,
      ...input.request,
      allowExpired: replacementOperationDefinitions[input.request.operation]?.allowedAfterExpiration === true,
    });
    const definition = replacementOperationDefinitions[input.request.operation];
    if (
      !definition?.mutating ||
      expectedOperation(locked.claim) !== input.request.operation ||
      input.request.sequence !== locked.claim.lastAcceptedSequence + 1 ||
      input.request.fixedArgumentsChecksum !==
        fixedOperationChecksum({
          operation: input.request.operation,
          authorizationFingerprint: locked.claim.authorizationFingerprint,
          executionId: locked.claim.executionId,
          claimGeneration: locked.claim.generation,
        }) ||
      input.request.expectedPreconditionChecksum !==
        fixedConditionChecksum({
          operation: input.request.operation,
          condition: "precondition",
          authorizationFingerprint: locked.claim.authorizationFingerprint,
        }) ||
      input.request.expectedPostconditionChecksum !==
        fixedConditionChecksum({
          operation: input.request.operation,
          condition: "postcondition",
          authorizationFingerprint: locked.claim.authorizationFingerprint,
        })
    )
      throw new Error("Mutation intent is not the exact next authorized host operation.");
    await consumeReplacementRequest({
      client: input.client,
      workspaceId: input.workspaceId,
      claim: locked.claim,
      binding: input.binding,
      requestType: "replacement-bootstrap-intent",
    });
    const priorIntent = await input.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM mission_agent_replacement_mutation_intents
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
          AND sequence=$4 AND status IN ('prepared','completed')`,
      [input.workspaceId, input.request.authorizationId, input.request.executionId, input.request.sequence],
    );
    if (Number(priorIntent.rows[0]?.count ?? "0") !== 0)
      throw new Error("An active or completed mutation intent already owns this operation sequence.");
    const retryPolicy = definition.retrySafe ? "inspect-then-once" : "never";
    const intendedState =
      locked.claim.state === "rollback-required" || locked.claim.state.startsWith("rollback:")
        ? locked.claim.state
        : intentState(input.request.operation);
    const intent = {
      ...input.request,
      fromState: locked.claim.state,
      toState: intendedState,
      retryPolicy,
      rollbackObligation: definition.createsRollbackObligation,
    };
    const intentChecksum = sha256(canonicalJson(intent));
    await input.client.query(
      `INSERT INTO mission_agent_replacement_mutation_intents(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,claim_generation,
        sequence,operation,fixed_arguments_checksum,expected_precondition_checksum,
        expected_postcondition_checksum,from_state,to_state,retry_policy,rollback_obligation,
        intent_checksum,status,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'prepared',clock_timestamp())`,
      [
        input.workspaceId,
        input.request.authorizationId,
        input.request.executionId,
        input.request.operationId,
        input.request.credentialId,
        input.request.claimGeneration,
        input.request.sequence,
        input.request.operation,
        input.request.fixedArgumentsChecksum,
        input.request.expectedPreconditionChecksum,
        input.request.expectedPostconditionChecksum,
        locked.claim.state,
        intendedState,
        retryPolicy,
        definition.createsRollbackObligation,
        intentChecksum,
      ],
    );
    await input.client.query(
      `UPDATE mission_agent_replacement_execution_claims
          SET state=$4
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [input.workspaceId, input.request.authorizationId, input.request.executionId, intendedState],
    );
    await input.client.query("COMMIT");
    return { intentChecksum, retryPolicy };
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function verifyReceiptAuthentication(receipt: LocalOperationReceipt, verifier: string): void {
  const { receiptChecksum, authentication, ...unsigned } = receipt;
  const bytes = canonicalJson(unsigned);
  const expectedChecksum = sha256(bytes);
  const expectedAuthentication = createHmac("sha256", verifier).update(bytes).digest("hex");
  if (
    receiptChecksum !== expectedChecksum ||
    !SHA256.test(authentication) ||
    !timingSafeEqual(
      Uint8Array.from(Buffer.from(authentication, "hex")),
      Uint8Array.from(Buffer.from(expectedAuthentication, "hex")),
    )
  )
    throw new Error("Replacement receipt checksum or authentication is invalid.");
}

export async function consumeGovernedReplacementReceipt(input: {
  client: PoolClient;
  workspaceId: string;
  requestNonce: string;
  requestMessageId: string;
  requestBodyChecksum: string;
  credentialId: string;
  receipt: LocalOperationReceipt;
}): Promise<{ accepted: true; nextSequence: number; state: ReplacementExecutionState }> {
  await input.client.query("BEGIN");
  try {
    const receipt = input.receipt;
    const locked = await lockClaim({
      client: input.client,
      workspaceId: input.workspaceId,
      authorizationId: receipt.authorizationId,
      executionId: receipt.executionId,
      credentialId: input.credentialId,
      agentId: receipt.agentId,
      providerIdentifier: receipt.providerIdentifier,
      authorizationFingerprint: receipt.authorizationFingerprint,
      claimGeneration: receipt.claimGeneration,
      allowExpired: replacementOperationDefinitions[receipt.operation]?.allowedAfterExpiration === true,
    });
    verifyReceiptAuthentication(receipt, locked.verifier);
    if (
      input.credentialId !== receipt.credentialId ||
      input.requestNonce !== receipt.requestNonce ||
      input.requestBodyChecksum !== sha256(canonicalJson(receipt)) ||
      receipt.sequence !== locked.claim.lastAcceptedSequence + 1 ||
      expectedOperation(locked.claim) !== receipt.operation ||
      receipt.operationChecksum !==
        fixedOperationChecksum({
          operation: receipt.operation,
          authorizationFingerprint: receipt.authorizationFingerprint,
          executionId: receipt.executionId,
          claimGeneration: receipt.claimGeneration,
        })
    )
      throw new Error("Replacement receipt ownership, sequence, request, or operation binding is invalid.");
    const definition = replacementOperationDefinitions[receipt.operation];
    let intent: { status: string; expected_postcondition_checksum: string } | undefined;
    if (definition.mutating) {
      const result = await input.client.query<{
        status: string;
        expected_postcondition_checksum: string;
      }>(
        `SELECT status,expected_postcondition_checksum
           FROM mission_agent_replacement_mutation_intents
          WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND operation_id=$4
          FOR UPDATE`,
        [input.workspaceId, receipt.authorizationId, receipt.executionId, receipt.operationId],
      );
      intent = result.rows[0];
      if (!intent || intent.status !== "prepared" || receipt.resultChecksum !== intent.expected_postcondition_checksum)
        throw new Error("Mutation receipt lacks its committed intent or exact observed postcondition.");
    }
    if (receipt.operation === "drain_agent") {
      const drain = await input.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM mission_agent_replacement_evidence
          WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
            AND evidence_type='drain' AND expires_at>clock_timestamp()`,
        [input.workspaceId, receipt.authorizationId, receipt.executionId],
      );
      if (Number(drain.rows[0]?.count ?? "0") !== 1)
        throw new Error("Authoritative Mission Control drain evidence is absent.");
    }
    if (["verify_runtime", "verify_version", "verify_capabilities"].includes(receipt.operation))
      await persistValidatedProcessObservation({
        client: input.client,
        workspaceId: input.workspaceId,
        claim: locked.claim,
        receipt,
        rollback: false,
      });
    if (["restart_prior_service", "verify_prior_runtime"].includes(receipt.operation))
      await persistValidatedProcessObservation({
        client: input.client,
        workspaceId: input.workspaceId,
        claim: locked.claim,
        receipt,
        rollback: true,
      });
    if (receipt.operation === "verify_prior_projection")
      await requireRollbackEquivalence({
        client: input.client,
        workspaceId: input.workspaceId,
        claim: locked.claim,
      });
    if (receipt.operation === "report_evidence" && locked.claim.state.startsWith("rollback:")) {
      const equivalence = await input.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM mission_agent_replacement_evidence
          WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
            AND evidence_type='rollback-equivalence'`,
        [input.workspaceId, receipt.authorizationId, receipt.executionId],
      );
      if (Number(equivalence.rows[0]?.count ?? "0") !== 1)
        throw new Error("Rollback cannot complete without exact prior-runtime equivalence.");
    }
    if (receipt.operation === "verify_heartbeats" || receipt.operation === "verify_capabilities")
      await requireFreshHeartbeatCapabilitiesAndProjection({
        client: input.client,
        workspaceId: input.workspaceId,
        claim: locked.claim,
      });
    const smoke = await input.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM mission_agent_replacement_evidence
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
          AND evidence_type='smoke' AND expires_at>clock_timestamp()`,
      [input.workspaceId, receipt.authorizationId, receipt.executionId],
    );
    const nextState = stateAfterAcceptedOperation({
      state: locked.claim.state,
      operation: receipt.operation,
      smokeAccepted: Number(smoke.rows[0]?.count ?? "0") === 1,
    });
    await input.client.query(
      `INSERT INTO mission_agent_replacement_receipts(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,agent_id,
        provider_identifier,authorization_fingerprint,claim_generation,sequence,request_nonce,
        receipt_nonce,operation,operation_checksum,result_checksum,host_journal_checksum,
        authentication_tag,received_at,acknowledgement
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp(),$18::jsonb)`,
      [
        input.workspaceId,
        receipt.authorizationId,
        receipt.executionId,
        receipt.operationId,
        receipt.credentialId,
        receipt.agentId,
        receipt.providerIdentifier,
        receipt.authorizationFingerprint,
        receipt.claimGeneration,
        receipt.sequence,
        receipt.requestNonce,
        receipt.receiptNonce,
        receipt.operation,
        receipt.operationChecksum,
        receipt.resultChecksum,
        receipt.hostJournalChecksum,
        receipt.authentication,
        JSON.stringify({ accepted: true, state: nextState, recovery: receipt.recovery }),
      ],
    );
    await input.client.query(
      `INSERT INTO agent_protocol_receipts(
        workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        input.workspaceId,
        receipt.agentId,
        input.requestMessageId,
        input.requestNonce,
        input.requestBodyChecksum,
        JSON.stringify({
          type: "replacement-bootstrap-request-consumed",
          authorizationId: receipt.authorizationId,
          executionId: receipt.executionId,
          operationId: receipt.operationId,
          sequence: receipt.sequence,
        }),
        locked.claim.expiresAt,
      ],
    );
    if (definition.mutating)
      await input.client.query(
        `UPDATE mission_agent_replacement_mutation_intents
            SET status='completed',completed_at=clock_timestamp(),result_checksum=$5,
                host_journal_checksum=$6
          WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND operation_id=$4`,
        [
          input.workspaceId,
          receipt.authorizationId,
          receipt.executionId,
          receipt.operationId,
          receipt.resultChecksum,
          receipt.hostJournalChecksum,
        ],
      );
    await input.client.query(
      `UPDATE mission_agent_replacement_execution_claims
          SET state=$4,last_accepted_sequence=$5,
              completed_at=CASE WHEN $4 IN ('completed','rolled-back') THEN clock_timestamp() ELSE completed_at END
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [input.workspaceId, receipt.authorizationId, receipt.executionId, nextState, receipt.sequence],
    );
    if (["completed", "rolled-back"].includes(nextState)) {
      await input.client.query(
        `UPDATE mission_agent_replacement_credentials
            SET consumed_at=clock_timestamp()
          WHERE workspace_id=$1 AND credential_id=$2`,
        [input.workspaceId, receipt.credentialId],
      );
      await input.client.query(
        `UPDATE agent_credentials
            SET status='revoked',revoked_at=clock_timestamp()
          WHERE workspace_id=$1 AND credential_id=$2`,
        [input.workspaceId, receipt.credentialId],
      );
      await input.client.query(
        `UPDATE mission_agent_replacement_bootstraps
            SET state=$2,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND authorization_id=$3`,
        [input.workspaceId, nextState === "completed" ? "completed" : "rolled_back", receipt.authorizationId],
      );
    }
    await input.client.query("COMMIT");
    return { accepted: true, nextSequence: receipt.sequence + 1, state: nextState };
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function persistIssuedReplacementPackage(input: {
  client: PoolClient;
  pkg: ReplacementAuthorizationPackage;
}): Promise<void> {
  const result = await input.client.query(
    `SELECT 1
       FROM mission_agent_replacement_execution_claims c
       JOIN mission_agent_replacement_credentials rc
         ON rc.workspace_id=c.workspace_id AND rc.credential_id=c.credential_id
      WHERE c.workspace_id=$1 AND c.authorization_id=$2 AND c.execution_id=$3
        AND c.credential_id=$4 AND c.authorization_fingerprint=$5
        AND c.generation=1 AND c.completed_at IS NULL
        AND rc.expires_at>clock_timestamp()`,
    [
      input.pkg.authorization.workspaceId,
      input.pkg.authorization.authorizationId,
      input.pkg.executionId,
      input.pkg.credentialId,
      input.pkg.authorizationFingerprint,
    ],
  );
  if (result.rowCount !== 1) throw new Error("Package issuance has no matching active execution owner.");
  await input.client.query(
    `INSERT INTO agent_protocol_receipts(
      workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      input.pkg.authorization.workspaceId,
      input.pkg.authorization.agentId,
      input.pkg.executionId,
      input.pkg.nonce,
      input.pkg.packageChecksum,
      JSON.stringify({
        type: "replacement-bootstrap-package-issued",
        authorizationId: input.pkg.authorization.authorizationId,
        executionId: input.pkg.executionId,
        credentialId: input.pkg.credentialId,
        authorizationFingerprint: input.pkg.authorizationFingerprint,
        providerIdentifier: REPLACEMENT_PROVIDER,
        claimGeneration: 1,
        maximumUseCount: 1,
      }),
      input.pkg.expiresAt,
    ],
  );
}

export async function confirmReplacementPackageClaim(input: {
  client: PoolClient;
  workspaceId: string;
  agentId: string;
  credentialId: string;
  requestMessageId: string;
  requestNonce: string;
  requestBodyChecksum: string;
  body: unknown;
}): Promise<{ claimed: true; nextSequence: 1; claimGeneration: 1 }> {
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body))
    throw new Error("Replacement package claim is malformed.");
  const body = input.body as Record<string, unknown>;
  if (
    canonicalJson(Object.keys(body).sort()) !==
      canonicalJson(["authorizationId", "executionId", "packageChecksum", "nonce"].sort()) ||
    !UUID.test(String(body.authorizationId)) ||
    !UUID.test(String(body.executionId)) ||
    !SHA256.test(String(body.packageChecksum))
  )
    throw new Error("Replacement package claim binding is malformed.");
  await input.client.query("BEGIN");
  try {
    const claim = await lockClaim({
      client: input.client,
      workspaceId: input.workspaceId,
      authorizationId: String(body.authorizationId),
      executionId: String(body.executionId),
      credentialId: input.credentialId,
      agentId: input.agentId,
      providerIdentifier: REPLACEMENT_PROVIDER,
      authorizationFingerprint:
        (
          await input.client.query<{ authorization_fingerprint: string }>(
            `SELECT authorization_fingerprint
             FROM mission_agent_replacement_execution_claims
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
            [input.workspaceId, body.authorizationId, body.executionId],
          )
        ).rows[0]?.authorization_fingerprint ?? "",
      claimGeneration: 1,
    });
    if (claim.claim.state !== "claimed" || claim.claim.lastAcceptedSequence !== 0)
      throw new Error("Replacement execution is not at its initial claim boundary.");
    const issued = await input.client.query<{
      body_checksum: string;
      nonce: string;
      acknowledgement: Record<string, unknown>;
    }>(
      `SELECT body_checksum,nonce,acknowledgement
         FROM agent_protocol_receipts
        WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3
        FOR UPDATE`,
      [input.workspaceId, input.agentId, body.executionId],
    );
    const packageRecord = issued.rows[0];
    if (
      !packageRecord ||
      packageRecord.body_checksum !== body.packageChecksum ||
      packageRecord.nonce !== body.nonce ||
      packageRecord.acknowledgement.type !== "replacement-bootstrap-package-issued" ||
      packageRecord.acknowledgement.credentialId !== input.credentialId ||
      packageRecord.acknowledgement.authorizationFingerprint !== claim.claim.authorizationFingerprint
    )
      throw new Error("Replacement package was not issued to the active execution owner.");
    await input.client.query(
      `INSERT INTO agent_protocol_receipts(
        workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        input.workspaceId,
        input.agentId,
        input.requestMessageId,
        input.requestNonce,
        input.requestBodyChecksum,
        JSON.stringify({
          type: "replacement-bootstrap-package-claimed",
          authorizationId: claim.claim.authorizationId,
          executionId: claim.claim.executionId,
          credentialId: claim.claim.credentialId,
          claimGeneration: 1,
        }),
        claim.claim.expiresAt,
      ],
    );
    await input.client.query("COMMIT");
    return { claimed: true, nextSequence: 1, claimGeneration: 1 };
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function establishAuthoritativeReplacementDrain(input: {
  client: PoolClient;
  workspaceId: string;
  authorizationId: string;
  executionId: string;
  agentId: string;
  stabilizationMs?: number;
}): Promise<{ drainEvidenceChecksum: string }> {
  const requested = await input.client.query<{ requested_at: Date; expires_at: Date }>(
    `SELECT clock_timestamp() requested_at,expires_at
       FROM mission_agent_replacement_execution_claims
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
        AND agent_id=$4 AND completed_at IS NULL`,
    [input.workspaceId, input.authorizationId, input.executionId, input.agentId],
  );
  const drainRequestedAt = requested.rows[0]?.requested_at;
  if (!(drainRequestedAt instanceof Date)) throw new Error("Drain is not bound to the active replacement execution.");
  const inspect = async () => {
    const result = await input.client.query<{
      active_assignments: string;
      active_executions: string;
      targeted_outbox: string;
      targeted_jobs: string;
      active_publications: string;
      pending_actions: string;
      pending_approvals: string;
      assignments_created_during_drain: string;
      executions_created_during_drain: string;
      latest_heartbeat: Date | null;
    }>(
      `SELECT
        (SELECT count(*)::text FROM pull_assignments
          WHERE workspace_id=$1 AND agent_id=$2
            AND (status IN ('leased','acknowledged') OR
                 (status='available' AND created_at<=clock_timestamp()))) active_assignments,
        (SELECT count(*)::text FROM execution_projections
          WHERE workspace_id=$1 AND agent_id=$2
            AND status IN ('requested','accepted','running','waiting_for_approval','paused')) active_executions,
        (SELECT count(*)::text FROM outbox
          WHERE workspace_id=$1 AND status IN ('pending','processing','failed')
            AND payload->>'agentId'=$2::text) targeted_outbox,
        (SELECT count(*)::text FROM jobs
          WHERE workspace_id=$1 AND status IN ('pending','processing','failed')
            AND payload->>'agentId'=$2::text) targeted_jobs,
        (SELECT count(*)::text FROM publication_assignments
          WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('available','claimed','pushed')) active_publications,
        (SELECT count(*)::text FROM action_request_projections
          WHERE workspace_id=$1 AND agent_id=$2
            AND status IN ('requested','evaluating','waiting_for_approval','approved','executing')) pending_actions,
        (SELECT count(*)::text FROM approval_projections
          WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('pending','granted')) pending_approvals,
        (SELECT count(*)::text FROM pull_assignments
          WHERE workspace_id=$1 AND agent_id=$2 AND created_at>$3) assignments_created_during_drain,
        (SELECT count(*)::text FROM execution_projections
          WHERE workspace_id=$1 AND agent_id=$2 AND created_at>$3) executions_created_during_drain,
        (SELECT last_heartbeat_at FROM agents WHERE workspace_id=$1 AND agent_id=$2) latest_heartbeat`,
      [input.workspaceId, input.agentId, drainRequestedAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Authoritative drain query returned no state.");
    return {
      activeAssignments: Number(row.active_assignments),
      activeExecutions: Number(row.active_executions),
      targetedOutbox: Number(row.targeted_outbox),
      targetedJobs: Number(row.targeted_jobs),
      activePublications: Number(row.active_publications),
      pendingActions: Number(row.pending_actions),
      pendingApprovals: Number(row.pending_approvals),
      assignmentsCreatedDuringDrain: Number(row.assignments_created_during_drain),
      executionsCreatedDuringDrain: Number(row.executions_created_during_drain),
      latestHeartbeat: row.latest_heartbeat?.toISOString() ?? null,
    };
  };
  const first = await inspect();
  const stabilizationMs = input.stabilizationMs ?? 5_000;
  if (stabilizationMs < 1_000 || stabilizationMs > 30_000)
    throw new Error("Drain stabilization window is outside the reviewed bounds.");
  await new Promise((resolve) => setTimeout(resolve, stabilizationMs));
  const second = await inspect();
  for (const snapshot of [first, second])
    if (
      snapshot.activeAssignments !== 0 ||
      snapshot.activeExecutions !== 0 ||
      snapshot.targetedOutbox !== 0 ||
      snapshot.targetedJobs !== 0 ||
      snapshot.activePublications !== 0 ||
      snapshot.pendingActions !== 0 ||
      snapshot.pendingApprovals !== 0 ||
      snapshot.assignmentsCreatedDuringDrain !== 0 ||
      snapshot.executionsCreatedDuringDrain !== 0 ||
      snapshot.latestHeartbeat === null
    )
      throw new Error("Named Mission Agent did not remain authoritatively drained.");
  const eligibility = await input.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM mission_agent_replacement_execution_claims
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
        AND agent_id=$4 AND completed_at IS NULL`,
    [input.workspaceId, input.authorizationId, input.executionId, input.agentId],
  );
  if (Number(eligibility.rows[0]?.count ?? "0") !== 1)
    throw new Error("Drain is not bound to the active replacement execution.");
  const evidence = {
    evidenceVersion: "replacement-authoritative-drain-v1",
    authorizationId: input.authorizationId,
    executionId: input.executionId,
    agentId: input.agentId,
    assignmentEligibilityBlockedByExecutionClaim: true,
    first,
    second,
    drainRequestedAt: drainRequestedAt.toISOString(),
    stabilizationMs,
  };
  const drainEvidenceChecksum = sha256(canonicalJson(evidence));
  await input.client.query(
    `INSERT INTO mission_agent_replacement_evidence(
      workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
      observed_at,expires_at
    )
    SELECT $1,$2,$3,'drain',$4,$5::jsonb,clock_timestamp(),expires_at
      FROM mission_agent_replacement_execution_claims
     WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
    [input.workspaceId, input.authorizationId, input.executionId, drainEvidenceChecksum, JSON.stringify(evidence)],
  );
  return { drainEvidenceChecksum };
}

export async function readReplacementRecoveryState(input: {
  client: PoolClient;
  workspaceId: string;
  agentId: string;
  credentialId: string;
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  claimGeneration: 1;
  binding: ReplacementRequestBinding;
}): Promise<{
  state: ReplacementExecutionState;
  lastAcceptedSequence: number;
  lastAcceptedOperation: LocalReplacementOperation | null;
  pendingIntent: {
    operationId: string;
    operation: LocalReplacementOperation;
    sequence: number;
    retryPolicy: "inspect-then-once" | "never";
    intentChecksum: string;
    expectedPostconditionChecksum: string;
  } | null;
}> {
  await input.client.query("BEGIN");
  try {
    const locked = await lockClaim({
      client: input.client,
      workspaceId: input.workspaceId,
      authorizationId: input.authorizationId,
      executionId: input.executionId,
      credentialId: input.credentialId,
      agentId: input.agentId,
      providerIdentifier: REPLACEMENT_PROVIDER,
      authorizationFingerprint: input.authorizationFingerprint,
      claimGeneration: input.claimGeneration,
      allowExpired: true,
    });
    await consumeReplacementRequest({
      client: input.client,
      workspaceId: input.workspaceId,
      claim: locked.claim,
      binding: input.binding,
      requestType: "replacement-bootstrap-status",
    });
    const receipt = await input.client.query<{ operation: LocalReplacementOperation }>(
      `SELECT operation
         FROM mission_agent_replacement_receipts
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
        ORDER BY sequence DESC LIMIT 1`,
      [input.workspaceId, input.authorizationId, input.executionId],
    );
    const intent = await input.client.query<{
      operation_id: string;
      operation: LocalReplacementOperation;
      sequence: number;
      retry_policy: "inspect-then-once" | "never";
      intent_checksum: string;
      expected_postcondition_checksum: string;
    }>(
      `SELECT operation_id,operation,sequence,retry_policy,intent_checksum,expected_postcondition_checksum
         FROM mission_agent_replacement_mutation_intents
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND status='prepared'
        ORDER BY sequence DESC LIMIT 1`,
      [input.workspaceId, input.authorizationId, input.executionId],
    );
    await input.client.query("COMMIT");
    const pending = intent.rows[0];
    return {
      state: locked.claim.state,
      lastAcceptedSequence: locked.claim.lastAcceptedSequence,
      lastAcceptedOperation: receipt.rows[0]?.operation ?? null,
      pendingIntent: pending
        ? {
            operationId: pending.operation_id,
            operation: pending.operation,
            sequence: pending.sequence,
            retryPolicy: pending.retry_policy,
            intentChecksum: pending.intent_checksum,
            expectedPostconditionChecksum: pending.expected_postcondition_checksum,
          }
        : null,
    };
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function requireReplacementRollback(input: {
  client: PoolClient;
  workspaceId: string;
  agentId: string;
  credentialId: string;
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  claimGeneration: 1;
  failureChecksum: string;
  binding: ReplacementRequestBinding;
}): Promise<{ rollbackRequired: true; nextOperation: "restore_artifact" }> {
  if (!SHA256.test(input.failureChecksum)) throw new Error("Replacement failure checksum is malformed.");
  await input.client.query("BEGIN");
  try {
    const locked = await lockClaim({
      client: input.client,
      workspaceId: input.workspaceId,
      authorizationId: input.authorizationId,
      executionId: input.executionId,
      credentialId: input.credentialId,
      agentId: input.agentId,
      providerIdentifier: REPLACEMENT_PROVIDER,
      authorizationFingerprint: input.authorizationFingerprint,
      claimGeneration: input.claimGeneration,
      allowExpired: true,
    });
    await consumeReplacementRequest({
      client: input.client,
      workspaceId: input.workspaceId,
      claim: locked.claim,
      binding: input.binding,
      requestType: "replacement-bootstrap-failure",
    });
    if (locked.claim.state === "rollback-required" || locked.claim.state.startsWith("rollback:")) {
      await input.client.query("COMMIT");
      return { rollbackRequired: true, nextOperation: "restore_artifact" };
    }
    if (["claimed", "completed", "rolled-back"].includes(locked.claim.state))
      throw new Error("Replacement execution cannot enter rollback from its current state.");
    await input.client.query(
      `UPDATE mission_agent_replacement_mutation_intents
          SET status='abandoned'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND status='prepared'`,
      [input.workspaceId, input.authorizationId, input.executionId],
    );
    await input.client.query(
      `UPDATE mission_agent_replacement_execution_claims
          SET state='rollback-required'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [input.workspaceId, input.authorizationId, input.executionId],
    );
    await input.client.query(
      `UPDATE mission_agent_replacement_bootstraps
          SET state='rolling_back',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND authorization_id=$2`,
      [input.workspaceId, input.authorizationId],
    );
    await input.client.query(
      `INSERT INTO agent_protocol_receipts(
        workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        input.workspaceId,
        input.agentId,
        randomUUID(),
        `rollback-${input.executionId}`,
        input.failureChecksum,
        JSON.stringify({
          type: "replacement-bootstrap-rollback-required",
          authorizationId: input.authorizationId,
          executionId: input.executionId,
          claimGeneration: input.claimGeneration,
          failureChecksum: input.failureChecksum,
        }),
        locked.claim.expiresAt,
      ],
    );
    await input.client.query("COMMIT");
    return { rollbackRequired: true, nextOperation: "restore_artifact" };
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function authorizeReplacementSmokePoll(input: {
  client: PoolClient;
  workspaceId: string;
  agentId: string;
  credentialId: string;
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  claimGeneration: 1;
  binding: ReplacementRequestBinding;
}): Promise<void> {
  await input.client.query("BEGIN");
  try {
    const locked = await lockClaim({
      client: input.client,
      workspaceId: input.workspaceId,
      authorizationId: input.authorizationId,
      executionId: input.executionId,
      credentialId: input.credentialId,
      agentId: input.agentId,
      providerIdentifier: REPLACEMENT_PROVIDER,
      authorizationFingerprint: input.authorizationFingerprint,
      claimGeneration: input.claimGeneration,
    });
    if (!["awaiting-authoritative-smoke", "ready:report_evidence"].includes(locked.claim.state))
      throw new Error("Replacement execution is not awaiting its governed smoke.");
    await consumeReplacementRequest({
      client: input.client,
      workspaceId: input.workspaceId,
      claim: locked.claim,
      binding: input.binding,
      requestType: "replacement-bootstrap-smoke-poll",
    });
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
