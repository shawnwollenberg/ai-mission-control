import { NextResponse } from "next/server";
import { requireWorkerAuthentication } from "@/v2/worker/auth";
import { PostgresWorkerCoordinationStore } from "@/v2/worker/store";
import { validateWorkerHealth, type WorkerHealth } from "@/v2/worker/protocol";

export async function POST(request: Request) {
  try {
    requireWorkerAuthentication(request);
    const health = (await request.json()) as WorkerHealth;
    validateWorkerHealth(health);
    const store = new PostgresWorkerCoordinationStore();
    await store.fail(
      health,
      health.status === "DEGRADED" ? health.currentDispatchId : undefined,
      health.status === "AUTH_REQUIRED"
        ? "CODEX_AUTHENTICATION_EXPIRED"
        : (health.failureCode ?? "PROVIDER_PROCESS_FAILED"),
    );
    return NextResponse.json({ accepted: true });
  } catch (error) {
    const code = (error as Error).message === "WORKER_UNAUTHORIZED" ? "WORKER_UNAUTHORIZED" : "WORKER_HEALTH_REJECTED";
    return NextResponse.json({ error: { code, message: "Worker health rejected" } }, { status: 401 });
  }
}
