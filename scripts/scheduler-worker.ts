import { randomUUID } from "node:crypto";
import { claimDueSchedule, runClaimedSchedule } from "../application/schedule-commands";
import { closeDatabasePool } from "../lib/database";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
assertSupportedNodeVersion();
const workerId = process.env.WORKER_ID ?? `scheduler-${randomUUID().slice(0, 8)}`;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
async function main() {
  console.log(JSON.stringify({ event: "scheduler_started", workerId }));
  while (!stopping) {
    const row = await claimDueSchedule(workerId);
    if (!row) {
      if (process.env.SCHEDULER_ONCE === "1") break;
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.SCHEDULER_POLL_MS ?? 1000)));
      continue;
    }
    try {
      console.log(
        JSON.stringify({ event: "schedule_processed", workerId, ...(await runClaimedSchedule(row, workerId)) }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "schedule_failed",
          workerId,
          scheduleId: row.schedule_id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (process.env.SCHEDULER_ONCE === "1") break;
  }
  console.log(JSON.stringify({ event: "scheduler_stopped", workerId }));
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
