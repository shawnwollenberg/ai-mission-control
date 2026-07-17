import { cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { MissionControlClient } from "./mission-control-client";
import type { MissionEvent } from "../../lib/mission-events";

const fixtureRoot = path.resolve(process.cwd(), "fixtures/servicepilot-pricing");
const allowedPaths = ["src/pricing-plans.ts", "tests/pricing-plans.test.mjs"];
const validationCommand = "node --import tsx --test tests/pricing-plans.test.mjs";
const tsxLoader = path.resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");
const codexExecutionTimeoutMs = Number(process.env.MISSION_CONTROL_CODEX_EXECUTION_TIMEOUT_MS ?? 150_000);
const validationTimeoutMs = Number(process.env.MISSION_CONTROL_VALIDATION_TIMEOUT_MS ?? 20_000);

function run(command: string, args: string[], cwd: string, timeoutMs = 30_000) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: "1" } });
    let output = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, output });
    };
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(124);
    }, timeoutMs);
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(1));
  });
}

async function artifactIsExpected(workspace: string) {
  const plans = await readFile(path.join(workspace, "src/pricing-plans.ts"), "utf8");
  const tests = await readFile(path.join(workspace, "tests/pricing-plans.test.mjs"), "utf8");
  return plans.includes('name: "Growth Annual"') && plans.includes("annualPrice: 490") && tests.includes("Growth Annual");
}

function event(missionId: string, type: MissionEvent["type"], message: string, detail?: string, artifact?: MissionEvent["data"]["artifact"]): Omit<MissionEvent, "sequence" | "schemaVersion"> {
  return {
    eventId: randomUUID(), missionId, type, occurredAt: new Date().toISOString(),
    producer: { kind: "agent", id: "hermes", label: "Hermes" }, correlationId: missionId,
    subject: { kind: "task", id: "task-servicepilot-pricing" }, data: { message, ...(detail ? { detail } : {}), ...(artifact ? { artifact } : {}) },
  };
}

function validate(workspace: string) {
  return run(process.execPath, ["--import", tsxLoader, "--test", "tests/pricing-plans.test.mjs"], workspace, validationTimeoutMs);
}

export async function runCodexPricingTask(missionId: string, baseUrl: string, token: string) {
  const client = new MissionControlClient(baseUrl, token);
  const [assignment] = await client.assignments(missionId);
  if (!assignment || assignment.subject?.id !== "task-servicepilot-pricing") throw new Error("No unclaimed ServicePilot pricing assignment");
  await client.claim(missionId, assignment.subject.id);
  await client.publish(event(missionId, "task.started", "Codex pricing task started", "Hermes prepared an isolated ServicePilot workspace"));

  const workspace = await mkdtemp(path.join(os.tmpdir(), "mission-control-servicepilot-"));
  await cp(fixtureRoot, workspace, { recursive: true, filter: (source) => !source.includes(`${path.sep}fallback${path.sep}`) });
  const prompt = [
    "Complete one bounded ServicePilot pricing task.",
    "Edit only src/pricing-plans.ts and tests/pricing-plans.test.mjs.",
    "Add Growth Annual with annualPrice 490 and interval year.",
    "Update the pricing test for that annual option.",
    "Do not edit src/checkout-preview.ts; preserve its controlled checkout behavior.",
    `Run: ${validationCommand}`,
  ].join("\n");
  const codexArgs = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", "-C", workspace];
  if (process.env.MISSION_CONTROL_CODEX_MODEL) codexArgs.push("-m", process.env.MISSION_CONTROL_CODEX_MODEL);
  const execution = await run(process.env.MISSION_CONTROL_CODEX_COMMAND ?? "codex", [...codexArgs, prompt], workspace, codexExecutionTimeoutMs);
  let provenance: "live" | "validated_fallback" = "live";
  let validation = await validate(workspace);
  if (execution.code !== 0 || validation.code !== 0 || !(await artifactIsExpected(workspace))) {
    provenance = "validated_fallback";
    await cp(path.join(fixtureRoot, "fallback", "pricing-plans.ts"), path.join(workspace, "src/pricing-plans.ts"));
    await cp(path.join(fixtureRoot, "fallback", "pricing-plans.test.mjs"), path.join(workspace, "tests/pricing-plans.test.mjs"));
    validation = await validate(workspace);
  }
  if (validation.code !== 0 || !(await artifactIsExpected(workspace))) throw new Error("Live and fallback pricing artifacts failed validation");
  await client.publish(event(missionId, "artifact.created", "Annual pricing artifact produced", provenance === "live" ? "Codex produced the verified annual plan" : "Previously validated fallback artifact used", {
    kind: "git_diff", path: "src/pricing-plans.ts", summary: "Added Growth Annual at $490/year", validation: "pricing-plans tests passed", provenance,
  }));
  await client.publish(event(missionId, "check.completed", "Pricing validation passed", validationCommand));
  await client.publish(event(missionId, "task.completed", "Codex pricing task completed", provenance === "live" ? "Verified live artifact" : "Verified fallback artifact"));
  await client.publish(event(missionId, "preview.ready", "Controlled checkout preview ready", "Existing local checkout preview preserved"));
  await client.publish(event(missionId, "mission.completed", "Mission complete", provenance === "live" ? "Live Codex artifact verified" : "Validated fallback artifact verified"));
  return { workspace, provenance };
}

if (process.argv[1]?.endsWith("run-codex-pricing.ts")) {
  const [missionId, baseUrl = "http://localhost:3000", token = process.env.MISSION_CONTROL_AGENT_TOKEN] = process.argv.slice(2);
  if (!missionId || !token) throw new Error("Usage: tsx agents/hermes/run-codex-pricing.ts <missionId> [baseUrl] <token>");
  runCodexPricingTask(missionId, baseUrl, token).then(console.log).catch((error) => { console.error(error); process.exitCode = 1; });
}
