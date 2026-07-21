import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent, rotateRemoteAgentCredential, revokeRemoteAgentCredential } =
  await import("../application/remote-agent-registry.ts");
const { authenticateProtocolRequest } = await import("../remote-agent/authenticate.ts");
const { deriveSigningKey, sha256, signProtocolRequest, validateEnvelope } = await import("../remote-agent/protocol.ts");
const { reserveProtocolMessage, completeProtocolMessage } = await import("../application/remote-agent-messages.ts");
const { evaluateAgentEligibility, grantAgentResource } = await import("../application/agent-eligibility.ts");
const { requestRemoteApproval, decideApproval } = await import("../application/approval-commands.ts");
const { enforceProtocolRateLimit } = await import("../remote-agent/security.ts");
const workspaceId = randomUUID(),
  actor = { workspaceId, userId: "owner", role: "owner" };
let registration;
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Remote Agent Protocol')", [
    workspaceId,
    `remote-${workspaceId}`,
  ]);
  registration = await registerRemoteAgent({
    actor,
    name: "Hermes fixture",
    endpoint: "http://127.0.0.1:4100/executions",
    capabilities: ["health.verify", "report.create"],
    supportedDomains: ["systems_monitoring"],
  });
});
test.after(async () => {
  for (const table of [
    "agent_protocol_receipts",
    "agent_heartbeats",
    "agent_resource_permissions",
    "approval_projections",
    "outbox",
    "events",
    "commands",
    "aggregate_heads",
    "agent_credentials",
    "agents",
  ])
    await getDatabasePool().query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});
function signedRequest({
  messageId = randomUUID(),
  nonce = randomBytes(12).toString("hex"),
  sentAt = new Date().toISOString(),
  payload = { status: "ready" },
} = {}) {
  const path = "/api/agent-protocol/v1/messages",
    body = JSON.stringify({
      protocolVersion: "1.0",
      messageId,
      idempotencyKey: `heartbeat:${messageId}`,
      agentId: registration.agentId,
      workspaceId,
      sentAt,
      messageType: "AgentHeartbeat",
      correlationId: registration.agentId,
      payload,
    }),
    timestamp = new Date().toISOString(),
    bodyChecksum = sha256(body),
    signature = signProtocolRequest(deriveSigningKey(registration.credential.secret), {
      method: "POST",
      path,
      timestamp,
      nonce,
      messageId,
      protocolVersion: "1.0",
      bodyChecksum,
    });
  return {
    request: new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mc-agent-id": registration.agentId,
        "x-mc-credential-id": registration.credential.credentialId,
        "x-mc-timestamp": timestamp,
        "x-mc-nonce": nonce,
        "x-mc-message-id": messageId,
        "x-mc-protocol-version": "1.0",
        "x-mc-body-sha256": bodyChecksum,
        "x-mc-signature": signature,
      },
      body,
    }),
    path,
    messageId,
    nonce,
    bodyChecksum,
  };
}
test("signed credential authenticates while raw credential is never persisted", async () => {
  const input = signedRequest(),
    authenticated = await authenticateProtocolRequest(input.request, input.path);
  assert.equal(authenticated.credential.agent_id, registration.agentId);
  const matches = await getDatabasePool().query(
    "SELECT count(*)::int total FROM events WHERE workspace_id=$1 AND (payload::text LIKE '%'||$2||'%' OR metadata::text LIKE '%'||$2||'%')",
    [workspaceId, registration.credential.secret],
  );
  assert.equal(matches.rows[0].total, 0);
});
test("message receipt is idempotent and changed-payload reuse is rejected", async () => {
  const input = signedRequest(),
    authenticated = await authenticateProtocolRequest(input.request, input.path),
    message = validateEnvelope(JSON.parse(authenticated.body), {
      agentId: registration.agentId,
      workspaceId,
      messageId: input.messageId,
    }),
    credential = authenticated.credential;
  assert.deepEqual(
    await reserveProtocolMessage({ credential, message, nonce: input.nonce, checksum: input.bodyChecksum }),
    { duplicate: false },
  );
  await completeProtocolMessage(credential, input.messageId, { received: true });
  assert.equal(
    (await reserveProtocolMessage({ credential, message, nonce: input.nonce, checksum: input.bodyChecksum })).duplicate,
    true,
  );
  await assert.rejects(
    () => reserveProtocolMessage({ credential, message, nonce: input.nonce, checksum: "a".repeat(64) }),
    /replay or changed-payload/,
  );
});
test("invalid signature and expired timestamp are rejected", async () => {
  const invalid = signedRequest();
  invalid.request.headers.set("x-mc-signature", "0".repeat(64));
  await assert.rejects(() => authenticateProtocolRequest(invalid.request, invalid.path), /signature/);
  const expired = signedRequest();
  expired.request.headers.set("x-mc-timestamp", "2020-01-01T00:00:00.000Z");
  await assert.rejects(() => authenticateProtocolRequest(expired.request, expired.path), /clock skew/);
});
test("credential rotation overlaps, verifies by heartbeat, and revokes the old credential immediately", async () => {
  const original = registration.credential;
  const replacement = await rotateRemoteAgentCredential({ actor, agentId: registration.agentId, overlapSeconds: 60 });
  const oldRequest = signedRequest();
  assert.equal(
    (await authenticateProtocolRequest(oldRequest.request, oldRequest.path)).credential.credential_id,
    original.credentialId,
  );
  const prior = registration;
  registration = { agentId: prior.agentId, credential: replacement.credential };
  const newRequest = signedRequest();
  const authenticated = await authenticateProtocolRequest(newRequest.request, newRequest.path);
  const message = validateEnvelope(JSON.parse(authenticated.body), {
    agentId: registration.agentId,
    workspaceId,
    messageId: newRequest.messageId,
  });
  const { processRemoteMessage } = await import("../application/remote-agent-messages.ts");
  await processRemoteMessage(message, authenticated.credential);
  const verified = await getDatabasePool().query(
    "SELECT status,verified_at FROM agent_credentials WHERE workspace_id=$1 AND credential_id=$2",
    [workspaceId, replacement.credential.credentialId],
  );
  assert.equal(verified.rows[0].status, "active");
  assert.ok(verified.rows[0].verified_at);
  await revokeRemoteAgentCredential({ actor, agentId: registration.agentId, credentialId: original.credentialId });
  registration = { agentId: prior.agentId, credential: original };
  const revoked = signedRequest();
  await assert.rejects(() => authenticateProtocolRequest(revoked.request, revoked.path), /not active/);
  registration = { agentId: prior.agentId, credential: replacement.credential };
});
test("eligibility returns deterministic capability, resource, health, and concurrency reasons", async () => {
  const missing = await evaluateAgentEligibility({
    workspaceId,
    agentId: registration.agentId,
    domain: "systems_monitoring",
    requiredCapabilities: ["health.verify", "logs.read"],
    requiredResources: [
      { resourceType: "monitoring_endpoint", resourceId: "mission-control-health", permission: "read" },
    ],
  });
  assert.equal(missing.eligible, false);
  assert.ok(missing.reasons.includes("Missing capability: logs.read"));
  assert.ok(missing.reasons.some((reason) => reason.startsWith("Resource access denied:")));
  await getDatabasePool().query(
    "UPDATE agents SET capabilities=capabilities||$3::jsonb WHERE workspace_id=$1 AND agent_id=$2",
    [workspaceId, registration.agentId, JSON.stringify(["logs.read"])],
  );
  await grantAgentResource({
    workspaceId,
    agentId: registration.agentId,
    resourceType: "monitoring_endpoint",
    resourceId: "mission-control-health",
    permissions: ["read"],
  });
  const eligible = await evaluateAgentEligibility({
    workspaceId,
    agentId: registration.agentId,
    domain: "systems_monitoring",
    requiredCapabilities: ["health.verify", "logs.read"],
    requiredResources: [
      { resourceType: "monitoring_endpoint", resourceId: "mission-control-health", permission: "read" },
    ],
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.health, "active");
});
test("remote workflow approval is parameter-bound while financial execution is permanently denied", async () => {
  const missionId = randomUUID(),
    taskId = randomUUID(),
    executionId = randomUUID(),
    messageId = randomUUID();
  const prohibited = await requestRemoteApproval({
    workspaceId,
    missionId,
    taskId,
    executionId,
    agentId: registration.agentId,
    messageId,
    actionType: "transaction.sign",
    parameters: { amount: "1" },
    targetResource: "wallet",
    riskExplanation: "Attempted signing",
    evidence: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(prohibited.outcome, "deny");
  assert.equal(
    (
      await getDatabasePool().query("SELECT count(*)::int total FROM approval_projections WHERE workspace_id=$1", [
        workspaceId,
      ])
    ).rows[0].total,
    0,
  );
  const allowed = await requestRemoteApproval({
    workspaceId,
    missionId,
    taskId,
    executionId,
    agentId: registration.agentId,
    messageId: randomUUID(),
    actionType: "analysis.continue",
    parameters: { scope: "health metadata" },
    targetResource: "analysis:health",
    riskExplanation: "Activate bounded implementation",
    evidence: ["report:sha256"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(allowed.outcome, "require_approval");
  await decideApproval({
    workspaceId,
    approvalId: allowed.approvalId,
    granted: true,
    actorId: "owner",
    reason: "Bounded scope approved",
  });
  const projection = await getDatabasePool().query(
    "SELECT status,remote_decision_delivery_status FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
    [workspaceId, allowed.approvalId],
  );
  assert.deepEqual(projection.rows[0], { status: "granted", remote_decision_delivery_status: "pending" });
  const delivery = await getDatabasePool().query(
    "SELECT topic,payload FROM outbox WHERE workspace_id=$1 AND idempotency_key=$2",
    [workspaceId, `decision:${allowed.approvalId}`],
  );
  assert.equal(delivery.rows[0].topic, "remote-agent.delivery");
  assert.equal(delivery.rows[0].payload.messageType, "ApprovalGranted");
});

test("protocol rate limits are enforced per agent and message category", async () => {
  await getDatabasePool().query(
    "DELETE FROM protocol_rate_limits WHERE workspace_id=$1 AND agent_id=$2 AND category='agent_heartbeat'",
    [workspaceId, registration.agentId],
  );
  for (let request = 0; request < 6; request += 1)
    await enforceProtocolRateLimit(workspaceId, registration.agentId, "agent_heartbeat");
  await assert.rejects(
    enforceProtocolRateLimit(workspaceId, registration.agentId, "agent_heartbeat"),
    /Protocol rate limit exceeded/,
  );
});
