import { closeDatabasePool } from "../lib/database";
import { assertSupportedNodeVersion } from "../lib/runtime-version";
import {
  claimNotificationDelivery,
  ControlledNotificationProvider,
  deliverNotification,
  releaseDueDigests,
} from "../application/notification-delivery";
import { startWorkerPresence } from "./worker-presence";
assertSupportedNodeVersion();
const workerId = process.env.WORKER_ID ?? `notification-${process.pid}`;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
async function main() {
  const stopPresence = await startWorkerPresence(workerId, "notification");
  console.log(JSON.stringify({ event: "notification_worker_started", mode: "durable_external", workerId }));
  const provider = new ControlledNotificationProvider();
  while (!stopping) {
    await releaseDueDigests();
    const row = await claimNotificationDelivery(workerId);
    if (row)
      console.log(
        JSON.stringify({
          event: "notification_delivery_processed",
          deliveryId: row.delivery_id,
          ...(await deliverNotification(row, provider)),
        }),
      );
    else if (process.env.NOTIFICATION_ONCE === "1") break;
    else await new Promise((resolve) => setTimeout(resolve, Number(process.env.NOTIFICATION_POLL_MS ?? 1000)));
  }
  console.log(JSON.stringify({ event: "notification_worker_stopped", workerId }));
  await stopPresence();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
