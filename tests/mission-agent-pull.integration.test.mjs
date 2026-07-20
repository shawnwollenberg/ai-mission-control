import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { processRemoteMessage } = await import("../application/remote-agent-messages.ts");
const { registerMissionAgentRepository } = await import("../application/registry.ts");
const { launchFirstRepositoryMission } = await import("../application/onboarding-mission.ts");
const { claimNextAssignment, acknowledgeAssignment, renewAssignmentLease, validateExecutionLease, releaseAssignment } =
  await import("../application/pull-assignments.ts");

const workspaceId = randomUUID();
const userId = randomUUID();
const actor = { workspaceId, userId, role: "owner" };
let registration;
let credential;
let repository;

test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Pull Test Workspace')", [
    workspaceId,
    `pull-${workspaceId}`,
  ]);
  registration = await registerRemoteAgent({
    actor,
    name: "Mission Agent Codex",
    endpoint: "https://pull.invalid/messages",
    capabilities: ["repository.read", "code.review", "artifact.create", "test.run"],
    supportedDomains: ["software_delivery"],
    deliveryMode: "pull",
    missionAgentAdapter: "codex",
  });
  credential = {
    workspace_id: workspaceId,
    agent_id: registration.agentId,
    credential_id: registration.credential.credentialId,
    credential_record_status: "active",
  };
  const now = new Date().toISOString();
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: registration.agentId,
      workspaceId,
      sentAt: now,
      messageType: "AgentHeartbeat",
      correlationId: registration.agentId,
      payload: { assignmentPull: true, missionAgentVersion: "0.3.1", adapter: "codex" },
    },
    credential,
  );
  repository = await registerMissionAgentRepository({
    workspaceId,
    agentId: registration.agentId,
    name: "safe-repository",
    fingerprint: "a".repeat(64),
    defaultBranch: "main",
    commit: "b".repeat(40),
  });
});

test.after(async () => {
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});

test("pull-ready Mission Agent claims, renews, validates, and releases one durable assignment", async () => {
  const launched = await launchFirstRepositoryMission({
    actor,
    commandId: randomUUID(),
    agentId: registration.agentId,
    repositoryId: repository.repository_id,
    objective: "Focus on authentication boundaries and recommend the safest next change",
  });
  const claimed = await claimNextAssignment({ credential, leaseOwner: "test-runtime" });
  assert.ok(claimed);
  assert.equal(claimed.assignment.execution_id, launched.executionId);
  assert.equal(claimed.assignment.payload.constraints[0], "read_only_repository_analysis");
  assert.match(claimed.assignment.payload.instructions, /Focus on authentication boundaries/);
  assert.ok(!JSON.stringify(claimed.assignment.payload).includes("mission-agent://"));
  assert.ok(claimed.leaseToken.startsWith("mc_lease_"));

  const duplicate = await claimNextAssignment({ credential, leaseOwner: "test-runtime" });
  assert.equal(duplicate.assignment.assignment_id, claimed.assignment.assignment_id);
  assert.equal(duplicate.resumed, true);

  const lease = {
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: "test-runtime",
    leaseToken: claimed.leaseToken,
  };
  await acknowledgeAssignment(lease);
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: registration.agentId,
      workspaceId,
      sentAt: new Date().toISOString(),
      messageType: "ExecutionAccepted",
      correlationId: launched.executionId,
      missionId: launched.missionId,
      taskId: launched.taskId,
      executionId: launched.executionId,
      attempt: 1,
      payload: { stage: "assignment_received", summary: "Assignment accepted" },
    },
    credential,
  );
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: registration.agentId,
      workspaceId,
      sentAt: new Date().toISOString(),
      messageType: "ExecutionHeartbeat",
      correlationId: launched.executionId,
      missionId: launched.missionId,
      taskId: launched.taskId,
      executionId: launched.executionId,
      attempt: 1,
      payload: {
        workerId: "test-runtime",
        stage: "inspecting_repository",
        summary: "Codex is analyzing the repository",
        progressPercent: 50,
      },
    },
    credential,
  );
  const heartbeat = (
    await getDatabasePool().query(
      "SELECT worker_id,stage,progress_percent,progress_message FROM execution_heartbeats WHERE workspace_id=$1 AND execution_id=$2",
      [workspaceId, launched.executionId],
    )
  ).rows[0];
  assert.deepEqual(heartbeat, {
    worker_id: "test-runtime",
    stage: "inspecting_repository",
    progress_percent: 50,
    progress_message: "Codex is analyzing the repository",
  });
  const renewed = await renewAssignmentLease(lease);
  assert.ok(new Date(renewed.lease_expires_at).getTime() > Date.now());
  assert.equal(
    (await validateExecutionLease({ ...lease, executionId: launched.executionId })).execution_id,
    launched.executionId,
  );
  await assert.rejects(
    validateExecutionLease({ ...lease, leaseToken: "mc_lease_invalid", executionId: launched.executionId }),
    /invalid or expired/,
  );
  await releaseAssignment(lease);
  const row = (
    await getDatabasePool().query(
      "SELECT status,lease_token_hash FROM pull_assignments WHERE workspace_id=$1 AND assignment_id=$2",
      [workspaceId, claimed.assignment.assignment_id],
    )
  ).rows[0];
  assert.deepEqual(row, { status: "available", lease_token_hash: null });

  const recovered = await claimNextAssignment({ credential, leaseOwner: "replacement-runtime" });
  assert.ok(recovered);
  assert.equal(recovered.assignment.assignment_id, claimed.assignment.assignment_id);
  assert.equal(recovered.resumed, true);
  assert.ok(recovered.leaseToken.startsWith("mc_lease_"));
  await releaseAssignment({
    credential,
    assignmentId: recovered.assignment.assignment_id,
    leaseOwner: "replacement-runtime",
    leaseToken: recovered.leaseToken,
  });
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: registration.agentId,
      workspaceId,
      sentAt: new Date().toISOString(),
      messageType: "ExecutionFailed",
      correlationId: launched.executionId,
      missionId: launched.missionId,
      taskId: launched.taskId,
      executionId: launched.executionId,
      attempt: 1,
      payload: {
        classification: "test_cleanup",
        summary: "Finish the analysis fixture before change-mission testing.",
      },
    },
    credential,
  );
});

test("change mission assignment carries bounded write approval, validation, evidence, and permanent prohibitions", async () => {
  const launched = await launchFirstRepositoryMission({
    actor,
    commandId: randomUUID(),
    agentId: registration.agentId,
    repositoryId: repository.repository_id,
    missionType: "change",
    objective: "Add a small health-check helper with focused tests",
    acceptanceCriteria: "Helper returns the expected status\nTests cover success and failure",
    validationInstructions: "npm test\nnpm run lint",
  });
  const claimed = await claimNextAssignment({ credential, leaseOwner: "change-runtime" });
  assert.ok(claimed);
  assert.equal(claimed.assignment.execution_id, launched.executionId);
  assert.equal(claimed.assignment.payload.missionType, "repository_change");
  assert.ok(claimed.assignment.payload.constraints.includes("write_requires_approval"));
  assert.ok(claimed.assignment.payload.constraints.includes("isolated_worktree"));
  assert.ok(claimed.assignment.payload.constraints.includes("local_commit_only"));
  assert.deepEqual(claimed.assignment.payload.validationCommands, [
    ["npm", "test"],
    ["npm", "run", "lint"],
  ]);
  assert.ok(claimed.assignment.payload.artifactRequirements.includes("git_patch"));
  assert.ok(claimed.assignment.payload.prohibitedActions.includes("git.push"));
  assert.ok(claimed.assignment.payload.prohibitedActions.includes("pull_request.create"));
  assert.ok(claimed.assignment.payload.prohibitedActions.includes("deployment.execute"));
  assert.ok(!claimed.assignment.payload.prohibitedActions.includes("file.modify"));
  await releaseAssignment({
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: "change-runtime",
    leaseToken: claimed.leaseToken,
  });
});

test("disabled agents and emergency pause receive no work without cross-workspace leakage", async () => {
  await getDatabasePool().query("UPDATE agents SET status='disabled' WHERE workspace_id=$1 AND agent_id=$2", [
    workspaceId,
    registration.agentId,
  ]);
  assert.equal(await claimNextAssignment({ credential, leaseOwner: "disabled-runtime" }), undefined);
  await getDatabasePool().query("UPDATE agents SET status='active' WHERE workspace_id=$1 AND agent_id=$2", [
    workspaceId,
    registration.agentId,
  ]);
  await getDatabasePool().query(
    `INSERT INTO workspace_emergency_controls(workspace_id,pause_remote_assignments,updated_at)
     VALUES($1,true,now()) ON CONFLICT(workspace_id) DO UPDATE SET pause_remote_assignments=true,updated_at=now()`,
    [workspaceId],
  );
  assert.equal(await claimNextAssignment({ credential, leaseOwner: "paused-runtime" }), undefined);
});
