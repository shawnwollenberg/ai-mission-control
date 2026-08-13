import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { processRemoteMessage } = await import("../application/remote-agent-messages.ts");
const { registerMissionAgentRepository } = await import("../application/registry.ts");
const { launchFirstRepositoryMission } = await import("../application/onboarding-mission.ts");
const { claimNextAssignment, acknowledgeAssignment, renewAssignmentLease, validateExecutionLease, releaseAssignment } =
  await import("../application/pull-assignments.ts");
const { handleExecutionTransition, handleMissionAgentGenerationTermination } =
  await import("../application/execution-commands.ts");

const workspaceId = randomUUID();
const userId = randomUUID();
const actor = { workspaceId, userId, role: "owner" };
let registration;
let credential;
let repository;

test.before(async () => {
  process.env.ARTIFACT_STORAGE_ROOT ??= await mkdtemp(join(tmpdir(), "mission-agent-pull-artifacts-"));
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

test("multiple valid inline artifacts use the repository execution budget rather than a cumulative transport limit", async () => {
  const launched = await launchFirstRepositoryMission({
    actor,
    commandId: randomUUID(),
    agentId: registration.agentId,
    repositoryId: repository.repository_id,
    objective: "Produce enough bounded evidence to cross one transport frame cumulatively",
  });
  const envelope = (messageType, payload) => ({
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId: registration.agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: launched.executionId,
    missionId: launched.missionId,
    taskId: launched.taskId,
    executionId: launched.executionId,
    attempt: 1,
    payload,
  });
  await processRemoteMessage(
    envelope("ExecutionAccepted", { stage: "assignment_received", summary: "Assignment accepted" }),
    credential,
  );
  for (const [artifactType, body] of [
    ["codex_execution_log", Buffer.alloc(110 * 1024, "a")],
    ["git_patch", Buffer.alloc(40 * 1024, "b")],
  ]) {
    await processRemoteMessage(
      envelope("ExecutionArtifactSubmitted", {
        name: artifactType,
        description: "Bounded regression evidence",
        artifactType,
        mediaType: "text/plain",
        byteSize: body.length,
        checksum: createHash("sha256").update(body).digest("hex"),
        contentBase64: body.toString("base64"),
      }),
      credential,
    );
  }
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM artifacts WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, launched.executionId],
      )
    ).rows[0].count,
    2,
  );
  await processRemoteMessage(
    envelope("ExecutionFailed", { classification: "test_cleanup", summary: "Artifact regression complete" }),
    credential,
  );
});

test("unsupported recommendation validation fails closed with explicit terminal evidence", async () => {
  const launched = await launchFirstRepositoryMission({
    actor,
    commandId: randomUUID(),
    agentId: registration.agentId,
    repositoryId: repository.repository_id,
    objective: "Verify the FP1 production repository-registration and terminal mission lifecycle",
  });
  const envelope = (messageType, payload) => ({
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId: registration.agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: launched.executionId,
    missionId: launched.missionId,
    taskId: launched.taskId,
    executionId: launched.executionId,
    attempt: 1,
    payload,
  });
  await processRemoteMessage(
    envelope("ExecutionAccepted", { stage: "assignment_received", summary: "Assignment accepted" }),
    credential,
  );
  const productionRejected =
    "node -e \"const fs=require('fs');const c=fs.readFileSync('.git/config','utf8');if(/github\\\\.com\\\\/example\\\\//.test(c)||!c.includes('[branch \\\\\"main\\\\\"]'))process.exit(1)\"";
  const recommendation = Buffer.from(
    JSON.stringify([
      {
        title: "Register the production repository remote",
        description: "Replace the placeholder remote.",
        reasoning: "The disposable fixture used a placeholder namespace.",
        evidence: [{ path: ".git/config", description: "Repository remote configuration" }],
        estimatedImpact: "high",
        estimatedRisk: "medium",
        estimatedEffort: "small",
        suggestedValidation: [productionRejected],
        acceptanceCriteria: ["The origin identifies the authoritative repository."],
      },
    ]),
  );
  await assert.rejects(
    processRemoteMessage(
      envelope("ExecutionArtifactSubmitted", {
        name: "Repository recommendations",
        description: "Production-representative rejected recommendation",
        artifactType: "repository_recommendations",
        mediaType: "application/json",
        byteSize: recommendation.length,
        checksum: createHash("sha256").update(recommendation).digest("hex"),
        contentBase64: recommendation.toString("base64"),
        repositoryCommit: "b".repeat(40),
      }),
      credential,
    ),
    /inline code and shell operators are prohibited/,
  );
  const failure =
    "Recommendation validation command is not allowed. Use one direct supported executable with simple repository-local arguments; inline code and shell operators are prohibited.";
  await processRemoteMessage(
    envelope("ExecutionFailed", { classification: "local_adapter_failure", summary: failure }),
    credential,
  );
  const terminal = (
    await getDatabasePool().query(
      `SELECT e.status execution_status,e.progress_summary,t.status task_status,t.progress_summary task_summary,
              m.status mission_status
       FROM execution_projections e
       JOIN task_projections t ON t.workspace_id=e.workspace_id AND t.task_id=e.task_id
       JOIN mission_projections m ON m.workspace_id=e.workspace_id AND m.mission_id=e.mission_id
       WHERE e.workspace_id=$1 AND e.execution_id=$2`,
      [workspaceId, launched.executionId],
    )
  ).rows[0];
  assert.deepEqual(terminal, {
    execution_status: "failed",
    progress_summary: failure,
    task_status: "failed",
    task_summary: failure,
    mission_status: "failed",
  });
});

test.after(async () => {
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});

test("unsupported compatibility agents are rejected before execution or mission state is created", async () => {
  await getDatabasePool().query(
    "UPDATE agents SET mission_agent_version='0.1.1' WHERE workspace_id=$1 AND agent_id=$2",
    [workspaceId, registration.agentId],
  );
  const before = (
    await getDatabasePool().query(
      `SELECT
         (SELECT count(*)::int FROM mission_projections WHERE workspace_id=$1) missions,
         (SELECT count(*)::int FROM execution_projections WHERE workspace_id=$1) executions`,
      [workspaceId],
    )
  ).rows[0];
  await assert.rejects(
    launchFirstRepositoryMission({
      actor,
      commandId: randomUUID(),
      agentId: registration.agentId,
      repositoryId: repository.repository_id,
      objective: "This unsupported agent must fail before creating durable work",
    }),
    /Mission Agent 0\.3\.1 or newer/,
  );
  const after = (
    await getDatabasePool().query(
      `SELECT
         (SELECT count(*)::int FROM mission_projections WHERE workspace_id=$1) missions,
         (SELECT count(*)::int FROM execution_projections WHERE workspace_id=$1) executions`,
      [workspaceId],
    )
  ).rows[0];
  assert.deepEqual(after, before);
  await getDatabasePool().query(
    "UPDATE agents SET mission_agent_version='0.3.1' WHERE workspace_id=$1 AND agent_id=$2",
    [workspaceId, registration.agentId],
  );
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
  assert.equal(duplicate, undefined, "active bearer authority is not reconstructed from durable state");

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

test("launcher lifecycle reconciliation repairs task and mission after a committed execution failure", async () => {
  const launched = await launchFirstRepositoryMission({
    actor,
    commandId: randomUUID(),
    agentId: registration.agentId,
    repositoryId: repository.repository_id,
    objective: "Exercise launcher-owned lifecycle consequence repair",
  });
  const leaseOwner = `acceptance:${randomUUID()}:0123456789abcdef`;
  const claimed = await claimNextAssignment({ credential, leaseOwner });
  assert.ok(claimed);
  const lease = {
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner,
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
  const authority = (
    await getDatabasePool().query(
      `SELECT e.aggregate_version,p.attempt,p.lease_receipt_id,p.lease_token_fingerprint,p.fencing_token
         FROM execution_projections e JOIN pull_assignments p
           ON p.workspace_id=e.workspace_id AND p.execution_id=e.execution_id
        WHERE e.workspace_id=$1 AND e.execution_id=$2`,
      [workspaceId, launched.executionId],
    )
  ).rows[0];
  await handleExecutionTransition({
    actor: { workspaceId, id: "lifecycle-fixture", type: "system" },
    commandId: randomUUID(),
    executionId: launched.executionId,
    target: "failed",
    expectedVersion: authority.aggregate_version,
    details: { classification: "mission_agent_generation_terminated" },
  });
  const processIdentity = "b".repeat(64);
  const repaired = await handleMissionAgentGenerationTermination({
    actor: { workspaceId, id: "lifecycle-fixture", type: "system" },
    commandId: randomUUID(),
    executionId: launched.executionId,
    assignmentId: claimed.assignment.assignment_id,
    assignmentAttempt: authority.attempt,
    leaseReceiptId: authority.lease_receipt_id,
    leaseTokenFingerprint: authority.lease_token_fingerprint,
    leaseOwner,
    fencingToken: Number(authority.fencing_token),
    invocationId: randomUUID(),
    registeredProcessIdentitySha256: processIdentity,
    observedProcessIdentitySha256: processIdentity,
    expectedVersion: authority.aggregate_version,
    exitCode: 1,
    terminationSignal: null,
    diagnosticIdentitySha256: "c".repeat(64),
  });
  assert.equal(repaired.disposition, "already_terminal");
  const terminal = (
    await getDatabasePool().query(
      `SELECT e.status execution_status,t.status task_status,m.status mission_status,
              p.status assignment_status,p.lease_token_hash,p.lease_expires_at
         FROM execution_projections e
         JOIN task_projections t ON t.workspace_id=e.workspace_id AND t.task_id=e.task_id
         JOIN mission_projections m ON m.workspace_id=e.workspace_id AND m.mission_id=e.mission_id
         JOIN pull_assignments p ON p.workspace_id=e.workspace_id AND p.execution_id=e.execution_id
        WHERE e.workspace_id=$1 AND e.execution_id=$2`,
      [workspaceId, launched.executionId],
    )
  ).rows[0];
  assert.deepEqual(terminal, {
    execution_status: "failed",
    task_status: "failed",
    mission_status: "failed",
    assignment_status: "completed",
    lease_token_hash: null,
    lease_expires_at: null,
  });
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
  const lease = {
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: "change-runtime",
    leaseToken: claimed.leaseToken,
    fencingToken: Number(claimed.assignment.fencing_token),
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
      payload: { stage: "assignment_received", summary: "Change assignment accepted" },
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
      messageType: "ExecutionProgressReported",
      correlationId: launched.executionId,
      missionId: launched.missionId,
      taskId: launched.taskId,
      executionId: launched.executionId,
      attempt: 1,
      payload: { stage: "waiting_for_write_approval", summary: "Implementation plan ready", progressPercent: 20 },
    },
    credential,
  );
  const approval = await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: registration.agentId,
      workspaceId,
      sentAt: new Date().toISOString(),
      messageType: "ExecutionApprovalRequested",
      correlationId: launched.executionId,
      missionId: launched.missionId,
      taskId: launched.taskId,
      executionId: launched.executionId,
      attempt: 1,
      payload: {
        actionType: "repository.modify",
        parameters: { repositoryId: repository.repository_id },
        targetResource: `repository:${repository.repository_id}`,
        riskExplanation: "Test the bounded write boundary.",
        evidence: [{ artifactId: randomUUID(), kind: "implementation_plan" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    credential,
  );
  assert.equal(approval.status, "approval_required");
  await assert.rejects(
    processRemoteMessage(
      {
        protocolVersion: "1.0",
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
        agentId: registration.agentId,
        workspaceId,
        sentAt: new Date().toISOString(),
        messageType: "ExecutionSucceeded",
        correlationId: launched.executionId,
        missionId: launched.missionId,
        taskId: launched.taskId,
        executionId: launched.executionId,
        attempt: 1,
        payload: { summary: "Attempted to bypass the pending write approval" },
      },
      credential,
    ),
    /cannot complete without an unexpired repository\.modify approval/,
  );
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
      payload: { classification: "test_cleanup", summary: "Test terminal approval cleanup." },
    },
    credential,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT status FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
        [workspaceId, approval.approvalId],
      )
    ).rows[0].status,
    "expired",
  );
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
