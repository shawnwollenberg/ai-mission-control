import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for end-to-end tests");

const port = 31_119;
const origin = `http://127.0.0.1:${port}`;
let server;
let serverOutput = "";
let worker;
const run = promisify(execFile);

async function startServer() {
  serverOutput = "";
  server = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      MISSION_CONTROL_SESSION_SECRET: process.env.MISSION_CONTROL_SESSION_SECRET,
      PUBLIC_APP_URL: origin,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += String(chunk);
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Mission Control did not start:\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
}
function startWorker() {
  worker = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/worker.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, WORKER_POLL_MS: "25" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  worker.kill("SIGTERM");
  await new Promise((resolve) => worker.once("exit", resolve));
}

function browserHeaders(cookie, extra = {}) {
  return { origin, ...(cookie ? { cookie } : {}), ...extra };
}

async function login() {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: browserHeaders(undefined, { "content-type": "application/json" }),
    body: JSON.stringify({ email: "owner@example.com", password: "mission-control-local-test" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function lifecycle(cookie, missionId, command, expectedVersion, idempotencyKey = crypto.randomUUID()) {
  return fetch(`${origin}/api/missions/${missionId}/${command}`, {
    method: "POST",
    headers: browserHeaders(cookie, { "content-type": "application/json", "idempotency-key": idempotencyKey }),
    body: JSON.stringify({ expectedVersion }),
  });
}

test("authenticated durable browser mission survives restart and enforces lifecycle authority", async () => {
  await startServer();
  try {
    const protectedPage = await fetch(`${origin}/missions`, { redirect: "manual" });
    assert.equal(protectedPage.status, 307);
    assert.match(protectedPage.headers.get("location"), /^\/login\?next=/);

    const unauthenticatedApi = await fetch(`${origin}/api/missions`);
    assert.equal(unauthenticatedApi.status, 401);

    const invalidOrigin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { origin: "https://invalid.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "mission-control-local-test" }),
    });
    assert.equal(invalidOrigin.status, 403);

    const invalidLoginStartedAt = Date.now();
    const invalidLogin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: browserHeaders(undefined, { "content-type": "application/json" }),
      body: JSON.stringify({ email: "unknown@example.com", password: "definitely-wrong" }),
    });
    assert.equal(invalidLogin.status, 401);
    assert.deepEqual(await invalidLogin.json(), { error: "Invalid credentials" });
    assert.ok(Date.now() - invalidLoginStartedAt >= 450);

    let cookie = await login();
    const commandId = crypto.randomUUID();
    const missionBody = {
      name: "Production Mission Persistence Test",
      objective: "Prove browser state is durable",
      domain: "software_delivery",
      priority: "high",
      riskLevel: "unknown",
      workspaceId: "00000000-0000-4000-8000-ffffffffffff",
      status: "completed",
    };
    const createHeaders = browserHeaders(cookie, {
      "content-type": "application/json",
      "idempotency-key": commandId,
    });
    const createdResponse = await fetch(`${origin}/api/missions`, {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(missionBody),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.projection.status, "draft");
    assert.notEqual(created.projection.workspaceId, missionBody.workspaceId);

    const duplicateResponse = await fetch(`${origin}/api/missions`, {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(missionBody),
    });
    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).missionId, created.missionId);

    const listResponse = await fetch(`${origin}/api/missions`, { headers: browserHeaders(cookie) });
    assert.equal(listResponse.status, 200);
    assert.ok((await listResponse.json()).missions.some((mission) => mission.missionId === created.missionId));

    const detailResponse = await fetch(`${origin}/missions/${created.missionId}`, { headers: browserHeaders(cookie) });
    assert.equal(detailResponse.status, 200);
    const detailHtml = await detailResponse.text();
    assert.match(detailHtml, /Production Mission Persistence Test/);
    assert.match(detailHtml, /Simulated execution/);

    const timelineResponse = await fetch(`${origin}/api/missions/${created.missionId}/events`, {
      headers: browserHeaders(cookie),
    });
    const initialTimeline = (await timelineResponse.json()).timeline;
    assert.deepEqual(
      initialTimeline.map((entry) => entry.eventType),
      ["mission.created"],
    );

    let transition = await lifecycle(cookie, created.missionId, "plan", 1);
    assert.equal(transition.status, 200);
    assert.equal((await transition.json()).projection.status, "planned");
    transition = await lifecycle(cookie, created.missionId, "start", 2);
    assert.equal((await transition.json()).projection.status, "running");
    transition = await lifecycle(cookie, created.missionId, "pause", 3);
    assert.equal((await transition.json()).projection.status, "paused");

    const stale = await lifecycle(cookie, created.missionId, "resume", 2);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "concurrency_conflict");

    await stopServer();
    await startServer();
    const persisted = await fetch(`${origin}/missions/${created.missionId}`, { headers: browserHeaders(cookie) });
    assert.equal(persisted.status, 200);
    assert.match(await persisted.text(), /paused/);

    transition = await lifecycle(cookie, created.missionId, "resume", 4);
    assert.equal((await transition.json()).projection.status, "running");
    startWorker();
    await stopWorker();
    startWorker();
    let execution;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${origin}/api/missions/${created.missionId}/execution`, {
        headers: browserHeaders(cookie),
      });
      execution = await response.json();
      if (execution.approvals?.some((item) => item.status === "pending")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const approval = execution.approvals.find((item) => item.status === "pending");
    assert.ok(approval, "simulated execution should reach its approval boundary");
    const decision = await fetch(`${origin}/api/approvals/${approval.approvalId}/decision`, {
      method: "POST",
      headers: browserHeaders(cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ decision: "grant", reason: "E2E evidence accepted" }),
    });
    assert.equal(decision.status, 200);
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${origin}/api/missions/${created.missionId}/execution`, {
        headers: browserHeaders(cookie),
      });
      execution = await response.json();
      if (execution.mission.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(execution.mission.status, "completed");
    assert.equal(execution.tasks.filter((item) => item.status === "completed").length, 7);

    const terminal = await lifecycle(cookie, created.missionId, "resume", 6);
    assert.equal(terminal.status, 409);
    assert.equal((await terminal.json()).error.code, "invalid_transition");

    const logout = await fetch(`${origin}/logout`, { headers: browserHeaders(cookie), redirect: "manual" });
    assert.equal(logout.status, 307);
    cookie = "";
    const afterLogout = await fetch(`${origin}/missions/${created.missionId}`, { redirect: "manual" });
    assert.equal(afterLogout.status, 307);

    cookie = await login();
    const afterRelogin = await fetch(`${origin}/missions/${created.missionId}`, { headers: browserHeaders(cookie) });
    assert.equal(afterRelogin.status, 200);
    assert.match(await afterRelogin.text(), /completed/);

    const finalTimelineResponse = await fetch(`${origin}/api/missions/${created.missionId}/events`, {
      headers: browserHeaders(cookie),
    });
    const finalTimeline = (await finalTimelineResponse.json()).timeline;
    const eventTypes = finalTimeline.map((entry) => entry.eventType);
    assert.equal(eventTypes[0], "mission.created");
    assert.ok(eventTypes.includes("task.dependency_added"));
    assert.ok(eventTypes.includes("approval.granted"));
    assert.equal(eventTypes.at(-1), "mission.completed");
  } finally {
    await stopWorker();
    await stopServer();
  }
});

test("guided onboarding creates a credential and advances after the connector heartbeat", async () => {
  await startServer();
  try {
    const cookie = await login();
    const onboarding = await fetch(`${origin}/onboarding`, { headers: browserHeaders(cookie) });
    assert.equal(onboarding.status, 200);
    assert.match(await onboarding.text(), /Let’s connect your first agent/);

    const response = await fetch(`${origin}/api/onboarding/connect`, {
      method: "POST",
      headers: browserHeaders(cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ agentType: "codex" }),
    });
    assert.equal(response.status, 201);
    const connection = await response.json();
    assert.equal(connection.agentName, "Codex");
    assert.match(connection.command, /^curl -fsSL .*\/connect-agent\.mjs \| node -- --install '/);
    const encoded = connection.command.match(/--install '([^']+)'$/)?.[1];
    assert.ok(encoded);
    const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const directory = await mkdtemp(join(tmpdir(), "mc-e2e-connector-"));
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    await run(process.execPath, ["public/connect-agent.mjs", "--run", configPath, "--once"]);

    const agentsResponse = await fetch(`${origin}/api/agents`, { headers: browserHeaders(cookie) });
    assert.equal(agentsResponse.status, 200);
    const agents = (await agentsResponse.json()).agents;
    const connected = agents.find((agent) => agent.agent_id === connection.agentId);
    assert.ok(connected.last_heartbeat_at);
    assert.equal(connected.credential_status, "active");
  } finally {
    await stopServer();
  }
});
