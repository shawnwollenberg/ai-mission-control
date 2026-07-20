import { randomUUID } from "node:crypto";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";

export async function createPublicationAssignment(input: {
  workspaceId: string;
  actionRequestId: string;
  executionId: string;
  missionId: string;
  agentId: string;
  repositoryId: string;
  payload: Record<string, unknown>;
}) {
  const assignmentId = randomUUID();
  await getDatabasePool().query(
    `INSERT INTO publication_assignments(workspace_id,assignment_id,action_request_id,execution_id,mission_id,agent_id,repository_id,status,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,'available',$8)
     ON CONFLICT(workspace_id,action_request_id) DO NOTHING`,
    [
      input.workspaceId,
      assignmentId,
      input.actionRequestId,
      input.executionId,
      input.missionId,
      input.agentId,
      input.repositoryId,
      JSON.stringify(input.payload),
    ],
  );
}

export async function claimPublicationAssignment(workspaceId: string, agentId: string) {
  return withTransaction(async (client) => {
    const row = (
      await client.query(
        `SELECT * FROM publication_assignments WHERE workspace_id=$1 AND agent_id=$2 AND status IN('available','claimed')
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [workspaceId, agentId],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.status === "available")
      await client.query(
        "UPDATE publication_assignments SET status='claimed',claimed_at=now(),updated_at=now() WHERE workspace_id=$1 AND assignment_id=$2",
        [workspaceId, row.assignment_id],
      );
    return { ...row, status: "claimed" };
  });
}

export async function recordPublicationPush(input: {
  workspaceId: string;
  agentId: string;
  actionRequestId: string;
  branch: string;
  commit: string;
  remoteCommit: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestHeadSha: string;
}) {
  const row = (
    await getDatabasePool().query(
      `SELECT * FROM publication_assignments WHERE workspace_id=$1 AND action_request_id=$2 AND agent_id=$3`,
      [input.workspaceId, input.actionRequestId, input.agentId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Publication assignment");
  const expected = row.payload as Record<string, unknown>;
  if (row.status === "completed") return row;
  if (
    input.branch !== expected.branch ||
    input.commit !== expected.commit ||
    input.remoteCommit !== expected.commit ||
    input.pullRequestHeadSha !== expected.commit ||
    !Number.isInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1
  )
    throw new ValidationFailedError("Published branch does not match the exact approved commit");
  await getDatabasePool().query(
    `UPDATE publication_assignments SET status='pushed',result=$4,updated_at=now() WHERE workspace_id=$1 AND action_request_id=$2 AND agent_id=$3`,
    [input.workspaceId, input.actionRequestId, input.agentId, JSON.stringify(input)],
  );
  return row;
}

export async function completePublicationAssignment(workspaceId: string, actionRequestId: string, result: unknown) {
  await getDatabasePool().query(
    `UPDATE publication_assignments SET status='completed',result=$3,completed_at=now(),updated_at=now()
     WHERE workspace_id=$1 AND action_request_id=$2`,
    [workspaceId, actionRequestId, JSON.stringify(result)],
  );
}
