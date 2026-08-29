import { NextResponse } from "next/server";
import { requireWorkerAuthentication } from "@/v2/worker/auth";
import { WorkerControlPlane } from "@/v2/worker/control-plane";
import { PostgresWorkerCoordinationStore } from "@/v2/worker/store";
import { validateWorkerHealth, validateWorkerResult, type WorkerHealth, type WorkerResult } from "@/v2/worker/protocol";

export async function POST(request: Request) {
  try {
    requireWorkerAuthentication(request);
    const body = (await request.json()) as { health: WorkerHealth; result: WorkerResult };
    validateWorkerHealth(body.health);
    const store = new PostgresWorkerCoordinationStore();
    const expected = await store.get(body.result.dispatchId);
    if (!expected) throw new Error("Unknown worker dispatch");
    validateWorkerResult(body.result, expected);
    const accepted = await store.complete(body.health, body.result);
    const mission = await new WorkerControlPlane(store).commitResult(accepted.dispatch, body.result);
    return NextResponse.json({
      accepted: true,
      duplicate: accepted.duplicate,
      resultingGitHubRevision: mission.latestRevision,
    });
  } catch (error) {
    const message = (error as Error).message;
    const code = ["WORKER_UNAUTHORIZED", "STALE_WORKER_RESULT", "Unknown worker dispatch"].includes(message)
      ? message
      : "WORKER_RESULT_REJECTED";
    const status = message === "WORKER_UNAUTHORIZED" ? 401 : message === "STALE_WORKER_RESULT" ? 409 : 422;
    return NextResponse.json({ error: { code, message: "Worker result rejected" } }, { status });
  }
}
