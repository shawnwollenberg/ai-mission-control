import { randomUUID } from "node:crypto";
import { executeAction } from "../application/action-executor";
import { closeDatabasePool } from "../lib/database";
import { claimJob, completeJob, failJob } from "../lib/job-store";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
assertSupportedNodeVersion();
const workerId = process.env.WORKER_ID ?? `action-${randomUUID().slice(0, 8)}`;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  while (!stopping) {
    const job = await claimJob(workerId, 60, undefined, "execute_action");
    if (!job) {
      await new Promise((r) => setTimeout(r, Number(process.env.WORKER_POLL_MS ?? 1000)));
      continue;
    }
    try {
      await executeAction(job.workspaceId!, String(job.payload.actionRequestId), workerId);
      await completeJob(job.jobId, workerId);
    } catch (error) {
      await failJob(job, workerId, error);
    }
    if (process.env.ACTION_WORKER_ONCE === "1") stopping = true;
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
