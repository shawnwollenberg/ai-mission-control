import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { authenticateProtocolRequest } = await import("../remote-agent/authenticate.ts");
const { deriveSigningKey, sha256, signProtocolRequest, validateEnvelope } = await import("../remote-agent/protocol.ts");
const { reserveProtocolMessage, completeProtocolMessage } = await import("../application/remote-agent-messages.ts");
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
