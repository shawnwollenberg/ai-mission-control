import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const { handleRequestExecution, handleExecutionTransition, handleExecutionFact, handleExecutionCancellation } =
  await import("../application/execution-commands.ts");
const { executeCodex } = await import("../execution/codex-adapter.ts");
const { createExecutionWorktree } = await import("../execution/worktree-manager.ts");
const { readExecutionArtifact } = await import("../execution/artifact-store.ts");
const { requestSensitiveAction, resolveActionApproval } = await import("../application/action-commands.ts");
const { executeAction } = await import("../application/action-executor.ts");
const { expireDueApprovals } = await import("../application/governance-maintenance.ts");
const workspaceId = randomUUID(),
  actor = { workspaceId, userId: "owner", role: "owner" },
  executionActor = { workspaceId, id: "owner", type: "human" };
let root, repository, worktrees, artifacts;
let completedExecution;
const agentId = randomUUID(),
  repositoryId = randomUUID();
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
  completedExecution = { executionId: requested.executionId, outcome };
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
  const artifact = (
    await getDatabasePool().query(
      "SELECT artifact_id,storage_key FROM artifacts WHERE workspace_id=$1 AND execution_id=$2 ORDER BY created_at LIMIT 1",
      [workspaceId, requested.executionId],
    )
  ).rows[0];
  assert.ok(await readExecutionArtifact(workspaceId, artifact.artifact_id));
  assert.equal(await readExecutionArtifact(randomUUID(), artifact.artifact_id), undefined);
  await writeFile(path.join(artifacts, artifact.storage_key), "corrupted");
  await assert.rejects(() => readExecutionArtifact(workspaceId, artifact.artifact_id), /checksum mismatch/);
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
test("denied publication changes no remote and approved publication pushes only the exact commit", async () => {
  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["push", remote, "main:main"], { cwd: repository });
  await exec("git", ["remote", "add", "phase3", remote], { cwd: completedExecution.outcome.worktreePath });
  await getDatabasePool().query(
    "UPDATE repositories SET push_allowed=true,allowed_remotes=$3 WHERE workspace_id=$1 AND repository_id=$2",
    [workspaceId, repositoryId, JSON.stringify(["phase3"])],
  );
  const parameters = { remote: "phase3", branch: completedExecution.outcome.branchName, force: false };
  const denied = await requestSensitiveAction({
    actor: { ...executionActor, role: "owner" },
    commandId: randomUUID(),
    executionId: completedExecution.executionId,
    actionType: "repository.push_branch",
    parameters,
    targetResource: `repository:${repositoryId}`,
  });
  assert.equal(denied.decision.outcome, "require_approval");
  await resolveActionApproval({
    actor: { ...executionActor, role: "owner" },
    approvalId: denied.approvalId,
    granted: false,
    reason: "Exercise denial boundary",
  });
  const absent = await exec("git", [
    "ls-remote",
    "--heads",
    remote,
    `refs/heads/${completedExecution.outcome.branchName}`,
  ]);
  assert.equal(absent.stdout.trim(), "");
  const approved = await requestSensitiveAction({
    actor: { ...executionActor, role: "owner" },
    commandId: randomUUID(),
    executionId: completedExecution.executionId,
    actionType: "repository.push_branch",
    parameters,
    targetResource: `repository:${repositoryId}`,
  });
  await resolveActionApproval({
    actor: { ...executionActor, role: "owner" },
    approvalId: approved.approvalId,
    granted: true,
    reason: "Publish exact tested commit",
  });
  const result = await executeAction(workspaceId, approved.actionRequestId, "integration-action-worker");
  assert.equal(result.commit, completedExecution.outcome.commitId);
  assert.equal(result.branch, completedExecution.outcome.branchName);
  const remoteCommit = (
    await exec("git", ["ls-remote", "--heads", remote, `refs/heads/${completedExecution.outcome.branchName}`])
  ).stdout
    .trim()
    .split(/\s+/)[0];
  assert.equal(remoteCommit, completedExecution.outcome.commitId);
  const approvals = await getDatabasePool().query(
    "SELECT status FROM approval_projections WHERE workspace_id=$1 AND approval_id=ANY($2::uuid[]) ORDER BY created_at",
    [workspaceId, [denied.approvalId, approved.approvalId]],
  );
  assert.deepEqual(
    approvals.rows.map((row) => row.status),
    ["denied", "consumed"],
  );
  await getDatabasePool().query(
    "UPDATE repositories SET pull_request_allowed=true WHERE workspace_id=$1 AND repository_id=$2",
    [workspaceId, repositoryId],
  );
  let creations = 0;
  const provider = {
    pushBranch() {
      throw new Error("unexpected push");
    },
    async createPullRequest(request) {
      creations += 1;
      return {
        provider: "fixture",
        number: 17,
        url: "https://provider.example/pulls/17",
        sourceBranch: request.sourceBranch,
        targetBranch: request.targetBranch,
        state: "open",
      };
    },
  };
  const pullRequest = await requestSensitiveAction({
    actor: { ...executionActor, role: "owner" },
    commandId: randomUUID(),
    executionId: completedExecution.executionId,
    actionType: "repository.create_pull_request",
    parameters: {
      remote: "phase3",
      sourceBranch: completedExecution.outcome.branchName,
      targetBranch: "main",
      title: "Health metadata",
      description: "Validated Phase 3 acceptance",
      providerRepository: "fixture/health",
    },
    targetResource: `repository:${repositoryId}`,
  });
  await resolveActionApproval({
    actor: { ...executionActor, role: "owner" },
    approvalId: pullRequest.approvalId,
    granted: true,
    reason: "Create separately approved pull request",
  });
  const prResult = await executeAction(workspaceId, pullRequest.actionRequestId, "integration-action-worker", provider);
  assert.equal(prResult.url, "https://provider.example/pulls/17");
  assert.equal(
    (await executeAction(workspaceId, pullRequest.actionRequestId, "recovery-worker", provider)).url,
    prResult.url,
  );
  assert.equal(creations, 1);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT merge_allowed,deployment_allowed FROM repositories WHERE workspace_id=$1 AND repository_id=$2",
        [workspaceId, repositoryId],
      )
    ).rows[0].merge_allowed,
    false,
  );
});
test("owner, expiry, commit binding, and current policy are revalidated before effects", async () => {
  const parameters = { remote: "phase3", branch: completedExecution.outcome.branchName, force: false };
  const expiring = await requestSensitiveAction({
    actor: { ...executionActor, role: "owner" },
    commandId: randomUUID(),
    executionId: completedExecution.executionId,
    actionType: "repository.push_branch",
    parameters,
    targetResource: `repository:${repositoryId}`,
  });
  await assert.rejects(
    () =>
      resolveActionApproval({
        actor: { ...executionActor, role: "member" },
        approvalId: expiring.approvalId,
        granted: true,
        reason: "member attempt",
      }),
    /owner permission/,
  );
  await getDatabasePool().query(
    "UPDATE approval_projections SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND approval_id=$2",
    [workspaceId, expiring.approvalId],
  );
  assert.equal(await expireDueApprovals("integration-maintenance"), 1);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT status FROM action_request_projections WHERE workspace_id=$1 AND action_request_id=$2",
        [workspaceId, expiring.actionRequestId],
      )
    ).rows[0].status,
    "expired",
  );
  const changed = await requestSensitiveAction({
    actor: { ...executionActor, role: "owner" },
    commandId: randomUUID(),
    executionId: completedExecution.executionId,
    actionType: "repository.push_branch",
    parameters,
    targetResource: `repository:${repositoryId}`,
  });
  await resolveActionApproval({
    actor: { ...executionActor, role: "owner" },
    approvalId: changed.approvalId,
    granted: true,
    reason: "binding test",
  });
  await getDatabasePool().query(
    "UPDATE execution_projections SET commit_id=$3 WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, completedExecution.executionId, "0".repeat(40)],
  );
  await assert.rejects(
    () => executeAction(workspaceId, changed.actionRequestId, "binding-worker"),
    /commit or branch changed/,
  );
  await getDatabasePool().query(
    "UPDATE execution_projections SET commit_id=$3 WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, completedExecution.executionId, completedExecution.outcome.commitId],
  );
  const policyChanged = await requestSensitiveAction({
    actor: { ...executionActor, role: "owner" },
    commandId: randomUUID(),
    executionId: completedExecution.executionId,
    actionType: "repository.push_branch",
    parameters,
    targetResource: `repository:${repositoryId}`,
  });
  await resolveActionApproval({
    actor: { ...executionActor, role: "owner" },
    approvalId: policyChanged.approvalId,
    granted: true,
    reason: "policy revalidation test",
  });
  const policyId = randomUUID();
  await getDatabasePool().query(
    "INSERT INTO policy_definitions(workspace_id,policy_id,policy_version,name,scope_type,scope_id,priority,rules) VALUES($1,$2,'test-change','Temporary deny','action','repository.push_branch',999,$3)",
    [workspaceId, policyId, JSON.stringify({ deniedActions: ["repository.push_branch"] })],
  );
  await assert.rejects(
    () => executeAction(workspaceId, policyChanged.actionRequestId, "policy-worker"),
    /current policy/i,
  );
  await getDatabasePool().query("DELETE FROM policy_definitions WHERE workspace_id=$1 AND policy_id=$2", [
    workspaceId,
    policyId,
  ]);
});
test("a recovered execution reuses its durable worktree and produces one commit", async () => {
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Recovered health metadata",
      objective: "Recover bounded work after worker loss",
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
      name: "Recover health work",
      instructions: "Add service sample-app to the health response",
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
  const worker = { workspaceId, id: "lost-worker", type: "agent" };
  await handleExecutionTransition({
    actor: worker,
    commandId: randomUUID(),
    executionId: requested.executionId,
    target: "accepted",
  });
  await handleExecutionTransition({
    actor: worker,
    commandId: randomUUID(),
    executionId: requested.executionId,
    target: "preparing",
  });
  const prepared = await createExecutionWorktree({
    repositoryPath: repository,
    repositoryRoot: root,
    worktreeRoot: worktrees,
    missionId: mission.missionId,
    taskId: task.taskId,
    executionId: requested.executionId,
    baseRef: "main",
  });
  await handleExecutionFact({
    actor: worker,
    commandId: randomUUID(),
    executionId: requested.executionId,
    type: "execution.progress_reported",
    payload: {
      stage: "worktree_ready",
      summary: "Worktree persisted before worker loss",
      branchName: prepared.branchName,
      worktreePath: prepared.worktreePath,
    },
  });
  await handleExecutionTransition({
    actor: worker,
    commandId: randomUUID(),
    executionId: requested.executionId,
    target: "running",
    details: { branchName: prepared.branchName, worktreePath: prepared.worktreePath },
  });
  const outcome = await executeCodex({ workspaceId, executionId: requested.executionId, workerId: "recovery-worker" });
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.worktreePath, prepared.worktreePath);
  const commits = Number(
    (await exec("git", ["rev-list", "--count", "main..HEAD"], { cwd: prepared.worktreePath })).stdout.trim(),
  );
  assert.equal(commits, 1);
});
test("execution cancellation requests are durable and idempotent", async () => {
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Cancellation",
      objective: "Cancel bounded execution",
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
      name: "Cancellable work",
      instructions: "Wait for cancellation",
      priority: "normal",
      riskLevel: "low",
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
  });
  const commandId = randomUUID();
  const first = await handleExecutionCancellation({
    actor: executionActor,
    commandId,
    executionId: requested.executionId,
  });
  const duplicate = await handleExecutionCancellation({
    actor: executionActor,
    commandId,
    executionId: requested.executionId,
  });
  assert.equal(first.events.length, 1);
  assert.equal(duplicate.events.length, 0);
  assert.ok(
    (
      await getDatabasePool().query(
        "SELECT cancellation_requested_at FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, requested.executionId],
      )
    ).rows[0].cancellation_requested_at,
  );
});
