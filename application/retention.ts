import { randomUUID } from "node:crypto";
import { getDatabasePool, withTransaction } from "@/lib/database";
export async function runRetention(input: {
  workspaceId?: string;
  completedJobDays?: number;
  deliveredNotificationDays?: number;
  limit?: number;
}) {
  const id = randomUUID(),
    limit = Math.min(input.limit ?? 500, 1000),
    policy = {
      completedJobDays: input.completedJobDays ?? 30,
      deliveredNotificationDays: input.deliveredNotificationDays ?? 30,
      limit,
    };
  await getDatabasePool().query(
    "INSERT INTO retention_runs(retention_run_id,workspace_id,policy,deleted_counts,status) VALUES($1,$2,$3,'{}','running')",
    [id, input.workspaceId ?? null, JSON.stringify(policy)],
  );
  try {
    const counts = await withTransaction(async (client) => {
      const jobs = await client.query(
        `DELETE FROM jobs WHERE id IN (SELECT j.id FROM jobs j WHERE ($1::uuid IS NULL OR j.workspace_id=$1) AND j.status='completed' AND j.completed_at<now()-($2*interval '1 day') AND NOT EXISTS(SELECT 1 FROM dead_letters d WHERE d.job_id=j.job_id AND d.reviewed_at IS NULL AND d.cancelled_at IS NULL) ORDER BY j.completed_at LIMIT $3)`,
        [input.workspaceId ?? null, policy.completedJobDays, limit],
      );
      const deliveries = await client.query(
        `DELETE FROM notification_deliveries WHERE (workspace_id=$1 OR $1::uuid IS NULL) AND status='delivered' AND delivered_at<now()-($2*interval '1 day') AND delivery_id IN(SELECT delivery_id FROM notification_deliveries WHERE (workspace_id=$1 OR $1::uuid IS NULL) ORDER BY delivered_at LIMIT $3)`,
        [input.workspaceId ?? null, policy.deliveredNotificationDays, limit],
      );
      return { completedJobs: jobs.rowCount, notificationDeliveries: deliveries.rowCount };
    });
    await getDatabasePool().query(
      "UPDATE retention_runs SET status='complete',deleted_counts=$2,completed_at=now() WHERE retention_run_id=$1",
      [id, JSON.stringify(counts)],
    );
    return { retentionRunId: id, counts };
  } catch (error) {
    await getDatabasePool().query(
      "UPDATE retention_runs SET status='failed',error=$2,completed_at=now() WHERE retention_run_id=$1",
      [id, JSON.stringify({ message: error instanceof Error ? error.message : String(error) })],
    );
    throw error;
  }
}
