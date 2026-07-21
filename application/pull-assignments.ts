import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";

const terminal = ["succeeded", "failed", "timed_out", "cancelled"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type PullCredential = { workspace_id: string; agent_id: string; credential_id: string };

export async function createPullAssignment(
  client: PoolClient,
  input: {
    workspaceId: string;
    executionId: string;
    missionId: string;
    taskId: string;
    agentId: string;
    attempt: number;
    payload: Record<string, unknown>;
  },
) {
  const assignmentId = randomUUID();
  await client.query(
    `INSERT INTO pull_assignments(workspace_id,assignment_id,execution_id,mission_id,task_id,agent_id,attempt,status,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,'available',$8)
     ON CONFLICT(workspace_id,execution_id) DO NOTHING`,
    [
      input.workspaceId,
      assignmentId,
      input.executionId,
      input.missionId,
      input.taskId,
      input.agentId,
      input.attempt,
      JSON.stringify(input.payload),
    ],
  );
  return assignmentId;
}

export async function claimNextAssignment(input: {
  credential: PullCredential;
  leaseOwner: string;
  leaseSeconds?: number;
}) {
  if (!input.leaseOwner || input.leaseOwner.length > 120) throw new ValidationFailedError("Invalid lease owner");
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 30), 120);
  return withTransaction(async (client) => {
    const agent = (
      await client.query<{
        status: string;
        delivery_mode: string;
        pull_ready_at: Date | null;
        last_heartbeat_at: Date | null;
        pause_new_executions: boolean;
        pause_remote_assignments: boolean;
      }>(
        `SELECT a.status,a.delivery_mode,a.pull_ready_at,a.last_heartbeat_at,
          COALESCE(c.pause_new_executions,false) pause_new_executions,
          COALESCE(c.pause_remote_assignments,false) pause_remote_assignments
         FROM agents a LEFT JOIN workspace_emergency_controls c ON c.workspace_id=a.workspace_id
         WHERE a.workspace_id=$1 AND a.agent_id=$2 FOR UPDATE OF a`,
        [input.credential.workspace_id, input.credential.agent_id],
      )
    ).rows[0];
    if (
      !agent ||
      agent.status === "disabled" ||
      agent.delivery_mode !== "pull" ||
      !agent.pull_ready_at ||
      !agent.last_heartbeat_at ||
      Date.now() - new Date(agent.pull_ready_at).getTime() > 5 * 60_000 ||
      Date.now() - new Date(agent.last_heartbeat_at).getTime() > 5 * 60_000 ||
      agent.pause_new_executions ||
      agent.pause_remote_assignments
    )
      return undefined;

    await client.query(
      `UPDATE pull_assignments p SET status='available',lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       FROM execution_projections e
       WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.execution_id=e.execution_id AND p.workspace_id=e.workspace_id
         AND p.status IN('leased','acknowledged') AND p.lease_expires_at<=now() AND e.status NOT IN ('succeeded','failed','timed_out','cancelled')`,
      [input.credential.workspace_id, input.credential.agent_id],
    );
    const active = (
      await client.query(
        `SELECT p.* FROM pull_assignments p JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
         WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.lease_owner=$3 AND p.status IN('leased','acknowledged')
           AND p.lease_expires_at>now() AND e.status NOT IN ('succeeded','failed','timed_out','cancelled')
         ORDER BY p.claimed_at LIMIT 1 FOR UPDATE OF p`,
        [input.credential.workspace_id, input.credential.agent_id, input.leaseOwner],
      )
    ).rows[0];
    if (active) return { assignment: active, leaseToken: undefined, resumed: true };

    const assignment = (
      await client.query(
        `SELECT p.*,e.status execution_status,t.status task_status FROM pull_assignments p JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
         JOIN task_projections t ON t.workspace_id=p.workspace_id AND t.task_id=p.task_id
         JOIN agents a ON a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
         WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.status='available' AND e.agent_id=$2
           AND e.status IN('requested','accepted','preparing','running')
           AND t.status IN('assigned','running') AND a.status='active' AND a.capabilities @> t.required_capabilities
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(t.required_resources) resource
             WHERE NOT EXISTS (
               SELECT 1 FROM agent_resource_permissions permission
               WHERE permission.workspace_id=p.workspace_id AND permission.agent_id=p.agent_id
                 AND permission.resource_type=resource->>'resourceType' AND permission.resource_id=resource->>'resourceId'
                 AND permission.revoked_at IS NULL AND permission.permissions ? (resource->>'permission')
             )
           )
         ORDER BY p.created_at FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
        [input.credential.workspace_id, input.credential.agent_id],
      )
    ).rows[0];
    if (!assignment) return undefined;
    const resumed = assignment.execution_status !== "requested";
    const leaseToken = `mc_lease_${randomBytes(32).toString("base64url")}`;
    const leased = (
      await client.query(
        `UPDATE pull_assignments SET status='leased',lease_owner=$3,lease_token_hash=$4,claimed_at=COALESCE(claimed_at,now()),
          lease_expires_at=now()+($5*interval '1 second'),last_renewed_at=now(),updated_at=now()
         WHERE workspace_id=$1 AND assignment_id=$2 RETURNING *`,
        [input.credential.workspace_id, assignment.assignment_id, input.leaseOwner, hash(leaseToken), leaseSeconds],
      )
    ).rows[0];
    return { assignment: leased, leaseToken, resumed };
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
      `SELECT p.*,e.status execution_status,e.cancellation_requested_at FROM pull_assignments p
       JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
       WHERE p.workspace_id=$1 AND p.assignment_id=$2 AND p.agent_id=$3`,
      [input.credential.workspace_id, input.assignmentId, input.credential.agent_id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Assignment");
  if (
    row.lease_owner !== input.leaseOwner ||
    row.lease_token_hash !== hash(input.leaseToken) ||
    !row.lease_expires_at ||
    new Date(row.lease_expires_at).getTime() <= Date.now()
  )
    throw new ValidationFailedError("Assignment lease is invalid or expired");
  return row;
}

export async function validateExecutionLease(input: Parameters<typeof requireLease>[0] & { executionId: string }) {
  const row = await requireLease(input);
  if (row.execution_id !== input.executionId) throw new ValidationFailedError("Lease is not valid for this execution");
  return row;
}

export async function acknowledgeAssignment(input: Parameters<typeof requireLease>[0]) {
  const row = await requireLease(input);
  if (terminal.includes(row.execution_status)) throw new ValidationFailedError("Execution is already terminal");
  await getDatabasePool().query(
    "UPDATE pull_assignments SET status='acknowledged',updated_at=now() WHERE workspace_id=$1 AND assignment_id=$2",
    [input.credential.workspace_id, input.assignmentId],
  );
  return row;
}

export async function renewAssignmentLease(input: Parameters<typeof requireLease>[0] & { leaseSeconds?: number }) {
  const row = await requireLease(input);
  if (terminal.includes(row.execution_status)) throw new ValidationFailedError("Execution is already terminal");
  const seconds = Math.min(Math.max(input.leaseSeconds ?? 60, 30), 120);
  const renewed = (
    await getDatabasePool().query(
      `UPDATE pull_assignments SET lease_expires_at=now()+($3*interval '1 second'),last_renewed_at=now(),updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 RETURNING lease_expires_at`,
      [input.credential.workspace_id, input.assignmentId, seconds],
    )
  ).rows[0];
  return { ...row, lease_expires_at: renewed.lease_expires_at };
}

export async function checkAssignmentCancellation(input: Parameters<typeof requireLease>[0]) {
  const row = await requireLease(input);
  return { cancellationRequested: Boolean(row.cancellation_requested_at), executionStatus: row.execution_status };
}

export async function releaseAssignment(input: Parameters<typeof requireLease>[0]) {
  const row = await requireLease(input);
  if (!terminal.includes(row.execution_status))
    await getDatabasePool().query(
      `UPDATE pull_assignments SET status='available',lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2`,
      [input.credential.workspace_id, input.assignmentId],
    );
  return row;
}

export async function completePullAssignment(workspaceId: string, executionId: string) {
  await getDatabasePool().query(
    "UPDATE pull_assignments SET status='completed',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, executionId],
  );
}
