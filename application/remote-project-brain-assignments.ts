import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { canonicalJson } from "@/lib/canonical-json";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import type { PullCredential } from "@/application/pull-assignments";
import { appendProjectBrainOperationEvent } from "@/application/project-brain-commands";
import { stableUuid } from "@/lib/stable-id";
import { validateRemoteProjectBrainRequest } from "@/integrations/project-brain/remote-protocol";
import { projectBrainOperationPolicy, projectBrainRequestFingerprint } from "@/integrations/project-brain/governance";
import type { ProjectBrainOperation } from "@/integrations/project-brain/types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = ["succeeded", "failed"];

export async function createRemoteProjectBrainAssignment(input: {
  workspaceId: string;
  operationId: string;
  repositoryId: string;
  missionId?: string | null;
  executionId?: string | null;
  agentId: string;
  request: Record<string, unknown>;
  signingKey: string;
}) {
  const assignmentId = randomUUID();
  const request = {
    ...input.request,
    protocolVersion: "1.0",
    requestId: assignmentId,
    idempotencyKey: `project-brain:${input.operationId}`,
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    repositoryId: input.repositoryId,
    missionId: input.missionId ?? null,
    executionId: input.executionId ?? null,
    agentId: input.agentId,
  };
  const requestChecksum = hash(canonicalJson(request));
  const signedRequest = {
    ...request,
    requestChecksum,
    missionControlSignature: createHmac("sha256", input.signingKey).update(requestChecksum).digest("hex"),
  };
  validateRemoteProjectBrainRequest(signedRequest);
  const row = (
    await getDatabasePool().query(
      `INSERT INTO remote_project_brain_assignments(
        workspace_id,assignment_id,operation_id,repository_id,mission_id,execution_id,agent_id,
        attempt,status,request,request_checksum
       ) VALUES($1,$2,$3,$4,$5,$6,$7,1,'available',$8,$9)
       ON CONFLICT(workspace_id,operation_id) DO UPDATE SET updated_at=now()
       RETURNING *`,
      [
        input.workspaceId,
        assignmentId,
        input.operationId,
        input.repositoryId,
        input.missionId ?? null,
        input.executionId ?? null,
        input.agentId,
        JSON.stringify(signedRequest),
        requestChecksum,
      ],
    )
  ).rows[0];
  return row;
}

export async function claimRemoteProjectBrainAssignment(input: {
  credential: PullCredential;
  leaseOwner: string;
  leaseSeconds?: number;
}) {
  if (!input.leaseOwner || input.leaseOwner.length > 120) throw new ValidationFailedError("Invalid lease owner");
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 30), 120);
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE remote_project_brain_assignments SET status='available',lease_owner=NULL,
        lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE workspace_id=$1 AND agent_id=$2 AND status IN('leased','acknowledged','running')
         AND lease_expires_at<=now()`,
      [input.credential.workspace_id, input.credential.agent_id],
    );
    const assignment = (
      await client.query(
        `SELECT p.* FROM remote_project_brain_assignments p
         JOIN agents a ON a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
         WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.status='available'
           AND a.status='active' AND a.pull_ready_at>now()-interval '5 minutes'
           AND a.last_heartbeat_at>now()-interval '5 minutes'
         ORDER BY p.created_at FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
        [input.credential.workspace_id, input.credential.agent_id],
      )
    ).rows[0];
    if (!assignment) return undefined;
    const leaseToken = `mc_pb_lease_${randomBytes(32).toString("base64url")}`;
    const leased = (
      await client.query(
        `UPDATE remote_project_brain_assignments SET status='leased',lease_owner=$3,
          lease_token_hash=$4,claimed_at=COALESCE(claimed_at,now()),
          lease_expires_at=now()+($5*interval '1 second'),last_renewed_at=now(),updated_at=now()
         WHERE workspace_id=$1 AND assignment_id=$2 RETURNING *`,
        [input.credential.workspace_id, assignment.assignment_id, input.leaseOwner, hash(leaseToken), leaseSeconds],
      )
    ).rows[0];
    return { assignment: leased, leaseToken };
  });
}

async function requireLease(input: {
  credential: PullCredential;
  assignmentId: string;
  leaseOwner: string;
  leaseToken: string;
}) {
  const row = (
    await getDatabasePool().query(
      `SELECT * FROM remote_project_brain_assignments
       WHERE workspace_id=$1 AND assignment_id=$2 AND agent_id=$3`,
      [input.credential.workspace_id, input.assignmentId, input.credential.agent_id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Project Brain assignment");
  if (
    row.lease_owner !== input.leaseOwner ||
    row.lease_token_hash !== hash(input.leaseToken) ||
    !row.lease_expires_at ||
    (!terminal.includes(row.status) && new Date(row.lease_expires_at).getTime() <= Date.now())
  )
    throw new ValidationFailedError("Project Brain assignment lease is invalid or expired");
  return row;
}

export async function acknowledgeRemoteProjectBrainAssignment(input: Parameters<typeof requireLease>[0]) {
  const row = await requireLease(input);
  if (terminal.includes(row.status)) throw new ValidationFailedError("Project Brain assignment is terminal");
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments SET status='acknowledged',updated_at=now()
     WHERE workspace_id=$1 AND assignment_id=$2`,
    [input.credential.workspace_id, input.assignmentId],
  );
  return row;
}

export async function renewRemoteProjectBrainLease(
  input: Parameters<typeof requireLease>[0] & { leaseSeconds?: number },
) {
  const row = await requireLease(input);
  if (terminal.includes(row.status)) throw new ValidationFailedError("Project Brain assignment is terminal");
  const seconds = Math.min(Math.max(input.leaseSeconds ?? 60, 30), 120);
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments SET lease_expires_at=now()+($3*interval '1 second'),
      last_renewed_at=now(),updated_at=now() WHERE workspace_id=$1 AND assignment_id=$2`,
    [input.credential.workspace_id, input.assignmentId, seconds],
  );
  return row;
}

export async function validateRemoteProjectBrainLease(
  input: Parameters<typeof requireLease>[0] & { operationId: string },
) {
  const row = await requireLease(input);
  if (row.operation_id !== input.operationId)
    throw new ValidationFailedError("Lease is not valid for this Project Brain operation");
  return row;
}

export async function completeRemoteProjectBrainAssignment(input: {
  workspaceId: string;
  assignmentId: string;
  status: "succeeded" | "failed";
  response: Record<string, unknown>;
}) {
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments SET status=$3,response=$4,completed_at=now(),
      updated_at=now()
     WHERE workspace_id=$1 AND assignment_id=$2`,
    [input.workspaceId, input.assignmentId, input.status, JSON.stringify(input.response)],
  );
}

export async function recoverRemoteProjectBrainAssignments() {
  const failed = await withTransaction(async (client) => {
    await client.query(
      `UPDATE remote_project_brain_assignments p SET status='available',lease_owner=NULL,
         lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       FROM agents a
       WHERE a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
         AND p.status IN('leased','acknowledged','running') AND p.lease_expires_at<=now()
         AND (p.request->>'expiresAt')::timestamptz>now()
         AND a.status='active' AND a.last_heartbeat_at>now()-interval '5 minutes'`,
    );
    await client.query(
      `UPDATE remote_project_brain_assignments p SET status='failed',recovery_event_emitted=false,
         response=jsonb_build_object(
           'error',CASE
             WHEN (p.request->>'expiresAt')::timestamptz<=now() THEN 'remote_request_expired'
             ELSE 'remote_agent_disconnected'
           END
         ),completed_at=now(),updated_at=now()
       FROM agents a
       WHERE a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
         AND p.status IN('available','leased','acknowledged','running')
         AND p.started_event_emitted=false
         AND (
           (p.status IN('available','leased') AND (
             (p.request->>'expiresAt')::timestamptz<=now()
             OR a.status<>'active'
             OR a.last_heartbeat_at IS NULL
             OR a.last_heartbeat_at<=now()-interval '5 minutes'
           ))
           OR
           (p.status IN('acknowledged','running')
             AND (p.request->>'expiresAt')::timestamptz<=now()-interval '10 minutes'
             AND (p.lease_expires_at IS NULL OR p.lease_expires_at<=now())
           )
         )`,
    );
    return (
      await client.query<{
        workspace_id: string;
        assignment_id: string;
        operation_id: string;
        repository_id: string;
        agent_id: string;
        request: Record<string, unknown>;
        failure_cause: string;
      }>(
        `SELECT workspace_id,assignment_id,operation_id,repository_id,agent_id,request,
           response->>'error' AS failure_cause
         FROM remote_project_brain_assignments
         WHERE status='failed' AND recovery_event_emitted=false
         ORDER BY updated_at`,
      )
    ).rows;
  });
  for (const row of failed) {
    await appendProjectBrainOperationEvent({
      actor: { workspaceId: row.workspace_id, id: row.agent_id, type: "agent" },
      operationId: row.operation_id,
      commandId: stableUuid(`remote-pb:${row.operation_id}:recovery:${row.failure_cause}`),
      event: {
        eventType: "project_brain.remote_operation_failed",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          operation: row.request.operation,
          agentId: row.agent_id,
          assignmentId: row.assignment_id,
          operationStatus: "failed",
          failureCause: row.failure_cause,
        },
      },
    });
    await getDatabasePool().query(
      `UPDATE remote_project_brain_assignments SET recovery_event_emitted=true,updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 AND status='failed'`,
      [row.workspace_id, row.assignment_id],
    );
  }
  return { failed: failed.length };
}

export async function reauthorizeRemoteProjectBrainAssignment(input: {
  credential: PullCredential;
  assignmentId: string;
  leaseOwner: string;
  leaseToken: string;
  requestChecksum: string;
}) {
  const row = (
    await getDatabasePool().query<{
      request: {
        operation: ProjectBrainOperation;
        arguments: Record<string, unknown>;
        startingSha: string;
        timeoutMs: number;
        maxOutputBytes: number;
        requiredProjectBrainVersion: string;
        requiredContractVersion: string;
        artifactVersioning: boolean;
        operationId: string;
        expiresAt: string;
      };
      request_checksum: string;
      status: string;
      started_event_emitted: boolean;
      lease_owner: string | null;
      lease_token_hash: string | null;
      repository_id: string;
      mission_id: string | null;
      execution_id: string | null;
      agent_id: string;
      observed_commit: string;
      project_brain_enabled: boolean;
      read_allowed: boolean;
      write_allowed: boolean;
      commit_allowed: boolean;
      disabled_at: Date | null;
      allowed_agent_ids: string[];
      agent_status: string;
      permissions: string[] | null;
      approval_status: string | null;
      approval_expires_at: Date | null;
      approval_action_hash: string | null;
      approval_type: string | null;
      consumed_by_operation_id: string | null;
      consumed_action_hash: string | null;
      mission_exists: boolean;
      pause_remote_assignments: boolean;
    }>(
      `SELECT a.request,a.request_checksum,a.status,a.started_event_emitted,a.lease_owner,a.lease_token_hash,
        a.repository_id,a.mission_id,a.execution_id,a.agent_id,r.observed_commit,
        r.project_brain_enabled,r.read_allowed,r.write_allowed,r.commit_allowed,r.disabled_at,
        r.allowed_agent_ids,g.status agent_status,p.permissions,
        ap.status approval_status,ap.expires_at approval_expires_at,ap.action_hash approval_action_hash,
        ap.approval_type,ap.consumed_by_operation_id,ap.consumed_action_hash,
        (a.mission_id IS NULL OR m.mission_id IS NOT NULL) mission_exists,
        COALESCE(ec.pause_remote_assignments,false) pause_remote_assignments
       FROM remote_project_brain_assignments a
       JOIN repositories r ON r.workspace_id=a.workspace_id AND r.repository_id=a.repository_id
       JOIN agents g ON g.workspace_id=a.workspace_id AND g.agent_id=a.agent_id
       LEFT JOIN agent_resource_permissions p ON p.workspace_id=a.workspace_id AND p.agent_id=a.agent_id
         AND p.resource_type='repository' AND p.resource_id=a.repository_id::text AND p.revoked_at IS NULL
       LEFT JOIN approval_projections ap ON ap.workspace_id=a.workspace_id
         AND ap.approval_id=(a.request->>'approvalId')::uuid
       LEFT JOIN mission_projections m ON m.workspace_id=a.workspace_id AND m.mission_id=a.mission_id
       LEFT JOIN workspace_emergency_controls ec ON ec.workspace_id=a.workspace_id
       WHERE a.workspace_id=$1 AND a.assignment_id=$2 AND a.agent_id=$3`,
      [input.credential.workspace_id, input.assignmentId, input.credential.agent_id],
    )
  ).rows[0];
  if (
    !row ||
    !["leased", "acknowledged", "running"].includes(row.status) ||
    row.lease_owner !== input.leaseOwner ||
    row.lease_token_hash !== hash(input.leaseToken) ||
    row.request_checksum !== input.requestChecksum
  )
    throw new ValidationFailedError("Remote Project Brain assignment binding is no longer valid");
  const request = row.request;
  const policy = projectBrainOperationPolicy(request.operation, request.arguments ?? {});
  const fingerprint = projectBrainRequestFingerprint({
    repositoryId: row.repository_id,
    missionId: row.mission_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    operation: request.operation,
    arguments: request.arguments ?? {},
    startingSha: request.startingSha,
    locationMode: "mission_agent",
    expectedWriteScope: policy.artifactTypes,
    timeoutMs: Number(request.timeoutMs),
    maxOutputBytes: Number(request.maxOutputBytes),
    requiredProjectBrainVersion: request.requiredProjectBrainVersion,
    requiredContractVersion: request.requiredContractVersion,
    artifactVersioning: request.artifactVersioning,
  });
  const approved =
    !policy.approvalType ||
    (row.approval_status === "consumed" &&
      row.approval_expires_at !== null &&
      (row.approval_expires_at.getTime() > Date.now() || row.started_event_emitted) &&
      row.approval_action_hash === fingerprint &&
      row.approval_type === policy.approvalType &&
      row.consumed_by_operation_id === request.operationId &&
      row.consumed_action_hash === fingerprint);
  const authorized =
    !row.disabled_at &&
    !row.pause_remote_assignments &&
    row.project_brain_enabled &&
    row.read_allowed &&
    row.agent_status === "active" &&
    row.allowed_agent_ids.includes(row.agent_id) &&
    row.mission_exists &&
    Boolean(row.permissions?.includes(policy.requiredPermission)) &&
    (policy.requiredPermission !== "write" || (row.write_allowed && row.commit_allowed)) &&
    approved &&
    typeof request.expiresAt === "string" &&
    (new Date(request.expiresAt).getTime() > Date.now() || row.started_event_emitted) &&
    row.observed_commit === request.startingSha;
  if (!authorized) throw new ValidationFailedError("Remote Project Brain authority was revoked before execution");
  return { authorized: true, requestFingerprint: fingerprint, checkedAt: new Date().toISOString() };
}
