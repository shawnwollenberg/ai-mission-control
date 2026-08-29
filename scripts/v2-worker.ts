import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createV2MissionRuntime } from "../v2/runtime/service";
import { loadV2Configuration } from "../v2/runtime/config";
import { V2OperationalError } from "../v2/runtime/operational-errors";

const dataDirectory = process.env.MISSION_CONTROL_V2_DATA_DIR ?? join(process.cwd(), ".mission-control-v2-runtime");
const lockPath = join(dataDirectory, "v2-worker.lock");
const once = process.argv.includes("--once");
const intervalMs = Number(process.env.MISSION_CONTROL_V2_POLL_INTERVAL_MS ?? 15_000);
const concurrency = 3;
let stopping = false;

async function acquireLock() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const owner = Number((await readFile(lockPath, "utf8")).trim());
  try {
    process.kill(owner, 0);
    throw new Error(`Another V2 worker is active with pid ${owner}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Another V2 worker")) throw error;
    await unlink(lockPath);
    return acquireLock();
  }
}

async function releaseLock() {
  try {
    if (Number((await readFile(lockPath, "utf8")).trim()) === process.pid) await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function runBounded<T>(items: T[], task: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await task(queue.shift()!);
    }),
  );
}

async function tick() {
  const configuration = await loadV2Configuration();
  const missions = configuration.projects
    .filter((project) => project.active)
    .flatMap((project) => (project.trackedMissionIssues ?? []).map((issueNumber) => ({ project, issueNumber })));
  await runBounded(missions, async ({ project, issueNumber }) => {
    try {
      const runtime = await createV2MissionRuntime(project.projectId);
      const before = await runtime.store.readMission({ issueNumber });
      const after = await runtime.orchestrator.advance(issueNumber);
      console.info(
        JSON.stringify({
          schema: "mc.worker-tick/v1",
          projectId: project.projectId,
          issueNumber,
          missionId: after.mission.missionId,
          beforeRevision: before.latestRevision,
          afterRevision: after.latestRevision,
          state: after.mission.state,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          schema: "mc.worker-failure/v1",
          projectId: project.projectId,
          issueNumber,
          message:
            error instanceof V2OperationalError
              ? error.message
              : "Mission advance failed; inspect bounded provider/GitHub failure state",
        }),
      );
    }
  });
}

async function main() {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000)
    throw new Error("V2 poll interval must be at least 1000ms");
  await acquireLock();
  process.once("SIGINT", () => (stopping = true));
  process.once("SIGTERM", () => (stopping = true));
  try {
    do {
      await tick();
      if (!once && !stopping) await delay(intervalMs);
    } while (!once && !stopping);
  } finally {
    await releaseLock();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
