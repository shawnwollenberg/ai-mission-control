import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const script = resolve("public/mission-agent-0.6.3.mjs");
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

test("connect explains that it must run inside a Git repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mission-agent-no-repository-"));
  const home = join(directory, "home");
  const encoded = Buffer.from(JSON.stringify({ ...baseConfig, agentType: "codex" })).toString("base64url");
  await assert.rejects(
    run(process.execPath, [script, "connect", encoded, "--no-start"], {
      cwd: directory,
      env: {
        ...process.env,
        MISSION_AGENT_HOME: home,
        MISSION_AGENT_SECRET_STORE: "file",
      },
    }),
    /Run this command from inside a Git repository.*--repository \/absolute\/path\/to\/repository/,
  );
});

test("repository list uses safe metadata and never prints local paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "mission-agent-repositories-"));
  const config = {
    ...baseConfig,
    repositories: {
      "repository-1": {
        path: "/private/source/office-anywhere",
        name: "office-anywhere",
        remoteUrl: "git@github.com:example/office-anywhere.git",
        branch: "main",
      },
    },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const result = await run(process.execPath, [script, "repository", "list"], {
    env: { ...process.env, MISSION_AGENT_HOME: home },
  });
  assert.match(result.stdout, /repository-1\toffice-anywhere\tgithub.com\/example\/office-anywhere\tmain/);
  assert.doesNotMatch(result.stdout, /private\/source/);
});

test("stable launcher installation preserves credentials and repositories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mission-agent-install-"));
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify(baseConfig), { mode: 0o600 });
  await run(process.execPath, [script, "install"], {
    env: { ...process.env, MISSION_AGENT_HOME: home, MISSION_AGENT_BIN_DIR: bin },
  });
  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")), baseConfig);
  assert.match(await readFile(join(bin, "mission-agent"), "utf8"), /mission-agent-0\.6\.3\.mjs/);
});

test("change missions retain the approval, isolation, evidence, and no-push safety boundary", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /ExecutionApprovalRequested/);
  assert.match(source, /acknowledgement = acknowledgement\.result/);
  assert.match(source, /requested\.status !== "approval_required"/);
  assert.match(source, /actionType: "repository\.modify"/);
  assert.match(source, /"worktree", "add"/);
  assert.match(source, /"workspace-write"/);
  assert.match(source, /type: "git_patch"/);
  assert.match(source, /type: "validation_results"/);
  assert.match(source, /Local commit/);
  assert.doesNotMatch(source, /spawn(?:Sync)?\("git", \["push"/);
  assert.doesNotMatch(source, /spawn(?:Sync)?\("gh", \["pr"/);
});

test("analysis emits a separately validated structured recommendation artifact", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /type: "repository_recommendations"/);
  assert.match(source, /estimatedImpact \(low\|medium\|high\|critical\)/);
  assert.match(source, /A strength or risk requires visible repository-relative file evidence/);
  assert.match(source, /ExecutionHeartbeat/);
  assert.match(source, /always an array of one or more objects/);
  assert.match(source, /acceptanceCriteria \(always an array of one or more concrete criterion strings\)/);
  assert.match(source, /Read-only recommendation verification detected a repository change/);
  assert.match(source, /type: "repository_health_observations"/);
  assert.match(source, /architecture, tests, security, technical_debt, documentation, dependencies, and ci/);
});
