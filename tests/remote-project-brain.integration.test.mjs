import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { canonicalJson, canonicalHash } = await import("../lib/canonical-json.ts");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");
const { applyMissionAgentCapabilityProjection } = await import("../application/mission-agent-capability-projector.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { registerMissionAgentRepository } = await import("../application/registry.ts");
const { processRemoteMessage } = await import("../application/remote-agent-messages.ts");
const { requestProjectBrainOperation, requestProjectBrainWriteApproval } =
  await import("../application/project-brain-commands.ts");
const { decideApproval } = await import("../application/approval-commands.ts");
const { handleCreateMission } = await import("../application/mission-commands.ts");
const { executeProjectBrainOperation } = await import("../integrations/project-brain/worker.ts");
const { claimRemoteProjectBrainAssignment, recoverRemoteProjectBrainAssignments } =
  await import("../application/remote-project-brain-assignments.ts");
const { reauthorizeRemoteProjectBrainAssignment } = await import("../application/remote-project-brain-assignments.ts");

const workspaceId = randomUUID();
const ownerId = randomUUID();
const actor = { workspaceId, userId: ownerId, role: "owner" };
const pbActor = { workspaceId, id: ownerId, type: "human" };
let registration;
let repository;
let credential;

const capabilities = {
  installed: true,
  coreVersion: "0.4.0",
  contractVersions: ["1.0"],
  schemaVersions: ["2.5.0"],
  operations: [
    "detect_repository",
    "initialize_repository",
    "validate_repository",
    "get_summary",
    "prepare_context",
    "read_context",
    "record_closure",
    "propose_learning",
    "evaluate_learning",
    "get_curation",
    "list_knowledge",
    "get_health",
    "diagnostics",
  ],
  readOperations: [
    "detect_repository",
    "validate_repository",
    "get_summary",
    "prepare_context",
    "read_context",
    "get_curation",
    "list_knowledge",
    "get_health",
    "diagnostics",
  ],
  writeOperations: [
    "initialize_repository",
    "prepare_context",
    "record_closure",
    "propose_learning",
    "evaluate_learning",
  ],
  maxRequestBytes: 1_000_000,
  maxResultBytes: 5_000_000,
  artifactTransferModes: ["inline_base64"],
  runtimeReady: true,
  diagnosticsStatus: "ready",
};

const agentMessage = (messageType, payload, binding = {}) => ({
  protocolVersion: "1.0",
  messageId: randomUUID(),
  idempotencyKey: randomUUID(),
  agentId: registration.agentId,
  workspaceId,
  sentAt: new Date().toISOString(),
  messageType,
  correlationId: binding.missionId ?? registration.agentId,
  ...binding,
  payload,
});

test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Remote PB Integration')", [
    workspaceId,
    `remote-pb-${workspaceId}`,
  ]);
  registration = await registerRemoteAgent({
    actor,
    name: "Remote Project Brain Agent",
    endpoint: "https://pull.invalid/messages",
    capabilities: ["repository.read", "repository.write", "artifact.create"],
    supportedDomains: ["software_delivery"],
    deliveryMode: "pull",
    missionAgentAdapter: "codex",
  });
  credential = {
    workspace_id: workspaceId,
    agent_id: registration.agentId,
    credential_id: registration.credential.credentialId,
    credential_record_status: "active",
    delivery_mode: "pull",
  };
  repository = await registerMissionAgentRepository({
    workspaceId,
    agentId: registration.agentId,
    name: "remote-only-project-brain",
    fingerprint: "a".repeat(64),
    defaultBranch: "main",
    commit: "b".repeat(40),
  });
  await getDatabasePool().query(
    `UPDATE repositories SET project_brain_enabled=true,read_allowed=true,write_allowed=true
     WHERE workspace_id=$1 AND repository_id=$2`,
    [workspaceId, repository.repository_id],
  );
  await processRemoteMessage(
    agentMessage("AgentHeartbeat", {
      assignmentPull: true,
      missionAgentVersion: "0.6.8",
      adapter: "codex",
      artifact: { sha256: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d", manifestVersion: "1" },
      projectBrain: capabilities,
    }),
    credential,
  );
});

test.after(async () => {
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});

test("compatible remote operation is signed, leased, idempotent, completed, and replayable", async () => {
  const identity = (
    await getDatabasePool().query(
      `SELECT mission_agent_artifact_checksum,mission_agent_expected_checksum,
        mission_agent_checksum_status,mission_agent_project_brain_compatible,
        mission_agent_capability_expires_at>now() fresh
       FROM agents WHERE workspace_id=$1 AND agent_id=$2`,
      [workspaceId, registration.agentId],
    )
  ).rows[0];
  assert.deepEqual(identity, {
    mission_agent_artifact_checksum: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
    mission_agent_expected_checksum: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
    mission_agent_checksum_status: "verified",
    mission_agent_project_brain_compatible: true,
    fresh: true,
  });
  const projected = (
    await getDatabasePool().query(
      `SELECT checksum_status,project_brain_compatible,freshness_expires_at>now() fresh
       FROM mission_agent_capability_projections WHERE workspace_id=$1 AND agent_id=$2`,
      [workspaceId, registration.agentId],
    )
  ).rows[0];
  assert.deepEqual(projected, { checksum_status: "verified", project_brain_compatible: true, fresh: true });
  const agentEvents = await loadAggregateEvents({
    workspaceId,
    aggregateType: "agent",
    aggregateId: registration.agentId,
  });
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM mission_agent_capability_projections WHERE workspace_id=$1 AND agent_id=$2", [
      workspaceId,
      registration.agentId,
    ]);
    await applyMissionAgentCapabilityProjection(client, agentEvents);
    const replayed = (
      await client.query(
        `SELECT checksum_status,project_brain_compatible,freshness_expires_at>now() fresh
         FROM mission_agent_capability_projections WHERE workspace_id=$1 AND agent_id=$2`,
        [workspaceId, registration.agentId],
      )
    ).rows[0];
    assert.deepEqual(replayed, projected);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: {
      repositoryId: repository.repository_id,
      operation: "detect_repository",
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(requested.authorized, true);
  assert.deepEqual(
    await executeProjectBrainOperation({
      workspaceId,
      operationId: requested.operationId,
      workerId: "remote-pb-integration",
    }),
    { terminal: true, status: "dispatched" },
  );
  const claimed = await claimRemoteProjectBrainAssignment({ credential, leaseOwner: "integration-agent" });
  assert.ok(claimed);
  const request = claimed.assignment.request;
  const transported = {
    assignmentId: claimed.assignment.assignment_id,
    operationId: claimed.assignment.operation_id,
    repositoryId: claimed.assignment.repository_id,
    missionId: claimed.assignment.mission_id,
    executionId: claimed.assignment.execution_id,
    agentId: claimed.assignment.agent_id,
    leaseOwner: claimed.assignment.lease_owner,
    leaseToken: claimed.leaseToken,
    leaseExpiresAt: claimed.assignment.lease_expires_at,
    requestChecksum: claimed.assignment.request_checksum,
    ...request,
  };
  const transportedUnsigned = { ...transported };
  for (const key of [
    "assignmentId",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt",
    "requestChecksum",
    "missionControlSignature",
  ])
    delete transportedUnsigned[key];
  assert.equal(canonicalHash(transportedUnsigned), request.requestChecksum);
  const liveAuthorization = await reauthorizeRemoteProjectBrainAssignment({
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: "integration-agent",
    leaseToken: claimed.leaseToken,
    requestChecksum: claimed.assignment.request_checksum,
  });
  assert.equal(liveAuthorization.authorized, true);
  assert.equal(liveAuthorization.requestFingerprint, request.approvalFingerprint);
  const unsigned = { ...request };
  delete unsigned.requestChecksum;
  delete unsigned.missionControlSignature;
  assert.equal(createHash("sha256").update(canonicalJson(unsigned)).digest("hex"), request.requestChecksum);
  assert.equal(
    createHmac("sha256", createHash("sha256").update(registration.credential.secret).digest("hex"))
      .update(request.requestChecksum)
      .digest("hex"),
    request.missionControlSignature,
  );
  const binding = {};
  const common = {
    assignmentId: claimed.assignment.assignment_id,
    operationId: requested.operationId,
  };
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationAccepted", common, binding), credential);
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationStarted", common, binding), credential);
  assert.deepEqual(
    await processRemoteMessage(agentMessage("RemoteProjectBrainOperationAccepted", common, binding), credential),
    { status: "running", duplicate: true },
  );
  const envelope = {
    contract_version: "1.0",
    operation: "detect_repository",
    status: "succeeded",
    repository: {
      id: repository.repository_id,
      checkout_path: request.repositoryLocator,
      head_sha: "b".repeat(40),
      ending_head_sha: "b".repeat(40),
    },
    artifacts: [],
    warnings: [],
    blockers: [],
    required_actions: [],
    human_approval_required: false,
    repository_files_changed: false,
    exit_classification: "success",
    data: { initialized: false, state: "not_initialized" },
  };
  const responseWithoutChecksum = {
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestChecksum: request.requestChecksum,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    startingSha: "b".repeat(40),
    endingSha: "b".repeat(40),
    projectBrainVersion: request.requiredProjectBrainVersion,
    schemaVersions: request.requiredSchemaVersions,
    durationMs: 10,
    process: { exitCode: 0, stdoutSha256: "c".repeat(64), stderrSha256: "d".repeat(64) },
    envelope,
  };
  const response = { ...responseWithoutChecksum, responseChecksum: canonicalHash(responseWithoutChecksum) };
  const success = agentMessage("RemoteProjectBrainOperationSucceeded", { ...common, response }, binding);
  assert.deepEqual(await processRemoteMessage(success, credential), { status: "succeeded", artifactCount: 0 });
  assert.deepEqual(await processRemoteMessage(success, credential), { status: "succeeded", duplicate: true });
  const rows = await getDatabasePool().query(
    `SELECT event_type FROM events WHERE workspace_id=$1 AND aggregate_id=$2 ORDER BY aggregate_version`,
    [workspaceId, requested.operationId],
  );
  assert.ok(rows.rows.some((row) => row.event_type === "project_brain.remote_operation_dispatched"));
  assert.ok(rows.rows.some((row) => row.event_type === "project_brain.remote_operation_accepted"));
  assert.ok(rows.rows.some((row) => row.event_type === "project_brain.remote_operation_started"));
  assert.ok(rows.rows.some((row) => row.event_type === "project_brain.operation_succeeded"));
  assert.equal(rows.rows.filter((row) => row.event_type === "project_brain.remote_operation_accepted").length, 1);
});

test("expired unstarted work is durably failed with idempotent recovery evidence", async () => {
  await getDatabasePool().query(
    `UPDATE agents SET status='active',last_heartbeat_at=now(),pull_ready_at=now(),
       remote_project_brain_capabilities_at=now() WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: {
      repositoryId: repository.repository_id,
      operation: "detect_repository",
      idempotencyKey: randomUUID(),
    },
  });
  await executeProjectBrainOperation({
    workspaceId,
    operationId: requested.operationId,
    workerId: "remote-pb-recovery",
  });
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments
       SET request=jsonb_set(request,'{expiresAt}',to_jsonb((now()-interval '1 minute')::text))
       WHERE workspace_id=$1 AND operation_id=$2`,
    [workspaceId, requested.operationId],
  );
  assert.deepEqual(await recoverRemoteProjectBrainAssignments(), { failed: 1 });
  assert.deepEqual(await recoverRemoteProjectBrainAssignments(), { failed: 0 });
  const recovered = (
    await getDatabasePool().query(
      `SELECT status,recovery_event_emitted FROM remote_project_brain_assignments
       WHERE workspace_id=$1 AND operation_id=$2`,
      [workspaceId, requested.operationId],
    )
  ).rows[0];
  assert.deepEqual(recovered, { status: "failed", recovery_event_emitted: true });
  const failures = await getDatabasePool().query(
    `SELECT count(*)::int AS count FROM events
       WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='project_brain.remote_operation_failed'`,
    [workspaceId, requested.operationId],
  );
  assert.equal(failures.rows[0].count, 1);
});

test("an unstarted assignment on a disconnected agent is durably failed once", async () => {
  await getDatabasePool().query(
    `UPDATE agents SET status='active',last_heartbeat_at=now(),pull_ready_at=now(),
       remote_project_brain_capabilities_at=now() WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: {
      repositoryId: repository.repository_id,
      operation: "detect_repository",
      idempotencyKey: randomUUID(),
    },
  });
  await executeProjectBrainOperation({
    workspaceId,
    operationId: requested.operationId,
    workerId: "remote-pb-disconnect",
  });
  await getDatabasePool().query(
    `UPDATE agents SET last_heartbeat_at=now()-interval '6 minutes'
       WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  assert.deepEqual(await recoverRemoteProjectBrainAssignments(), { failed: 1 });
  assert.deepEqual(await recoverRemoteProjectBrainAssignments(), { failed: 0 });
  const assignment = (
    await getDatabasePool().query(
      `SELECT status,response->>'error' failure FROM remote_project_brain_assignments
       WHERE workspace_id=$1 AND operation_id=$2`,
      [workspaceId, requested.operationId],
    )
  ).rows[0];
  assert.deepEqual(assignment, { status: "failed", failure: "remote_agent_disconnected" });
  const failures = (
    await getDatabasePool().query(
      `SELECT count(*)::int count FROM events WHERE workspace_id=$1 AND aggregate_id=$2
       AND event_type='project_brain.remote_operation_failed'`,
      [workspaceId, requested.operationId],
    )
  ).rows[0].count;
  assert.equal(failures, 1);
});

test("stale capabilities produce a durable final blocked projection and no assignment", async () => {
  await getDatabasePool().query(
    `UPDATE agents SET remote_project_brain_capabilities_at=now()-interval '6 minutes'
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: {
      repositoryId: repository.repository_id,
      operation: "get_health",
      idempotencyKey: randomUUID(),
    },
  });
  await assert.rejects(
    executeProjectBrainOperation({
      workspaceId,
      operationId: requested.operationId,
      workerId: "remote-pb-integration",
      finalAttempt: true,
    }),
    /dispatch is blocked/,
  );
  const projection = (
    await getDatabasePool().query(
      `SELECT status,failure_cause FROM project_brain_operation_projections
       WHERE workspace_id=$1 AND operation_id=$2`,
      [workspaceId, requested.operationId],
    )
  ).rows[0];
  assert.equal(projection.status, "denied");
  assert.match(projection.failure_cause, /dispatch is blocked/);
  assert.equal(
    (
      await getDatabasePool().query(
        `SELECT count(*)::int count FROM remote_project_brain_assignments
         WHERE workspace_id=$1 AND operation_id=$2`,
        [workspaceId, requested.operationId],
      )
    ).rows[0].count,
    0,
  );
});

test("an exact started write remains recoverable after lease, request, and consumed approval expiry", async () => {
  await getDatabasePool().query(
    `UPDATE agents SET status='active',last_heartbeat_at=now(),pull_ready_at=now(),
       remote_project_brain_capabilities_at=now() WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  await getDatabasePool().query(
    `UPDATE repositories SET commit_allowed=true WHERE workspace_id=$1 AND repository_id=$2`,
    [workspaceId, repository.repository_id],
  );
  await getDatabasePool().query(
    `UPDATE agent_resource_permissions SET permissions='["read","write"]'::jsonb
       WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3`,
    [workspaceId, registration.agentId, repository.repository_id],
  );
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Remote recovery fixture",
      objective: "Verify exact started write recovery",
      domain: "software_delivery",
      priority: "normal",
      riskLevel: "moderate",
      successCriteria: ["Started operation remains recoverable"],
      constraints: ["No external effects"],
    },
  });
  const base = {
    repositoryId: repository.repository_id,
    missionId: mission.missionId,
    operation: "initialize_repository",
    arguments: { repository_id: repository.repository_id },
    startingSha: "b".repeat(40),
  };
  const approval = await requestProjectBrainWriteApproval({ actor: pbActor, request: base });
  await decideApproval({
    workspaceId,
    approvalId: approval.approvalId,
    granted: true,
    actorId: ownerId,
    reason: "Remote recovery integration fixture",
  });
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: { ...base, approvalId: approval.approvalId, idempotencyKey: randomUUID() },
  });
  await executeProjectBrainOperation({
    workspaceId,
    operationId: requested.operationId,
    workerId: "remote-pb-expired-recovery",
  });
  const first = await claimRemoteProjectBrainAssignment({ credential, leaseOwner: "first-runner", leaseSeconds: 30 });
  const common = { assignmentId: first.assignment.assignment_id, operationId: requested.operationId };
  const binding = { missionId: mission.missionId };
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationAccepted", common, binding), credential);
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationStarted", common, binding), credential);
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments
       SET lease_expires_at=now()-interval '1 second',
           request=jsonb_set(request,'{expiresAt}',to_jsonb((now()-interval '11 minutes')::text))
       WHERE workspace_id=$1 AND operation_id=$2`,
    [workspaceId, requested.operationId],
  );
  assert.deepEqual(await recoverRemoteProjectBrainAssignments(), { failed: 0 });
  const recovered = await claimRemoteProjectBrainAssignment({
    credential,
    leaseOwner: "recovered-runner",
    leaseSeconds: 30,
  });
  await getDatabasePool().query(
    `UPDATE approval_projections SET expires_at=now()-interval '1 minute'
       WHERE workspace_id=$1 AND approval_id=$2`,
    [workspaceId, approval.approvalId],
  );
  assert.equal(recovered.assignment.started_event_emitted, true);
  const live = await reauthorizeRemoteProjectBrainAssignment({
    credential,
    assignmentId: recovered.assignment.assignment_id,
    leaseOwner: "recovered-runner",
    leaseToken: recovered.leaseToken,
    requestChecksum: recovered.assignment.request_checksum,
  });
  assert.equal(live.authorized, true);
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments SET status='failed',completed_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2`,
    [workspaceId, recovered.assignment.assignment_id],
  );
});

test("a canonically started terminal result is accepted as historical fact after agent authority is revoked", async () => {
  await getDatabasePool().query(
    `UPDATE agents SET status='active',last_heartbeat_at=now(),pull_ready_at=now(),
       remote_project_brain_capabilities_at=now() WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: {
      repositoryId: repository.repository_id,
      operation: "detect_repository",
      idempotencyKey: randomUUID(),
    },
  });
  await executeProjectBrainOperation({
    workspaceId,
    operationId: requested.operationId,
    workerId: "remote-pb-terminal-reconciliation",
  });
  const claimed = await claimRemoteProjectBrainAssignment({
    credential,
    leaseOwner: "terminal-reconciliation",
  });
  const common = { assignmentId: claimed.assignment.assignment_id, operationId: requested.operationId };
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationAccepted", common), credential);
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationStarted", common), credential);
  await getDatabasePool().query(
    `UPDATE repositories SET allowed_agent_ids='[]'::jsonb
       WHERE workspace_id=$1 AND repository_id=$2`,
    [workspaceId, repository.repository_id],
  );
  const request = claimed.assignment.request;
  const envelope = {
    contract_version: "1.0",
    operation: "detect_repository",
    status: "succeeded",
    repository: {
      id: repository.repository_id,
      checkout_path: request.repositoryLocator,
      head_sha: request.startingSha,
      ending_head_sha: request.startingSha,
    },
    artifacts: [],
    warnings: [],
    blockers: [],
    required_actions: [],
    human_approval_required: false,
    repository_files_changed: false,
    exit_classification: "success",
    data: { initialized: true },
  };
  const unsigned = {
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestChecksum: request.requestChecksum,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    startingSha: request.startingSha,
    endingSha: request.startingSha,
    projectBrainVersion: request.requiredProjectBrainVersion,
    schemaVersions: request.requiredSchemaVersions,
    durationMs: 1,
    process: { exitCode: 0, stdoutSha256: "1".repeat(64), stderrSha256: "2".repeat(64) },
    envelope,
  };
  const response = { ...unsigned, responseChecksum: canonicalHash(unsigned) };
  assert.deepEqual(
    await processRemoteMessage(
      agentMessage("RemoteProjectBrainOperationSucceeded", { ...common, response }),
      credential,
    ),
    { status: "succeeded", artifactCount: 0 },
  );
  await getDatabasePool().query(
    `UPDATE repositories SET allowed_agent_ids=jsonb_build_array($3::text)
       WHERE workspace_id=$1 AND repository_id=$2`,
    [workspaceId, repository.repository_id, registration.agentId],
  );
});

test("a partial multi-artifact callback persists no artifacts and records one rejection", async () => {
  await getDatabasePool().query(
    `UPDATE agents SET status='active',last_heartbeat_at=now(),pull_ready_at=now(),
       remote_project_brain_capabilities_at=now() WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, registration.agentId],
  );
  const requested = await requestProjectBrainOperation({
    actor: pbActor,
    request: {
      repositoryId: repository.repository_id,
      operation: "read_context",
      arguments: { path: ".project-brain/context.yaml" },
      idempotencyKey: randomUUID(),
    },
  });
  await executeProjectBrainOperation({
    workspaceId,
    operationId: requested.operationId,
    workerId: "remote-pb-partial-artifact",
  });
  const claimed = await claimRemoteProjectBrainAssignment({
    credential,
    leaseOwner: "partial-artifact",
  });
  const common = { assignmentId: claimed.assignment.assignment_id, operationId: requested.operationId };
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationAccepted", common), credential);
  await processRemoteMessage(agentMessage("RemoteProjectBrainOperationStarted", common), credential);
  const request = claimed.assignment.request;
  const good = Buffer.from("good context");
  const truncated = Buffer.from("truncated");
  const artifacts = [
    {
      kind: "context_pack",
      path: ".project-brain/context-good.yaml",
      schema_version: "2.5.0",
      repository_sha: request.startingSha,
      size: good.byteLength,
      sha256: createHash("sha256").update(good).digest("hex"),
      transfer_mode: "inline_base64",
      content_base64: good.toString("base64"),
    },
    {
      kind: "context_pack",
      path: ".project-brain/context-truncated.yaml",
      schema_version: "2.5.0",
      repository_sha: request.startingSha,
      size: truncated.byteLength,
      sha256: createHash("sha256").update("different complete body").digest("hex"),
      transfer_mode: "inline_base64",
      content_base64: truncated.toString("base64"),
    },
  ];
  const envelope = {
    contract_version: "1.0",
    operation: "read_context",
    status: "succeeded",
    repository: {
      id: repository.repository_id,
      checkout_path: request.repositoryLocator,
      head_sha: request.startingSha,
      ending_head_sha: request.startingSha,
    },
    artifacts,
    warnings: [],
    blockers: [],
    required_actions: [],
    human_approval_required: false,
    repository_files_changed: false,
    exit_classification: "success",
    data: {},
  };
  const unsigned = {
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestChecksum: request.requestChecksum,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    startingSha: request.startingSha,
    endingSha: request.startingSha,
    projectBrainVersion: request.requiredProjectBrainVersion,
    schemaVersions: request.requiredSchemaVersions,
    durationMs: 1,
    process: { exitCode: 0, stdoutSha256: "3".repeat(64), stderrSha256: "4".repeat(64) },
    envelope,
  };
  const response = { ...unsigned, responseChecksum: canonicalHash(unsigned) };
  await assert.rejects(
    processRemoteMessage(agentMessage("RemoteProjectBrainOperationSucceeded", { ...common, response }), credential),
    /artifact failed integrity validation/,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        `SELECT count(*)::int count FROM remote_project_brain_artifacts
         WHERE workspace_id=$1 AND operation_id=$2`,
        [workspaceId, requested.operationId],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        `SELECT count(*)::int count FROM events WHERE workspace_id=$1 AND aggregate_id=$2
         AND event_type='project_brain.remote_artifact_rejected'`,
        [workspaceId, requested.operationId],
      )
    ).rows[0].count,
    1,
  );
  await getDatabasePool().query(
    `UPDATE remote_project_brain_assignments SET status='failed',completed_at=now()
     WHERE workspace_id=$1 AND assignment_id=$2`,
    [workspaceId, claimed.assignment.assignment_id],
  );
});
