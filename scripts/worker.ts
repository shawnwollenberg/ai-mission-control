import { randomUUID } from "node:crypto";
import { closeDatabasePool } from "../lib/database";
import { claimJob, completeJob, failJob } from "../lib/job-store";
import { processOneOutbox } from "../lib/outbox-dispatcher";
import { runSimulationJob } from "../application/simulated-executor";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
import { expireDueApprovals } from "../application/governance-maintenance";

assertSupportedNodeVersion();

const workerId = process.env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
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
  log("worker_started");
  while (!stopping) {
    let worked = false;
    try {
      if ((await expireDueApprovals(workerId)) > 0) worked = true;
      worked = await processOneOutbox(workerId);
      const job = await claimJob(workerId);
      if (job) {
        worked = true;
        try {
          log("job_started", { jobId: job.jobId, jobType: job.jobType, correlationId: job.correlationId });
          if (job.jobType === "simulate_task") await runSimulationJob(job);
          await completeJob(job.jobId, workerId);
          log("job_completed", { jobId: job.jobId });
        } catch (error) {
          await failJob(job, workerId, error);
          log("job_failed", { jobId: job.jobId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      log("worker_error", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!worked) await new Promise((resolve) => setTimeout(resolve, Number(process.env.WORKER_POLL_MS ?? 500)));
  }
  log("worker_stopped");
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
