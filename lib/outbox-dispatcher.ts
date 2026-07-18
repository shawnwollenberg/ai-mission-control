import { withTransaction, getDatabasePool } from "@/lib/database";
import { enqueueJob } from "@/lib/job-store";

type Outbox = {
  id: string;
  workspace_id: string;
  event_id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  correlation_id: string;
};
export async function processOneOutbox(workerId: string) {
  const message = await withTransaction(async (client) => {
    await client.query(
      "UPDATE outbox SET status='pending',locked_by=NULL,locked_until=NULL WHERE status='processing' AND locked_until<now()",
    );
    const r = await client.query<Outbox>(
      "SELECT id::text,workspace_id,event_id,topic,payload,attempt_count,correlation_id FROM outbox WHERE status IN('pending','failed') AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!r.rowCount) return undefined;
    await client.query(
      "UPDATE outbox SET status='processing',attempt_count=attempt_count+1,locked_by=$2,locked_until=now()+interval '30 seconds' WHERE id=$1",
      [r.rows[0].id, workerId],
    );
    return r.rows[0];
  });
  if (!message) return false;
  try {
    const eventType = String(message.payload.eventType ?? "");
    if (eventType === "task.became_ready")
      await enqueueJob({
        workspaceId: message.workspace_id,
        jobType: "simulate_task",
        payload: { missionId: message.payload.missionId, taskId: message.payload.taskId },
        idempotencyKey: `outbox:${message.event_id}`,
        correlationId: message.correlation_id,
      });
    await getDatabasePool().query(
      "UPDATE outbox SET status='delivered',delivered_at=now(),locked_by=NULL,locked_until=NULL WHERE id=$1 AND locked_by=$2",
      [message.id, workerId],
    );
  } catch (error) {
    await getDatabasePool().query(
      "UPDATE outbox SET status='failed',last_error=$3,available_at=now()+interval '2 seconds',locked_by=NULL,locked_until=NULL WHERE id=$1 AND locked_by=$2",
      [message.id, workerId, { message: error instanceof Error ? error.message : String(error) }],
    );
    throw error;
  }
  return true;
}
