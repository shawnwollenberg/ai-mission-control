import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
import type { CommandActor } from "@/application/mission-commands";
async function command(input: {
  actor: CommandActor;
  commandId: string;
  jobId: string;
  action: "retry" | "cancel" | "review";
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  const row = (
    await getDatabasePool().query(
      `SELECT d.*,j.status job_status,j.correlation_id FROM dead_letters d JOIN jobs j ON j.job_id=d.job_id WHERE d.workspace_id=$1 AND d.job_id=$2`,
      [input.actor.workspaceId, input.jobId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Dead letter");
  if (input.action === "retry" && row.job_type === "execute_action") {
    const actionId = row.payload.actionRequestId;
    const action = (
      await getDatabasePool().query(
        "SELECT status FROM action_request_projections WHERE workspace_id=$1 AND action_request_id=$2",
        [input.actor.workspaceId, actionId],
      )
    ).rows[0];
    if (action?.status === "denied") throw new ValidationFailedError("Policy-denied actions cannot be retried");
  }
  const aggregateId = stableUuid(`dead-letter:${input.jobId}`);
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "dead_letter",
    aggregateId,
  });
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "dead_letter",
    aggregateId,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: `${input.action}DeadLetter`,
    correlationId: row.correlation_id ?? aggregateId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: `dead_letter.${input.action}_requested`,
        eventSchemaVersion: 1,
        payload: { jobId: input.jobId, reviewedBy: input.actor.userId },
      },
    ],
    applyProjections: applyDeadLetterProjection,
  });
  return { jobId: input.jobId, duplicate: result.duplicateCommand };
}
export const retryDeadLetter = (input: { actor: CommandActor; commandId: string; jobId: string }) =>
  command({ ...input, action: "retry" });
export const cancelDeadLetter = (input: { actor: CommandActor; commandId: string; jobId: string }) =>
  command({ ...input, action: "cancel" });
export const reviewDeadLetter = (input: { actor: CommandActor; commandId: string; jobId: string }) =>
  command({ ...input, action: "review" });
export async function applyDeadLetterProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "dead_letter.retry_requested") {
      await client.query(
        "UPDATE jobs SET status='pending',attempt_count=0,available_at=now(),last_error=NULL,updated_at=now() WHERE workspace_id=$1 AND job_id=$2 AND status='dead_letter'",
        [event.workspaceId, event.payload.jobId],
      );
      await client.query("UPDATE dead_letters SET recovery_command_id=$3 WHERE workspace_id=$1 AND job_id=$2", [
        event.workspaceId,
        event.payload.jobId,
        event.eventId,
      ]);
    } else if (event.eventType === "dead_letter.cancel_requested")
      await client.query(
        "UPDATE dead_letters SET cancelled_at=$3,recovery_command_id=$4 WHERE workspace_id=$1 AND job_id=$2",
        [event.workspaceId, event.payload.jobId, event.occurredAt, event.eventId],
      );
    else if (event.eventType === "dead_letter.review_requested")
      await client.query(
        "UPDATE dead_letters SET reviewed_at=$3,reviewed_by=$4,recovery_command_id=$5 WHERE workspace_id=$1 AND job_id=$2",
        [event.workspaceId, event.payload.jobId, event.occurredAt, event.payload.reviewedBy, event.eventId],
      );
  }
}
