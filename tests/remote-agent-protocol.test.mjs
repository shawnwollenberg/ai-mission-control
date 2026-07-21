import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  deriveSigningKey,
  safeSignatureEqual,
  sha256,
  signProtocolRequest,
  validateEnvelope,
} from "../remote-agent/protocol.ts";
import { rateCategory } from "../remote-agent/security.ts";

test("agent and execution heartbeats have independent rate-limit categories", () => {
  assert.equal(rateCategory({ messageType: "AgentHeartbeat" }), "agent_heartbeat");
  assert.equal(rateCategory({ messageType: "ExecutionHeartbeat" }), "execution_heartbeat");
});

test("protocol signature binds every required transport field", () => {
  const key = deriveSigningKey("one-time-agent-secret");
  const input = {
    method: "POST",
    path: "/api/agent-protocol/v1/messages",
    timestamp: "2026-07-18T12:00:00.000Z",
    nonce: "nonce-one",
    messageId: randomUUID(),
    bodyChecksum: sha256("{}"),
    protocolVersion: "1.0",
  };
  const signature = signProtocolRequest(key, input);
  assert.equal(safeSignatureEqual(signature, signProtocolRequest(key, input)), true);
  assert.equal(safeSignatureEqual(signature, signProtocolRequest(key, { ...input, nonce: "nonce-two" })), false);
  assert.equal(safeSignatureEqual(signature, "not-a-signature"), false);
});

test("protocol envelope rejects unknown fields and identity mismatch", () => {
  const agentId = randomUUID(),
    workspaceId = randomUUID(),
    messageId = randomUUID();
  const valid = {
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: "heartbeat-1",
    agentId,
    workspaceId,
    sentAt: "2026-07-18T12:00:00.000Z",
    messageType: "AgentHeartbeat",
    correlationId: randomUUID(),
    payload: { status: "ready" },
  };
  assert.equal(validateEnvelope(valid, { agentId, workspaceId, messageId }).messageType, "AgentHeartbeat");
  assert.throws(
    () => validateEnvelope({ ...valid, secret: "forbidden" }, { agentId, workspaceId, messageId }),
    /unsupported fields/,
  );
  assert.throws(() => validateEnvelope(valid, { agentId: randomUUID(), workspaceId, messageId }), /identity mismatch/);
});

test("execution messages require complete correlation fields", () => {
  const agentId = randomUUID(),
    workspaceId = randomUUID(),
    messageId = randomUUID();
  assert.throws(
    () =>
      validateEnvelope(
        {
          protocolVersion: "1.0",
          messageId,
          idempotencyKey: "progress-1",
          agentId,
          workspaceId,
          sentAt: "2026-07-18T12:00:00.000Z",
          messageType: "ExecutionProgressReported",
          correlationId: randomUUID(),
          payload: { summary: "working" },
        },
        { agentId, workspaceId, messageId },
      ),
    /correlation fields/,
  );
});
