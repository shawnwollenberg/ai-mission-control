import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const script = "public/mission-agent-0.1.0.mjs";
const baseConfig = {
  missionControlUrl: "https://app.missioncontrol.example",
  workspaceId: "3ae5d14a-f57a-4a8a-bc98-65d58b99a214",
  workspaceName: "Test Workspace",
  agentId: "b33c427d-209a-49c5-9d0b-1b10d21ad7bf",
  agentName: "Codex",
  credentialId: "9898d264-2a77-4438-b85d-c2c601df6dd8",
  secret: "mc_agent_secret_that_must_never_be_printed",
  secretStorage: "file-0600",
  adapter: "codex",
  repositories: {},
};

test("status is secret-safe and protected configuration is accepted", async () => {
  const home = await mkdtemp(join(tmpdir(), "mission-agent-cli-"));
  await writeFile(join(home, "config.json"), JSON.stringify(baseConfig), { mode: 0o600 });
  await writeFile(
    join(home, "state.json"),
    JSON.stringify({ connected: true, pullReady: true, lastHeartbeatAt: "2026-07-19T12:00:00Z" }),
    { mode: 0o600 },
  );
  const result = await run(process.execPath, [script, "status"], { env: { ...process.env, MISSION_AGENT_HOME: home } });
  assert.match(result.stdout, /Connected: yes/);
  assert.match(result.stdout, /Adapter: codex/);
  assert.doesNotMatch(result.stdout, /mc_agent_/);
  assert.doesNotMatch(result.stdout, /credential/i);
});

test("unsafe credential-file permissions are rejected", async () => {
  const home = await mkdtemp(join(tmpdir(), "mission-agent-unsafe-"));
  const path = join(home, "config.json");
  await writeFile(path, JSON.stringify(baseConfig), { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(
    run(process.execPath, [script, "status"], { env: { ...process.env, MISSION_AGENT_HOME: home } }),
    /Unsafe permissions/,
  );
});

test("logout requires explicit confirmation", async () => {
  const home = await mkdtemp(join(tmpdir(), "mission-agent-logout-"));
  await writeFile(join(home, "config.json"), JSON.stringify(baseConfig), { mode: 0o600 });
  await assert.rejects(
    run(process.execPath, [script, "logout"], { env: { ...process.env, MISSION_AGENT_HOME: home } }),
    /logout --yes/,
  );
  const status = await run(process.execPath, [script, "status"], { env: { ...process.env, MISSION_AGENT_HOME: home } });
  assert.match(status.stdout, /Agent: Codex/);
});
