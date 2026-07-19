import { randomUUID } from "node:crypto";
import { recordWorkerHeartbeat, requestWorkerShutdown } from "../application/worker-operations";
export async function startWorkerPresence(
  workerId: string,
  workerType: string,
  workspaceId = process.env.WORKSPACE_ID,
) {
  if (!workspaceId) return async () => {};
  const heartbeatIntervalSeconds = Number(process.env.WORKER_HEARTBEAT_SECONDS ?? 15);
  const heartbeat = () =>
    recordWorkerHeartbeat({
      workspaceId,
      workerId,
      workerType,
      heartbeatIntervalSeconds,
      readiness: {
        database: { ok: true, summary: "Database heartbeat committed" },
        runtime: { ok: true, summary: `Node ${process.versions.node}` },
      },
    });
  await heartbeat();
  const timer = setInterval(
    () =>
      void heartbeat().catch((error) =>
        console.error(
          JSON.stringify({
            event: "worker_heartbeat_failed",
            workerId,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    heartbeatIntervalSeconds * 1000,
  );
  timer.unref();
  return async () => {
    clearInterval(timer);
    await requestWorkerShutdown({ workspaceId, workerId, graceful: true, commandId: randomUUID() });
  };
}
