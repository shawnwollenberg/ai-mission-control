import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadV2Configuration } from "../v2/runtime/config";

const exec = promisify(execFile);
const directory = process.env.MISSION_CONTROL_V2_DATA_DIR ?? join(process.cwd(), ".mission-control-v2-runtime");
const pidPath = join(directory, "local-subscription-worker.pid");
const lockPath = join(directory, "local-subscription-worker.lock");
const logPath = join(directory, "local-subscription-worker.log");
const command = process.argv[2] ?? "status";

async function pid() {
  try {
    return Number((await readFile(pidPath, "utf8")).trim());
  } catch {
    return undefined;
  }
}
async function lockPid() {
  try {
    return Number((await readFile(lockPath, "utf8")).trim());
  } catch {
    return undefined;
  }
}
async function actualPid() {
  const recorded = await pid();
  if (alive(recorded)) return recorded;
  const owner = await lockPid();
  return alive(owner) ? owner : undefined;
}
function alive(value: number | undefined) {
  if (!value) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

async function setup() {
  if (!process.env.MISSION_CONTROL_V2_ENDPOINT || !process.env.MISSION_CONTROL_V2_WORKER_TOKEN)
    throw new Error("Set MISSION_CONTROL_V2_ENDPOINT and MISSION_CONTROL_V2_WORKER_TOKEN locally");
  const config = await loadV2Configuration();
  for (const project of config.projects.filter((item) => item.active)) {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd: project.localCheckout });
    if (!stdout.includes(project.githubRepo)) throw new Error(`Checkout mismatch: ${project.projectId}`);
  }
  await exec("npx", ["codex", "login", "status"]);
  console.log(`Ready: ${config.projects.filter((item) => item.active).length} projects; Codex login available`);
}

async function start() {
  const existing = await actualPid();
  if (alive(existing)) throw new Error(`Worker already running (pid ${existing})`);
  await setup();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/v2-worker.ts"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  const pidFile = await open(pidPath, "w", 0o600);
  await pidFile.writeFile(`${child.pid}\n`);
  await pidFile.close();
  await log.close();
  console.log(`Worker started (pid ${child.pid}); log ${logPath}`);
}

async function stop() {
  const value = await actualPid();
  if (!alive(value)) {
    await unlink(pidPath).catch(() => undefined);
    console.log("Worker is stopped");
    return;
  }
  process.kill(value!, "SIGTERM");
  await unlink(pidPath).catch(() => undefined);
  console.log(`Worker stop requested (pid ${value})`);
}

async function status() {
  const recorded = await pid();
  const value = await actualPid();
  if (value && value !== recorded) {
    const pidFile = await open(pidPath, "w", 0o600);
    await pidFile.writeFile(`${value}\n`);
    await pidFile.close();
  }
  if (!value && recorded) await unlink(pidPath).catch(() => undefined);
  console.log(alive(value) ? `Worker running (pid ${value})` : "Worker stopped");
}

async function main() {
  if (command === "setup") await setup();
  else if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "status") await status();
  else if (command === "reconnect") {
    await stop();
    await start();
  } else throw new Error("Use setup, start, stop, status, or reconnect");
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
