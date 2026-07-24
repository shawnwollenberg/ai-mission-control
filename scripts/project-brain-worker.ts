import { randomUUID } from "node:crypto";
import { claimJob, completeJob, failJob, renewJobLease } from "../lib/job-store";
import { closeDatabasePool } from "../lib/database";
import { executeProjectBrainOperation } from "../integrations/project-brain/worker";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
import { startWorkerPresence } from "./worker-presence";

assertSupportedNodeVersion();
const workerId = process.env.WORKER_ID ?? `project-brain-${randomUUID().slice(0, 8)}`;
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

async function main() {
  const stopPresence = await startWorkerPresence(workerId, "project_brain");
  const leaseSeconds = Number(process.env.PROJECT_BRAIN_JOB_LEASE_SECONDS ?? 90);
  while (!stopping) {
    const job = await claimJob(workerId, leaseSeconds, undefined, "project_brain_operation");
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.WORKER_POLL_MS ?? 1000)));
      continue;
    }
    const heartbeat = setInterval(() => void renewJobLease(job.jobId, workerId, leaseSeconds), 30_000);
    try {
      await executeProjectBrainOperation({
        workspaceId: job.workspaceId!,
        operationId: String(job.payload.operationId),
        workerId,
        finalAttempt: job.attempts >= job.maxAttempts,
      });
      await completeJob(job.jobId, workerId);
    } catch (error) {
      await failJob(job, workerId, error);
    } finally {
      clearInterval(heartbeat);
    }
    if (process.env.PROJECT_BRAIN_WORKER_ONCE === "1") stopping = true;
  }
  await stopPresence();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
