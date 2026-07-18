import { randomUUID } from "node:crypto";
import { claimJob, completeJob, failJob, renewJobLease } from "../lib/job-store";
import { closeDatabasePool, getDatabasePool } from "../lib/database";
import { executeCodex } from "../execution/codex-adapter";
const workerId = process.env.WORKER_ID ?? `codex-${randomUUID().slice(0, 8)}`;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, workerId, ...data }));
async function main() {
  log("codex_worker_started");
  while (!stopping) {
    const job = await claimJob(workerId, 90, undefined, "execute_codex");
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.WORKER_POLL_MS ?? 1000)));
      continue;
    }
    const executionId = String(job.payload.executionId),
      abort = new AbortController();
    const heartbeat = setInterval(
      async () => {
        try {
          const execution = (
            await getDatabasePool().query<{
              workspace_id: string;
              agent_id: string;
              stage: string | null;
              cancellation_requested_at: Date | null;
            }>(
              "SELECT workspace_id,agent_id,stage,cancellation_requested_at FROM execution_projections WHERE execution_id=$1",
              [executionId],
            )
          ).rows[0];
          if (!execution) return;
          if (execution.cancellation_requested_at) abort.abort();
          await renewJobLease(job.jobId, workerId, 90);
          await getDatabasePool().query(
            `INSERT INTO execution_heartbeats(workspace_id,execution_id,agent_id,worker_id,stage,received_at,lease_expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '90 seconds') ON CONFLICT(workspace_id,execution_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,stage=EXCLUDED.stage,received_at=now(),lease_expires_at=EXCLUDED.lease_expires_at`,
            [execution.workspace_id, executionId, execution.agent_id, workerId, execution.stage ?? "claimed"],
          );
          await getDatabasePool().query(
            "UPDATE agents SET last_heartbeat_at=now(),status=CASE WHEN status='disabled' THEN status ELSE 'active' END,updated_at=now() WHERE workspace_id=$1 AND agent_id=$2",
            [execution.workspace_id, execution.agent_id],
          );
        } catch (error) {
          log("heartbeat_error", { executionId, error: error instanceof Error ? error.message : String(error) });
        }
      },
      Number(process.env.CODEX_HEARTBEAT_MS ?? 30_000),
    );
    try {
      log("codex_job_started", { jobId: job.jobId, executionId, correlationId: job.correlationId });
      await executeCodex({ workspaceId: job.workspaceId!, executionId, workerId, signal: abort.signal });
      await completeJob(job.jobId, workerId);
      log("codex_job_completed", { jobId: job.jobId, executionId });
    } catch (error) {
      await failJob(job, workerId, error);
      log("codex_job_failed", {
        jobId: job.jobId,
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  log("codex_worker_stopped");
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
