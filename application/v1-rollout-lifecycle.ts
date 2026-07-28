import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createV1OperatorGrant, type V1OperatorGrant } from "./v1-macos-operator-grant";
import type { V1OperatorBinding, V1OperatorOperation } from "./v1-macos-operator-journal";
import { canonicalJson, sha256 } from "./v1-production-runtime-identity";
import { isV1HandlerAction, type V1HandlerName } from "./v1-rollout-contract";
import { verifyV1HostBoundPayload } from "./v1-operator-host-identity";
import { getV1ControllerDatabasePool } from "../lib/v1-controller-database";

type AuthenticatedEnvelope = {
  workspaceId: string;
  credentialId: string;
  agentId: string;
  requestMessageId: string;
  requestNonce: string;
  requestBodyChecksum: string;
};

type V1LifecycleRequest = {
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  claimGeneration: 1;
  action: string;
  expectedState: string;
  expectedSequence: number;
  fencingGeneration: number;
  eventId: string;
  [name: string]: unknown;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMON_FIELDS = [
  "action",
  "authorizationFingerprint",
  "authorizationId",
  "claimGeneration",
  "eventId",
  "executionId",
  "expectedSequence",
  "expectedState",
  "fencingGeneration",
] as const;
const ACTION_FIELDS: Record<string, readonly string[]> = {
  preflight: [],
  request_drain: [],
  verify_drain: ["drainEvidenceChecksum"],
  acquire_lease: [],
  renew_lease: [],
  adopt_recovery_controller: ["controllerEvidenceChecksum", "newControllerDeploymentId"],
  propose_grant: [],
  commit_mutation_intent: [
    "expectedPostconditionChecksum",
    "expectedPreconditionChecksum",
    "fixedArgumentsChecksum",
    "fromState",
    "grantId",
    "intentChecksum",
    "operation",
    "operationId",
    "toState",
  ],
  record_grant_delivery: ["grantChecksum", "grantId"],
  acknowledge_grant: [
    "acknowledgementChecksum",
    "grantChecksum",
    "grantId",
    "hostSignature",
    "operatorJournalChecksum",
  ],
  operator_journal_head: [
    "grantId",
    "operatorJournalChecksum",
    "operatorRequestChecksum",
    "operatorRequestMessageId",
    "operatorRequestNonce",
  ],
  anchor_durable_receipt: ["grantId", "hostSignature", "providerMutationId", "receiptChecksum"],
  runtime_status: ["evidenceType", "sourceEvidenceChecksum"],
  rollback_observation: ["hostSignature", "observedAt", "processEvidence"],
  accept_provider_receipt: [
    "authenticatedReceiptTag",
    "errorClassification",
    "executedAt",
    "grantId",
    "hostSignature",
    "localJournalEntryId",
    "operation",
    "operatorJournalChecksum",
    "operatorRequestMessageId",
    "operatorRequestNonce",
    "outcome",
    "priorOperatorJournalChecksum",
    "priorStateChecksum",
    "providerMutationId",
    "receiptBytes",
    "receiptChecksum",
    "resultingStateChecksum",
    "verificationEvidenceChecksum",
  ],
  verify_provider_receipt: [],
  expire_grant: ["grantChecksum", "grantId"],
  revoke_grant: ["grantChecksum", "grantId", "revocationReasonChecksum"],
  continue_forward: [],
  continue_rollback: [],
  observe_stability: [],
  evaluate_stability: [],
  close_success: ["heartbeatChecksum", "inventoryChecksum", "processChecksum", "projectionChecksum"],
  close_rollback: ["heartbeatChecksum", "inventoryChecksum", "processChecksum", "projectionChecksum"],
  activate_rollback: ["failureChecksum"],
  require_human_intervention: ["failureChecksum"],
};

export function parseV1LifecycleRequest(handler: V1HandlerName, value: unknown): V1LifecycleRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("V1 lifecycle request must be an object.");
  const request = value as V1LifecycleRequest;
  const allowed = new Set([...COMMON_FIELDS, ...(ACTION_FIELDS[String(request.action)] ?? [])]);
  if (
    !UUID.test(String(request.authorizationId)) ||
    !UUID.test(String(request.executionId)) ||
    !UUID.test(String(request.eventId)) ||
    !SHA256.test(String(request.authorizationFingerprint)) ||
    request.claimGeneration !== 1 ||
    !isV1HandlerAction(handler, request.action) ||
    typeof request.expectedState !== "string" ||
    !Number.isSafeInteger(request.expectedSequence) ||
    request.expectedSequence < 0 ||
    !Number.isSafeInteger(request.fencingGeneration) ||
    request.fencingGeneration < 1 ||
    Object.keys(request).some((name) => !allowed.has(name as never))
  )
    throw new Error("V1 lifecycle request envelope is malformed.");
  return request;
}

export async function executeV1LifecycleHandler(input: {
  client: PoolClient;
  handler: V1HandlerName;
  envelope: AuthenticatedEnvelope;
  request: V1LifecycleRequest;
}): Promise<Record<string, unknown>> {
  if (input.handler === "claim" && input.request.action === "adopt_recovery_controller") {
    const adopted = await getV1ControllerDatabasePool().query<{ generation: string }>(
      `SELECT adopt_mission_agent_v1_recovery_controller(
        $1,$2,$3,$4,$5,$6,$7,$8
      )::text generation`,
      [
        input.envelope.workspaceId,
        input.request.authorizationId,
        input.request.executionId,
        input.request.newControllerDeploymentId,
        input.request.fencingGeneration,
        input.envelope.requestMessageId,
        input.envelope.requestNonce,
        input.request.controllerEvidenceChecksum,
      ],
    );
    return { adopted: true, fencingGeneration: Number(adopted.rows[0]?.generation) };
  }
  if (
    (input.handler === "status" &&
      ["acknowledge_grant", "anchor_durable_receipt", "rollback_observation"].includes(input.request.action)) ||
    (input.handler === "receipt" && input.request.action === "accept_provider_receipt")
  ) {
    const host = await input.client.query<{ public_key_spki: string }>(
      `SELECT h.public_key_spki
         FROM mission_agent_v1_rollout_operations r
         JOIN mission_agent_v1_host_identities h
           ON h.workspace_id=r.workspace_id AND h.host_id=r.host_id AND h.status='active'
        WHERE r.workspace_id=$1 AND r.authorization_id=$2 AND r.execution_id=$3`,
      [input.envelope.workspaceId, input.request.authorizationId, input.request.executionId],
    );
    if (!host.rows[0]) throw new Error("V1 enrolled operator host identity is unavailable.");
    const { hostSignature, ...signedRequest } = input.request;
    verifyV1HostBoundPayload({
      payload: signedRequest,
      signature: String(hostSignature),
      publicKeySpki: host.rows[0].public_key_spki,
    });
  }
  const result = await getV1ControllerDatabasePool().query<{ result: Record<string, unknown> }>(
    `SELECT execute_mission_agent_v1_handler(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9::uuid,$10,$11
     ) result`,
    [
      input.envelope.workspaceId,
      input.envelope.credentialId,
      input.envelope.agentId,
      input.request.authorizationId,
      input.request.executionId,
      input.handler,
      input.request.action,
      JSON.stringify(input.request),
      input.envelope.requestMessageId,
      input.envelope.requestNonce,
      input.envelope.requestBodyChecksum,
    ],
  );
  if (!result.rows[0]) throw new Error("V1 lifecycle transition produced no canonical result.");
  return result.rows[0].result;
}

export async function issueGovernedV1OperatorGrant(input: {
  client: PoolClient;
  credentialId: string;
  credentialVerifier: string;
  request: V1LifecycleRequest;
  missionControlUrl: string;
}): Promise<{ request: V1LifecycleRequest; grant: V1OperatorGrant }> {
  if (input.request.action !== "propose_grant") throw new Error("V1 grant issuance action is invalid.");
  const result = await input.client.query<{
    authorization_id: string;
    execution_id: string;
    agent_id: string;
    operator_id: string;
    authorization_fingerprint: string;
    target_artifact_checksum: string;
    prior_inventory_checksum: string;
    rollback_obligation_id: string;
    deployment_id: string;
    current_controller_deployment_id: string;
    configuration_version: string;
    initial_fencing_epoch: string;
    fencing_generation: string;
    lifecycle_sequence: string;
    forward_expires_at: Date;
    host_fingerprint: string;
    operator_artifact_checksum: string;
    operator_protocol_version: string;
    operation: V1OperatorOperation;
    operation_sequence: string;
    grant_kind: "forward" | "rollback" | "recovery";
  }>(
    `SELECT r.authorization_id::text,r.execution_id::text,r.agent_id::text,r.operator_id::text,
            r.authorization_fingerprint,r.target_artifact_checksum,r.prior_inventory_checksum,
            r.rollback_obligation_id::text,r.deployment_id::text,
            r.current_controller_deployment_id::text,c.version::text configuration_version,
            r.initial_fencing_epoch::text,
            (SELECT max(f.epoch)::text FROM mission_agent_v1_fencing_epochs f
              WHERE f.workspace_id=r.workspace_id AND f.authorization_id=r.authorization_id
                AND f.execution_id=r.execution_id AND f.fencing_namespace=r.fencing_namespace
            ) fencing_generation,r.lifecycle_sequence::text,r.forward_expires_at,
            h.public_key_fingerprint host_fingerprint,release.artifact_checksum operator_artifact_checksum,
            release.protocol_version operator_protocol_version,
            CASE
              WHEN r.state='forward_active' THEN
                (ARRAY['stage_artifact','stop_agent','install_agent','install_launch_configuration','start_agent'])
                [(SELECT count(*)::int+1 FROM mission_agent_v1_provider_mutations m
                   WHERE m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
                     AND m.execution_id=r.execution_id AND m.phase='forward')]
              ELSE o.required_inverse_operations->>(
                SELECT count(*)::int FROM mission_agent_v1_provider_mutations m
                 WHERE m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
                   AND m.execution_id=r.execution_id AND m.phase='rollback'
              )
            END operation,
            CASE WHEN r.state='forward_active'
              THEN (SELECT count(*)::int+1 FROM mission_agent_v1_provider_mutations m
                     WHERE m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
                       AND m.execution_id=r.execution_id AND m.phase='forward')
              ELSE (SELECT count(*)::int+1 FROM mission_agent_v1_provider_mutations m
                     WHERE m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
                       AND m.execution_id=r.execution_id)
            END::text operation_sequence,
            CASE WHEN r.state='forward_active' THEN 'forward' ELSE 'rollback' END grant_kind
       FROM mission_agent_v1_rollout_operations r
       JOIN mission_agent_v1_operator_identities i
         ON i.workspace_id=r.workspace_id AND i.operator_id=r.operator_id AND i.credential_id=$1
       JOIN mission_agent_v1_operator_releases release ON release.release_id=i.operator_release_id
       JOIN mission_agent_v1_host_identities h
         ON h.workspace_id=i.workspace_id AND h.host_id=i.host_id
       JOIN mission_control_v1_production_configurations c ON c.configuration_id=r.configuration_id
       LEFT JOIN mission_agent_v1_rollback_obligations o
         ON o.workspace_id=r.workspace_id AND o.authorization_id=r.authorization_id
        AND o.execution_id=r.execution_id AND o.obligation_id=r.rollback_obligation_id
      WHERE r.authorization_id=$2 AND r.execution_id=$3
        AND r.authorization_fingerprint=$4
        AND r.state IN ('forward_active','recovery_only')
        AND release.status='approved' AND h.status='active'`,
    [
      input.credentialId,
      input.request.authorizationId,
      input.request.executionId,
      input.request.authorizationFingerprint,
    ],
  );
  const row = result.rows[0];
  if (
    !row ||
    !row.operation ||
    Number(row.lifecycle_sequence) !== input.request.expectedSequence ||
    Number(row.fencing_generation) !== input.request.fencingGeneration ||
    (row.grant_kind === "forward" && row.forward_expires_at.getTime() <= Date.now())
  )
    throw new Error("No canonical V1 operator grant is currently issuable.");
  const binding: V1OperatorBinding = {
    authorizationId: row.authorization_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    targetArtifactSha256: row.target_artifact_checksum,
    priorInventorySha256: row.prior_inventory_checksum,
    authorizationFingerprint: row.authorization_fingerprint,
    fencingGeneration: Number(row.initial_fencing_epoch),
    operatorId: row.operator_id,
    missionControlDeploymentId: row.deployment_id,
    rollbackObligationId: row.rollback_obligation_id,
  };
  const issuedAt = new Date();
  const expiresAt = new Date(
    row.grant_kind === "forward"
      ? Math.min(issuedAt.getTime() + 10 * 60_000, row.forward_expires_at.getTime())
      : issuedAt.getTime() + 10 * 60_000,
  );
  const grant = createV1OperatorGrant(
    {
      schemaVersion: "mission-agent-v1-operator-grant-v1",
      grantId: randomUUID(),
      grantKind: row.grant_kind,
      binding,
      credentialId: input.credentialId,
      operationId: randomUUID(),
      providerMutationId: randomUUID(),
      sequence: Number(row.operation_sequence),
      lifecycleSequence: Number(row.lifecycle_sequence) + 1,
      hostFingerprint: row.host_fingerprint,
      operatorArtifactSha256: row.operator_artifact_checksum,
      operatorProtocolVersion: row.operator_protocol_version,
      configurationVersion: Number(row.configuration_version),
      originatingForwardDeploymentId: row.deployment_id,
      currentControllerDeploymentId: row.current_controller_deployment_id,
      currentControllerFencingGeneration: Number(row.fencing_generation),
      rollbackObligationId: row.rollback_obligation_id,
      approvedExecutableChecksum: row.operator_artifact_checksum,
      allowedOperation: row.operation,
      missionControlUrl: input.missionControlUrl,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    input.credentialVerifier,
  );
  const grantBytes = canonicalJson(grant);
  return {
    grant,
    request: {
      ...input.request,
      grantId: grant.grantId,
      grantKind: grant.grantKind,
      operationId: grant.operationId,
      providerMutationId: grant.providerMutationId,
      operation: grant.allowedOperation,
      operationSequence: grant.sequence,
      grantChecksum: sha256(grantBytes),
      grantBytes,
      grantExpiresAt: grant.expiresAt,
    },
  };
}
