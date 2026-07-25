import { randomUUID } from "node:crypto";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents, type ActorType, type NewDomainEvent } from "@/lib/postgres-event-store";
import { applyProjectBrainProjection } from "./project-brain-projector";
import {
  projectBrainOperationPolicies,
  projectBrainRequestFingerprint,
  validateProjectBrainRequest,
} from "@/integrations/project-brain/governance";
import type { ProjectBrainOperation } from "@/integrations/project-brain/types";
import { ValidationFailedError } from "@/lib/application-errors";
import { requestActionApproval } from "@/application/approval-commands";
import { stableUuid } from "@/lib/stable-id";
import { enqueueJob } from "@/lib/job-store";

export type ProjectBrainActor = { workspaceId: string; id: string; type: ActorType };
export type ProjectBrainOperationRequest = {
  operationId?: string;
  repositoryId: string;
  missionId?: string;
  executionId?: string;
  agentId?: string;
  operation: ProjectBrainOperation;
  arguments?: Record<string, unknown>;
  startingSha?: string;
  requiredProjectBrainVersion?: string;
  requiredContractVersion?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  requestedArtifactTypes?: string[];
  approvalId?: string;
  idempotencyKey: string;
};

type RepositoryAuthorization = {
  local_path: string;
  location_mode: "server" | "mission_agent";
  observed_commit: string | null;
  read_allowed: boolean;
  write_allowed: boolean;
  commit_allowed: boolean;
  project_brain_enabled: boolean;
  allowed_agent_ids: string[];
};

export async function requestProjectBrainOperation(input: {
  actor: ProjectBrainActor;
  request: ProjectBrainOperationRequest;
}) {
  const operationId = input.request.operationId ?? randomUUID();
  const repository = (
    await getDatabasePool().query<RepositoryAuthorization>(
      `SELECT local_path,location_mode,observed_commit,read_allowed,write_allowed,commit_allowed,
        project_brain_enabled,allowed_agent_ids
       FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
      [input.actor.workspaceId, input.request.repositoryId],
    )
  ).rows[0];
  if (!repository) throw new ValidationFailedError("Repository is unavailable");
  const timeoutMs = input.request.timeoutMs ?? 15_000;
  const maxOutputBytes = input.request.maxOutputBytes ?? 1_000_000;
  const startingSha = input.request.startingSha ?? repository.observed_commit;
  const policy = validateProjectBrainRequest({
    operation: input.request.operation,
    repositoryId: input.request.repositoryId,
    locationMode: repository.location_mode,
    startingSha,
    timeoutMs,
    maxOutputBytes,
    arguments: input.request.arguments,
  });
  const agentId =
    input.request.agentId ??
    (repository.location_mode === "mission_agent" && repository.allowed_agent_ids.length === 1
      ? repository.allowed_agent_ids[0]
      : undefined);
  const requestDocument = {
    repositoryId: input.request.repositoryId,
    missionId: input.request.missionId ?? null,
    executionId: input.request.executionId ?? null,
    agentId: agentId ?? null,
    operation: input.request.operation,
    arguments: input.request.arguments ?? {},
    startingSha,
    locationMode: repository.location_mode,
    expectedWriteScope: policy.artifactTypes,
    timeoutMs,
    maxOutputBytes,
    requiredProjectBrainVersion: input.request.requiredProjectBrainVersion ?? "0.4.0",
    requiredContractVersion: input.request.requiredContractVersion ?? "1.0",
    artifactVersioning: repository.location_mode === "mission_agent" && policy.repositoryFilesChanged,
  };
  const fingerprint = projectBrainRequestFingerprint(requestDocument);
  const reasons: string[] = [];
  if (!repository.project_brain_enabled) reasons.push("project_brain_not_enabled");
  if (!repository.read_allowed) reasons.push("repository_read_denied");
  if (policy.requiredPermission === "write" && !repository.write_allowed) reasons.push("repository_write_denied");
  if (repository.location_mode === "mission_agent" && policy.repositoryFilesChanged && !repository.commit_allowed)
    reasons.push("repository_commit_denied");
  if (repository.location_mode === "mission_agent" && !agentId) reasons.push("remote_agent_required");
  if (agentId && !repository.allowed_agent_ids.includes(agentId)) reasons.push("agent_not_allowed_for_repository");
  if (agentId) {
    const permission = (
      await getDatabasePool().query<{ permissions: string[] }>(
        `SELECT permissions FROM agent_resource_permissions
         WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3
           AND revoked_at IS NULL`,
        [input.actor.workspaceId, agentId, input.request.repositoryId],
      )
    ).rows[0];
    if (!permission?.permissions.includes(policy.requiredPermission))
      reasons.push(`agent_resource_${policy.requiredPermission}_denied`);
  }
  if (input.request.operation === "record_closure") {
    const binding = input.request.missionId
      ? (
          await getDatabasePool().query<{
            context_checksum: string | null;
            bound_execution_id: string | null;
            agent_verification_status: string;
          }>(
            `SELECT context_checksum,bound_execution_id,agent_verification_status
             FROM mission_project_brain_projections WHERE workspace_id=$1 AND mission_id=$2`,
            [input.actor.workspaceId, input.request.missionId],
          )
        ).rows[0]
      : undefined;
    if (!binding) reasons.push("closure_context_binding_missing");
    else {
      if (binding.bound_execution_id !== input.request.executionId) reasons.push("closure_execution_binding_mismatch");
      if (binding.context_checksum !== input.request.arguments?.context_checksum)
        reasons.push("closure_context_checksum_mismatch");
      if (binding.agent_verification_status !== "verified") reasons.push("closure_agent_context_not_verified");
    }
  }
  if (policy.approvalType) {
    const approval = input.request.approvalId
      ? (
          await getDatabasePool().query<{
            status: string;
            expires_at: Date | null;
            action_hash: string;
            approval_type: string;
            mission_id: string;
            execution_id: string | null;
          }>(
            `SELECT status,expires_at,action_hash,approval_type,mission_id,execution_id
             FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2`,
            [input.actor.workspaceId, input.request.approvalId],
          )
        ).rows[0]
      : undefined;
    if (!approval) reasons.push("approval_missing");
    else {
      if (approval.status !== "granted") reasons.push("approval_not_granted");
      if (approval.expires_at && approval.expires_at.getTime() <= Date.now()) reasons.push("approval_expired");
      if (approval.approval_type !== policy.approvalType) reasons.push("approval_type_mismatch");
      if (approval.action_hash !== fingerprint) reasons.push("approval_request_changed");
      if (approval.mission_id !== input.request.missionId) reasons.push("approval_mission_mismatch");
      if ((approval.execution_id ?? undefined) !== input.request.executionId)
        reasons.push("approval_execution_mismatch");
    }
  }
  const requested: NewDomainEvent = {
    eventType: "project_brain.operation_requested",
    eventSchemaVersion: 1,
    payload: {
      ...requestDocument,
      request: requestDocument,
      requestFingerprint: fingerprint,
      approvalId: input.request.approvalId ?? null,
      policyDecision: { action: policy.policyAction, outcome: reasons.length ? "denied" : "allowed", reasons },
    },
  };
  const decision: NewDomainEvent = {
    eventType: reasons.length ? "project_brain.operation_denied" : "project_brain.operation_authorized",
    eventSchemaVersion: 1,
    payload: {
      ...requestDocument,
      requestFingerprint: fingerprint,
      approvalId: input.request.approvalId ?? null,
      humanApprovalRequired: Boolean(policy.approvalType),
      operationStatus: reasons.length ? "denied" : "authorized",
      policyDecision: { action: policy.policyAction, outcome: reasons.length ? "denied" : "allowed", reasons },
      ...(reasons.length ? { failureStage: "authorization", failureCause: reasons.join(",") } : {}),
    },
  };
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "project_brain_operation",
    aggregateId: operationId,
    missionId: input.request.missionId,
    expectedVersion: 0,
    commandId: input.request.idempotencyKey,
    commandType: "RequestProjectBrainOperation",
    correlationId: input.request.missionId ?? operationId,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [requested, decision],
    outbox: reasons.length
      ? []
      : [
          {
            eventIndex: 1,
            topic: "project-brain.operation",
            idempotencyKey: `project-brain:${operationId}`,
            payload: { operationId },
          },
        ],
    applyProjections: applyProjectBrainProjection,
  });
  return {
    operationId,
    authorized: reasons.length === 0,
    reasons,
    requestFingerprint: fingerprint,
    events: result.events,
  };
}

export async function requestProjectBrainWriteApproval(input: {
  actor: ProjectBrainActor;
  request: Omit<ProjectBrainOperationRequest, "approvalId" | "idempotencyKey">;
  expiresAt?: string;
}) {
  const repository = (
    await getDatabasePool().query<RepositoryAuthorization>(
      `SELECT local_path,location_mode,observed_commit,read_allowed,write_allowed,commit_allowed,
        project_brain_enabled,allowed_agent_ids
       FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
      [input.actor.workspaceId, input.request.repositoryId],
    )
  ).rows[0];
  if (!repository) throw new ValidationFailedError("Repository is unavailable");
  const policy = validateProjectBrainRequest({
    operation: input.request.operation,
    repositoryId: input.request.repositoryId,
    locationMode: repository.location_mode,
    startingSha: input.request.startingSha ?? repository.observed_commit,
    timeoutMs: input.request.timeoutMs ?? 15_000,
    maxOutputBytes: input.request.maxOutputBytes ?? 1_000_000,
    arguments: input.request.arguments,
  });
  if (!policy.approvalType) throw new ValidationFailedError("This Project Brain operation does not require approval");
  const agentId =
    input.request.agentId ??
    (repository.location_mode === "mission_agent" && repository.allowed_agent_ids.length === 1
      ? repository.allowed_agent_ids[0]
      : undefined);
  const requestDocument = {
    repositoryId: input.request.repositoryId,
    missionId: input.request.missionId ?? null,
    executionId: input.request.executionId ?? null,
    agentId: agentId ?? null,
    operation: input.request.operation,
    arguments: input.request.arguments ?? {},
    startingSha: input.request.startingSha ?? repository.observed_commit,
    locationMode: repository.location_mode,
    expectedWriteScope: policy.artifactTypes,
    timeoutMs: input.request.timeoutMs ?? 15_000,
    maxOutputBytes: input.request.maxOutputBytes ?? 1_000_000,
    requiredProjectBrainVersion: input.request.requiredProjectBrainVersion ?? "0.4.0",
    requiredContractVersion: input.request.requiredContractVersion ?? "1.0",
    artifactVersioning: repository.location_mode === "mission_agent" && policy.repositoryFilesChanged,
  };
  const fingerprint = projectBrainRequestFingerprint(requestDocument);
  const actionRequestId = stableUuid(`project-brain-approval:${fingerprint}`);
  const approvalId = await requestActionApproval({
    workspaceId: input.actor.workspaceId,
    missionId: input.request.missionId!,
    executionId: input.request.executionId,
    agentId,
    actionRequestId,
    actionType: policy.policyAction,
    targetResource: input.request.repositoryId,
    actionHash: fingerprint,
    approvalType: policy.approvalType,
    policyVersion: "project-brain-0.4.1",
    policyReasons: ["Repository-writing Project Brain operations require exact owner approval"],
    evidence: [{ repositoryId: input.request.repositoryId, startingSha: requestDocument.startingSha }],
    requestedBy: input.actor.id,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
    requestedAction: requestDocument,
    riskExplanation: "Project Brain will write only the declared repository knowledge artifacts",
    supportingEvidenceSummary:
      "Operation, arguments, repository, execution, write scope, SHA, and limits are hash-bound",
  });
  return { approvalId, requestFingerprint: fingerprint, requestDocument };
}

export async function appendProjectBrainOperationEvent(input: {
  actor: ProjectBrainActor;
  operationId: string;
  event: NewDomainEvent;
  commandId: string;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "project_brain_operation",
    aggregateId: input.operationId,
  });
  if (!events.length) throw new ValidationFailedError("Project Brain operation not found");
  return appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "project_brain_operation",
    aggregateId: input.operationId,
    missionId: events[0].missionId,
    expectedVersion: events.at(-1)!.aggregateVersion,
    commandId: input.commandId,
    commandType: input.event.eventType,
    correlationId: events[0].correlationId,
    causationId: events.at(-1)!.eventId,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [input.event],
    applyProjections: applyProjectBrainProjection,
  });
}

export async function bindProjectBrainContext(input: {
  actor: ProjectBrainActor;
  missionId: string;
  executionId: string;
  agentId: string;
  repositoryId: string;
  currentSha: string;
}) {
  const context = (
    await getDatabasePool().query<{
      operation_id: string;
      final_context_artifact_id: string;
      context_checksum: string;
      context_schema_version: string;
      contract_version: string;
      starting_sha: string;
      selected_source_manifest: unknown[];
      context_bytes: number;
      context_quality: Record<string, unknown>;
    }>(
      `SELECT o.operation_id,m.final_context_artifact_id,m.context_checksum,m.context_schema_version,
        m.contract_version,m.starting_sha,m.selected_source_manifest,m.context_bytes,m.context_quality
       FROM mission_project_brain_projections m
       JOIN project_brain_operation_projections o ON o.workspace_id=m.workspace_id
        AND o.mission_id=m.mission_id AND o.status='succeeded' AND o.operation='prepare_context'
       WHERE m.workspace_id=$1 AND m.mission_id=$2 AND m.final_context_artifact_id IS NOT NULL
       ORDER BY o.completed_at DESC LIMIT 1`,
      [input.actor.workspaceId, input.missionId],
    )
  ).rows[0];
  if (!context) throw new ValidationFailedError("Verified Project Brain context is required");
  if (context.starting_sha !== input.currentSha)
    throw new ValidationFailedError("Project Brain context is stale because repository HEAD changed");
  await appendProjectBrainOperationEvent({
    actor: input.actor,
    operationId: context.operation_id,
    commandId: stableUuid(`bind:${context.operation_id}:${input.executionId}:${context.context_checksum}`),
    event: {
      eventType: "project_brain.context_bound_to_execution",
      eventSchemaVersion: 1,
      payload: {
        repositoryId: input.repositoryId,
        operation: "prepare_context",
        operationStatus: "succeeded",
        contextChecksum: context.context_checksum,
        startingSha: context.starting_sha,
        missionProjection: {
          finalContextArtifactId: context.final_context_artifact_id,
          contextChecksum: context.context_checksum,
          contextSchemaVersion: context.context_schema_version,
          contractVersion: context.contract_version,
          startingSha: context.starting_sha,
          selectedSourceManifest: context.selected_source_manifest,
          contextBytes: context.context_bytes,
          contextQuality: context.context_quality,
          contextBoundStatus: "bound",
          boundExecutionId: input.executionId,
          assignedAgentId: input.agentId,
          boundAt: new Date().toISOString(),
        },
      },
    },
  });
  await enqueueJob({
    workspaceId: input.actor.workspaceId,
    jobType: "execute_codex",
    payload: { executionId: input.executionId },
    idempotencyKey: `execute:${input.executionId}`,
    correlationId: input.missionId,
    maxAttempts: 3,
  });
  return context;
}

export { projectBrainOperationPolicies };
