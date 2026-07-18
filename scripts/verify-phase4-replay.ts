import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deriveSigningKey, sha256, signProtocolRequest } from "../remote-agent/protocol";
type Fixture = { workspaceId: string; agentId: string; credentialId: string; secret: string };
async function send(
  fixture: Fixture,
  messageId: string,
  nonce: string,
  sentAt: string,
  payload: Record<string, unknown>,
) {
  const url = new URL(
      process.env.MISSION_CONTROL_PROTOCOL_URL ?? "http://127.0.0.1:3000/api/agent-protocol/v1/messages",
    ),
    body = JSON.stringify({
      protocolVersion: "1.0",
      messageId,
      idempotencyKey: `replay-check:${messageId}`,
      agentId: fixture.agentId,
      workspaceId: fixture.workspaceId,
      sentAt,
      messageType: "AgentHeartbeat",
      correlationId: fixture.agentId,
      payload,
    }),
    timestamp = new Date().toISOString(),
    bodyChecksum = sha256(body),
    signature = signProtocolRequest(deriveSigningKey(fixture.secret), {
      method: "POST",
      path: url.pathname,
      timestamp,
      nonce,
      messageId,
      protocolVersion: "1.0",
      bodyChecksum,
    });
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": fixture.agentId,
      "x-mc-credential-id": fixture.credentialId,
      "x-mc-timestamp": timestamp,
      "x-mc-nonce": nonce,
      "x-mc-message-id": messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
    },
    body,
  });
}
async function main() {
  const file = process.env.PHASE4_CREDENTIAL_FILE;
  if (!file) throw new Error("PHASE4_CREDENTIAL_FILE is required");
  const fixture = JSON.parse(await readFile(file, "utf8")) as Fixture,
    messageId = randomUUID(),
    nonce = `replay-${randomUUID()}`,
    sentAt = new Date().toISOString();
  const first = await send(fixture, messageId, nonce, sentAt, { status: "ready" }),
    duplicate = await send(fixture, messageId, nonce, sentAt, { status: "ready" }),
    changed = await send(fixture, messageId, nonce, sentAt, { status: "changed" });
  if (first.status !== 202 || duplicate.status !== 200 || changed.status !== 400)
    throw new Error(`Unexpected replay results: ${first.status}/${duplicate.status}/${changed.status}`);
  console.log(
    JSON.stringify({
      event: "phase4_replay_verified",
      first: first.status,
      duplicate: duplicate.status,
      changedPayload: changed.status,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
