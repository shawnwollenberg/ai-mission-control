import { getDatabasePool } from "@/lib/database";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import { projectBrainOperationPolicy, projectBrainRequestFingerprint } from "./governance";
import { assertCompatibleRemoteProjectBrain, validateRemoteProjectBrainCapabilities } from "./remote-protocol";
import type { ProjectBrainOperation } from "./types";
import { consumeApproval } from "@/application/approval-commands";
import { createRemoteProjectBrainAssignment } from "@/application/remote-project-brain-assignments";
import { appendProjectBrainOperationEvent } from "@/application/project-brain-commands";
import { stableUuid } from "@/lib/stable-id";

type Row = {
  operation_id: string;
  repository_id: string;
  mission_id: string | null;
  execution_id: string | null;
  agent_id: string;
  operation: ProjectBrainOperation;
  request: Record<string, unknown>;
  request_fingerprint: string;
  starting_sha: string;
  required_project_brain_version: string;
  required_contract_version: string;
  approval_id: string | null;
  policy_decision: Record<string, unknown>;
  local_path: string;
  repository_fingerprint: string;
  observed_commit: string;
  project_brain_enabled: boolean;
  read_allowed: boolean;
  write_allowed: boolean;
  commit_allowed: boolean;
  disabled_at: Date | null;
  allowed_agent_ids: string[];
  agent_status: string;
  capabilities: string[];
  remote_project_brain_capabilities: Record<string, unknown> | null;
  remote_project_brain_capabilities_at: Date | null;
  mission_agent_artifact_checksum: string | null;
  mission_agent_expected_checksum: string | null;
  mission_agent_checksum_status: string;
  mission_agent_capability_expires_at: Date | null;
  secret_verifier: string;
};

export async function dispatchRemoteProjectBrainOperation(input: {
  workspaceId: string;
  operationId: string;
  workerId: string;
}) {
  const row = (
    await getDatabasePool().query<Row>(
      `SELECT p.*,r.local_path,r.repository_fingerprint,r.observed_commit,r.project_brain_enabled,
        r.read_allowed,r.write_allowed,r.commit_allowed,r.disabled_at,r.allowed_agent_ids,a.status agent_status,
        a.capabilities,a.remote_project_brain_capabilities,a.remote_project_brain_capabilities_at,
        a.mission_agent_artifact_checksum,a.mission_agent_expected_checksum,
        a.mission_agent_checksum_status,a.mission_agent_capability_expires_at,
        c.secret_verifier
       FROM project_brain_operation_projections p
       JOIN repositories r ON r.workspace_id=p.workspace_id AND r.repository_id=p.repository_id
       JOIN agents a ON a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
       JOIN LATERAL (
         SELECT secret_verifier FROM agent_credentials c WHERE c.workspace_id=a.workspace_id
           AND c.agent_id=a.agent_id AND c.status='active' AND c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR c.expires_at>now()) ORDER BY c.version DESC LIMIT 1
       ) c ON true
       WHERE p.workspace_id=$1 AND p.operation_id=$2 AND p.location_mode='mission_agent'`,
      [input.workspaceId, input.operationId],
    )
  ).rows[0];
  if (!row) throw new Error("Remote Project Brain operation is unavailable");
  const args = (row.request.arguments as Record<string, unknown>) ?? {};
  const policy = projectBrainOperationPolicy(row.operation, args);
  if (
    row.disabled_at ||
    !row.project_brain_enabled ||
    !row.read_allowed ||
    row.agent_status !== "active" ||
    !row.allowed_agent_ids.includes(row.agent_id) ||
    (policy.requiredPermission === "write" && (!row.write_allowed || !row.commit_allowed))
  )
    throw new Error("remote_project_brain_authority_revoked");
  const permission = (
    await getDatabasePool().query<{ permissions: string[] }>(
      `SELECT permissions FROM agent_resource_permissions WHERE workspace_id=$1 AND agent_id=$2
       AND resource_type='repository' AND resource_id=$3 AND revoked_at IS NULL`,
      [input.workspaceId, row.agent_id, row.repository_id],
    )
  ).rows[0];
  if (!permission?.permissions.includes(policy.requiredPermission))
    throw new Error("remote_project_brain_resource_authority_revoked");
  let approvalExpiresAt: string | null = null;
  const fingerprint = projectBrainRequestFingerprint({
    repositoryId: row.repository_id,
    missionId: row.mission_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    operation: row.operation,
    arguments: args,
    startingSha: row.starting_sha,
    locationMode: "mission_agent",
    expectedWriteScope: policy.artifactTypes,
    timeoutMs: Number(row.request.timeoutMs),
    maxOutputBytes: Number(row.request.maxOutputBytes),
    requiredProjectBrainVersion: row.required_project_brain_version,
    requiredContractVersion: row.required_contract_version,
    artifactVersioning: row.request.artifactVersioning,
  });
  if (fingerprint !== row.request_fingerprint) throw new Error("remote_project_brain_request_changed");
  if (policy.approvalType) {
    if (!row.approval_id) throw new Error("remote_project_brain_approval_missing");
    const approval = (
      await getDatabasePool().query<{
        status: string;
        expires_at: Date | null;
        action_hash: string;
        approval_type: string;
        mission_id: string;
        execution_id: string | null;
        consumed_by_operation_id: string | null;
        consumed_action_hash: string | null;
      }>(
        `SELECT status,expires_at,action_hash,approval_type,mission_id,execution_id,
          consumed_by_operation_id,consumed_action_hash FROM approval_projections
         WHERE workspace_id=$1 AND approval_id=$2`,
        [input.workspaceId, row.approval_id],
      )
    ).rows[0];
    const consumedExact =
      approval?.status === "consumed" &&
      approval.consumed_by_operation_id === input.operationId &&
      approval.consumed_action_hash === fingerprint;
    if (
      !approval ||
      (!consumedExact &&
        (approval.status !== "granted" || (approval.expires_at && approval.expires_at.getTime() <= Date.now()))) ||
      approval.action_hash !== fingerprint ||
      approval.approval_type !== policy.approvalType ||
      approval.mission_id !== row.mission_id ||
      (approval.execution_id ?? null) !== (row.execution_id ?? null)
    )
      throw new Error("remote_project_brain_approval_stale_or_mismatched");
    approvalExpiresAt = approval.expires_at?.toISOString() ?? null;
    await consumeApproval({
      workspaceId: input.workspaceId,
      approvalId: row.approval_id,
      actorId: input.workerId,
      policyVersion: "project-brain-0.4.2",
      operationId: input.operationId,
      actionHash: fingerprint,
    });
  }
  // Account for the signed transport identity, authorization snapshot, nonce,
  // checksum, and signature added after the canonical governed request.
  const requestBytes = Buffer.byteLength(canonicalJson(row.request)) + 4_096;
  const capabilities = row.remote_project_brain_capabilities
    ? validateRemoteProjectBrainCapabilities(row.remote_project_brain_capabilities)
    : null;
  assertCompatibleRemoteProjectBrain({
    capabilities,
    advertisedAt: row.remote_project_brain_capabilities_at,
    operation: row.operation,
    requiredVersion: row.required_project_brain_version,
    requiredContract: row.required_contract_version,
    requiredSchemas: ["2.5.0"],
    requestBytes,
    maxOutputBytes: Number(row.request.maxOutputBytes),
    artifactChecksumStatus: row.mission_agent_checksum_status,
    artifactChecksum: row.mission_agent_artifact_checksum,
    expectedArtifactChecksum: row.mission_agent_expected_checksum,
    capabilityExpiresAt: row.mission_agent_capability_expires_at,
  });
  if (row.local_path !== `mission-agent://${row.repository_fingerprint}`)
    throw new Error("remote_project_brain_repository_locator_mismatch");
  const requestedAt = new Date();
  const assignment = await createRemoteProjectBrainAssignment({
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    repositoryId: row.repository_id,
    missionId: row.mission_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    signingKey: row.secret_verifier,
    request: {
      repositoryLocator: row.local_path,
      repositoryFingerprint: row.repository_fingerprint,
      operation: row.operation,
      arguments: args,
      startingSha: row.starting_sha,
      requiredProjectBrainVersion: row.required_project_brain_version,
      requiredContractVersion: row.required_contract_version,
      requiredSchemaVersions: ["2.5.0"],
      approvalId: row.approval_id,
      approvalFingerprint: fingerprint,
      policyDecision: row.policy_decision,
      authorization: {
        allowedAgent: true,
        repositoryReadAllowed: row.read_allowed,
        repositoryWriteAllowed: row.write_allowed,
        repositoryCommitAllowed: row.commit_allowed,
        requiredPermission: policy.requiredPermission,
        resourcePermission: true,
        approvalRequired: Boolean(policy.approvalType),
        approvalExpiresAt,
      },
      requestedArtifactTypes: policy.artifactTypes,
      timeoutMs: Number(row.request.timeoutMs),
      maxOutputBytes: Number(row.request.maxOutputBytes),
      requestedAt: requestedAt.toISOString(),
      // Request expiry includes one bounded agent polling cycle; timeoutMs is
      // the subprocess budget and must not expire while an eligible pull agent
      // is blocked on another long-poll endpoint.
      expiresAt: new Date(
        requestedAt.getTime() + Math.min(Number(row.request.timeoutMs) + 60_000, 3_600_000),
      ).toISOString(),
      nonce: randomUUID(),
      artifactVersioning: row.request.artifactVersioning,
    },
  });
  await appendProjectBrainOperationEvent({
    actor: { workspaceId: input.workspaceId, id: input.workerId, type: "agent" },
    operationId: input.operationId,
    commandId: stableUuid(`project-brain:${input.operationId}:remote-dispatched`),
    event: {
      eventType: "project_brain.remote_operation_dispatched",
      eventSchemaVersion: 1,
      payload: {
        repositoryId: row.repository_id,
        operation: row.operation,
        operationStatus: "dispatched",
        agentId: row.agent_id,
        assignmentId: assignment.assignment_id,
        requestChecksum: assignment.request_checksum,
        startingSha: row.starting_sha,
      },
    },
  });
  return { assignmentId: assignment.assignment_id, requestChecksum: assignment.request_checksum };
}
