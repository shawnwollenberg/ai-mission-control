import { randomUUID } from "node:crypto";
import { closeDatabasePool } from "../lib/database";
import { claimJob, completeJob, failJob } from "../lib/job-store";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
import { deliverRemoteMessage } from "../remote-agent/delivery";
assertSupportedNodeVersion();
const workerId = process.env.WORKER_ID ?? `remote-${randomUUID().slice(0, 8)}`;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  while (!stopping) {
    const job = await claimJob(workerId, 30, undefined, "deliver_remote_agent");
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.WORKER_POLL_MS ?? 500)));
      continue;
    }
    try {
      await deliverRemoteMessage(job.workspaceId!, job.payload);
      await completeJob(job.jobId, workerId);
    } catch (error) {
      await failJob(job, workerId, error);
    }
    if (process.env.REMOTE_AGENT_WORKER_ONCE === "1") stopping = true;
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
