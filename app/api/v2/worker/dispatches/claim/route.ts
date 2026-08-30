import { NextResponse } from "next/server";
import { requireWorkerAuthentication } from "@/v2/worker/auth";
import { WorkerControlPlane } from "@/v2/worker/control-plane";
import { PostgresWorkerCoordinationStore } from "@/v2/worker/store";
import { validateWorkerHealth, type WorkerHealth } from "@/v2/worker/protocol";

export async function POST(request: Request) {
  try {
    requireWorkerAuthentication(request);
    const health = (await request.json()) as WorkerHealth;
    validateWorkerHealth(health);
    const store = new PostgresWorkerCoordinationStore();
    await store.heartbeat(health);
    await new WorkerControlPlane(store).synchronizeEligibleDispatches();
    const dispatch = await store.claim(health, 45_000);
    return NextResponse.json({ dispatch: dispatch ?? null });
  } catch (error) {
    const message = (error as Error).message;
    const code = ["WORKER_UNAUTHORIZED", "WORKER_AUTH_NOT_CONFIGURED", "DUPLICATE_WORKER_ACTIVE"].includes(message)
      ? message
      : "WORKER_COORDINATION_UNAVAILABLE";
    const status = message === "WORKER_UNAUTHORIZED" ? 401 : message === "DUPLICATE_WORKER_ACTIVE" ? 409 : 503;
    console.error(
      JSON.stringify({
        schema: "mc.operational-log/v1",
        event: "worker.coordination_rejected",
        failureCode: code,
        reason: message.slice(0, 240),
      }),
    );
    return NextResponse.json({ error: { code, message: "Worker coordination request rejected" } }, { status });
  }
}
