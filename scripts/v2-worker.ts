import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { CodexSdkArchitectAdapter } from "../v2/adapters/codex-sdk-architect";
import { CodexSdkEngineerAdapter } from "../v2/adapters/codex-sdk-engineer";
import { JsonBindingStore } from "../v2/runtime/bindings";
import { loadV2Configuration } from "../v2/runtime/config";
import { classifyProviderFailure } from "../v2/runtime/operational-errors";
import type { WorkerDispatch, WorkerHealth, WorkerResult } from "../v2/worker/protocol";
import { LocalSubscriptionWorker } from "../v2/worker/provider-worker";

const exec = promisify(execFile);
const dataDirectory = process.env.MISSION_CONTROL_V2_DATA_DIR ?? join(process.cwd(), ".mission-control-v2-runtime");
const lockPath = join(dataDirectory, "local-subscription-worker.lock");
const endpoint = process.env.MISSION_CONTROL_V2_ENDPOINT?.replace(/\/$/, "");
const token = process.env.MISSION_CONTROL_V2_WORKER_TOKEN;
const workerId = process.env.MISSION_CONTROL_V2_WORKER_ID ?? "owner-mac";
const displayName = process.env.MISSION_CONTROL_V2_WORKER_NAME ?? "Owner Mac";
const intervalMs = Number(process.env.MISSION_CONTROL_V2_POLL_INTERVAL_MS ?? 5_000);
const once = process.argv.includes("--once");
const sessionId = randomUUID();
const bindings = new JsonBindingStore(join(dataDirectory, "provider-bindings.json"));
let stopping = false;

function health(status: WorkerHealth["status"] = "ONLINE", currentDispatchId?: string): WorkerHealth {
  return {
    schema: "mc.worker-health/v1",
    workerId,
    displayName,
    sessionId,
    status,
    ...(currentDispatchId ? { currentDispatchId } : {}),
    architectAvailable: true,
    engineerAvailable: true,
  };
}

async function post(path: string, body: unknown) {
  if (!endpoint || !token)
    throw new Error("MISSION_CONTROL_V2_ENDPOINT and MISSION_CONTROL_V2_WORKER_TOKEN are required");
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.code ?? `Worker endpoint returned ${response.status}`);
  return value;
}

async function verifyCheckout(path: string, expectedRepo: string) {
  const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd: path });
  const normalized = stdout
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  if (normalized !== `https://github.com/${expectedRepo}`) throw new Error("PROJECT_CHECKOUT_MISMATCH");
}

async function execute(dispatch: WorkerDispatch): Promise<WorkerResult> {
  const configuration = await loadV2Configuration();
  const project = configuration.projects.find((item) => item.active && item.projectId === dispatch.projectId);
  if (!project || project.githubRepo !== dispatch.packet.constitution.repository)
    throw new Error("PROJECT_CONFIGURATION_MISMATCH");
  await verifyCheckout(project.localCheckout, project.githubRepo);
  let binding = (await bindings.get(dispatch.missionId)) ?? {
    missionId: dispatch.missionId,
    projectId: dispatch.projectId,
    issueNumber: dispatch.issueNumber,
    lastProcessedRevision: dispatch.missionRevision,
  };
  if (binding.projectId !== dispatch.projectId || binding.issueNumber !== dispatch.issueNumber)
    throw new Error("MISSION_BINDING_MISMATCH");
  if (binding.inFlight?.result && binding.inFlight.result.revision <= dispatch.missionRevision)
    binding = await bindings.update(dispatch.missionId, (stored) => ({ ...stored!, inFlight: undefined }));
  if (
    binding.inFlight?.idempotencyKey === dispatch.idempotencyKey &&
    binding.inFlight.result &&
    binding.inFlight.providerThreadId
  )
    return {
      schema: "mc.worker-result/v1",
      dispatchId: dispatch.dispatchId,
      idempotencyKey: dispatch.idempotencyKey,
      missionId: dispatch.missionId,
      missionRevision: dispatch.missionRevision,
      actor: dispatch.actor,
      result: binding.inFlight.result,
      providerThreadId: binding.inFlight.providerThreadId,
    };
  if (binding.inFlight && binding.inFlight.idempotencyKey !== dispatch.idempotencyKey)
    throw new Error("PROVIDER_DISPATCH_INDETERMINATE");
  binding = await bindings.update(dispatch.missionId, (stored) => ({
    ...(stored ?? binding),
    sourceMissionDigest: dispatch.missionDigest,
    inFlight: { idempotencyKey: dispatch.idempotencyKey, actor: dispatch.actor, revision: dispatch.missionRevision },
  }));
  if (dispatch.actor === "ENGINEER") {
    const value = await new CodexSdkEngineerAdapter().run({
      mission: dispatch.packet.mission,
      constitution: dispatch.packet.constitution,
      localCheckout: project.localCheckout,
      priorSignal: dispatch.packet.priorSignal,
      threadId: binding.codexThreadId,
    });
    binding = await bindings.update(dispatch.missionId, (stored) => ({
      ...(stored ?? binding),
      codexThreadId: value.threadId,
      inFlight: { ...binding.inFlight!, result: value.report, providerThreadId: value.threadId },
    }));
  } else {
    const value = await new CodexSdkArchitectAdapter().review({
      mission: dispatch.packet.mission,
      constitution: dispatch.packet.constitution,
      localCheckout: project.localCheckout,
      engineerReport: dispatch.packet.latestEngineerReport,
      priorSignal: dispatch.packet.priorSignal,
      architectThreadId: binding.architectThreadId,
    });
    binding = await bindings.update(dispatch.missionId, (stored) => ({
      ...(stored ?? binding),
      architectThreadId: value.architectThreadId,
      inFlight: { ...binding.inFlight!, result: value.decision, providerThreadId: value.architectThreadId },
    }));
  }
  return {
    schema: "mc.worker-result/v1",
    dispatchId: dispatch.dispatchId,
    idempotencyKey: dispatch.idempotencyKey,
    missionId: dispatch.missionId,
    missionRevision: dispatch.missionRevision,
    actor: dispatch.actor,
    result: binding.inFlight!.result!,
    providerThreadId: binding.inFlight!.providerThreadId!,
  };
}

async function tick() {
  const claimed = (await post("/api/v2/worker/dispatches/claim", health())) as { dispatch: WorkerDispatch | null };
  if (!claimed.dispatch) return false;
  const dispatch = claimed.dispatch;
  let result: WorkerResult;
  try {
    result = await new LocalSubscriptionWorker(execute).execute(dispatch);
  } catch (error) {
    const failure = classifyProviderFailure(error, dispatch.actor, dispatch.missionRevision);
    if (failure.code === "CODEX_AUTHENTICATION_EXPIRED")
      await bindings.update(dispatch.missionId, (stored) => ({ ...stored!, inFlight: undefined, failure }));
    await post(
      "/api/v2/worker/health",
      health(failure.code === "CODEX_AUTHENTICATION_EXPIRED" ? "AUTH_REQUIRED" : "DEGRADED", dispatch.dispatchId),
    ).catch(() => undefined);
    console.error(
      JSON.stringify({
        schema: "mc.local-worker/v1",
        event: "dispatch_failed",
        dispatchId: dispatch.dispatchId,
        failureCode: failure.code,
        message: failure.message,
      }),
    );
    return true;
  }
  try {
    await post("/api/v2/worker/dispatches/result", { health: health("ONLINE", dispatch.dispatchId), result });
    await bindings.update(dispatch.missionId, (stored) => ({
      ...stored!,
      lastProcessedRevision: result.result.revision,
      inFlight: undefined,
      failure: undefined,
    }));
    console.info(
      JSON.stringify({
        schema: "mc.local-worker/v1",
        event: "dispatch_completed",
        dispatchId: dispatch.dispatchId,
        projectId: dispatch.projectId,
        missionId: dispatch.missionId,
        actor: dispatch.actor,
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        schema: "mc.local-worker/v1",
        event: "result_upload_deferred",
        dispatchId: dispatch.dispatchId,
        message: "Validated result remains in local retry state",
      }),
    );
  }
  return true;
}

async function acquireLock() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number((await readFile(lockPath, "utf8")).trim());
    try {
      process.kill(owner, 0);
      throw new Error(`Another local subscription worker is active with pid ${owner}`);
    } catch (inner) {
      if ((inner as Error).message.startsWith("Another local")) throw inner;
      await unlink(lockPath);
      return acquireLock();
    }
  }
}
async function releaseLock() {
  try {
    if (Number((await readFile(lockPath, "utf8")).trim()) === process.pid) await unlink(lockPath);
  } catch {}
}

async function main() {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error("Poll interval must be at least 1000ms");
  await acquireLock();
  process.once("SIGINT", () => (stopping = true));
  process.once("SIGTERM", () => (stopping = true));
  try {
    do {
      const worked = await tick();
      if (!once && !stopping) await delay(worked ? 250 : intervalMs);
    } while (!once && !stopping);
  } finally {
    await releaseLock();
  }
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
