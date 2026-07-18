import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const exec = promisify(execFile);
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { handleCreateMission, handleMissionTransition } = await import("../application/mission-commands.ts");
const { handleCreateTask } = await import("../application/task-commands.ts");
const { registerAgent, registerRepository } = await import("../application/registry.ts");
const { handleRequestExecution } = await import("../application/execution-commands.ts");
const { executeCodex } = await import("../execution/codex-adapter.ts");
const workspaceId = randomUUID(),
  actor = { workspaceId, userId: "owner", role: "owner" },
  executionActor = { workspaceId, id: "owner", type: "human" };
let root, repository, worktrees, artifacts;
test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mission-control-codex-"));
  repository = path.join(root, "repository");
  worktrees = path.join(root, "worktrees");
  artifacts = path.join(root, "artifacts");
  await cp(path.resolve("fixtures/codex-health-app"), repository, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "initial"], {
    cwd: repository,
  });
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Codex Execution')", [
    workspaceId,
    `codex-${workspaceId}`,
  ]);
});
test.after(async () => {
  for (const table of [
    "outbox",
    "dead_letters",
    "jobs",
    "execution_heartbeats",
    "artifacts",
    "approval_projections",
    "mission_projections",
    "events",
    "commands",
    "aggregate_heads",
    "repositories",
    "agents",
  ])
    await getDatabasePool().query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
  await rm(root, { recursive: true, force: true });
});
test("controlled Codex adapter completes in an isolated worktree with evidence and no push", async () => {
  const agentId = randomUUID(),
    repositoryId = randomUUID();
  await registerAgent({
    actor,
    agentId,
    name: "Controlled Codex",
    adapterType: "codex",
    capabilities: [
      "repository.read",
      "repository.write",
      "code.implement",
      "test.run",
      "artifact.create",
      "git.commit",
    ],
    supportedDomains: ["software_delivery"],
    trustLevel: "controlled",
    concurrencyLimit: 1,
    credentialReference: "env:CODEX_HOME",
  });
  await registerRepository({
    actor,
    repositoryId,
    name: "Health fixture",
    localPath: repository,
    defaultBranch: "main",
    allowedAgentIds: [agentId],
    readAllowed: true,
    writeAllowed: true,
    commitAllowed: true,
    validationCommands: [[process.execPath, "--test", "health.test.mjs"]],
  });
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Health metadata",
      objective: "Add service metadata to the health check",
      domain: "software_delivery",
      priority: "normal",
      riskLevel: "low",
    },
  });
  const task = await handleCreateTask({
    actor: executionActor,
    commandId: randomUUID(),
    task: {
      missionId: mission.missionId,
      name: "Add health metadata",
      instructions: "Add service sample-app to the health response and update tests",
      expectedOutput: "Passing health metadata test",
      priority: "normal",
      riskLevel: "low",
      timeoutSeconds: 120,
    },
  });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "planned" });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "running" });
  const requested = await handleRequestExecution({
    actor: executionActor,
    commandId: randomUUID(),
    taskId: task.taskId,
    agentId,
    repositoryId,
    timeoutSeconds: 120,
  });
  Object.assign(process.env, {
    CODEX_REPOSITORY_ROOT: root,
    CODEX_WORKTREE_ROOT: worktrees,
    ARTIFACT_STORAGE_ROOT: artifacts,
    CODEX_EXECUTABLE: process.execPath,
    CODEX_EXECUTABLE_ARGS_JSON: JSON.stringify([path.resolve("fixtures/codex-runtime/controlled-codex.mjs")]),
  });
  const outcome = await executeCodex({
    workspaceId,
    executionId: requested.executionId,
    workerId: "integration-codex",
  });
  assert.equal(outcome.status, "succeeded");
  assert.match(await readFile(path.join(outcome.worktreePath, "health.mjs"), "utf8"), /sample-app/);
  assert.doesNotMatch(await readFile(path.join(repository, "health.mjs"), "utf8"), /sample-app/);
  assert.ok(outcome.commitId);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM artifacts WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, requested.executionId],
      )
    ).rows[0].count >= 5,
    true,
  );
  const policy = (
    await getDatabasePool().query(
      "SELECT push_allowed,merge_allowed,deployment_allowed FROM repositories WHERE workspace_id=$1 AND repository_id=$2",
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.deepEqual(policy, { push_allowed: false, merge_allowed: false, deployment_allowed: false });
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2", [
        workspaceId,
        mission.missionId,
      ])
    ).rows[0].status,
    "completed",
  );
});
