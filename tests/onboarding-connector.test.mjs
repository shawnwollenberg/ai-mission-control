import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("the one-command connector sends a correctly signed workspace heartbeat", async () => {
  const workspaceId = "3ae5d14a-f57a-4a8a-bc98-65d58b99a214";
  const agentId = "b33c427d-209a-49c5-9d0b-1b10d21ad7bf";
  const credentialId = "9898d264-2a77-4438-b85d-c2c601df6dd8";
  const secret = "mc_agent_test_secret";
  let received;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = { headers: request.headers, body };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const directory = await mkdtemp(join(tmpdir(), "mc-connector-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        missionControlUrl: `http://127.0.0.1:${address.port}`,
        workspaceId,
        agentId,
        credentialId,
        secret,
        agentType: "codex",
        agentName: "Codex",
        capabilities: ["repository.read"],
      }),
    );
    await run(process.execPath, ["public/connect-agent.mjs", "--run", configPath, "--once"]);
    assert.ok(received);
    const checksum = createHash("sha256").update(received.body).digest("hex");
    assert.equal(received.headers["x-mc-body-sha256"], checksum);
    assert.equal(received.headers["x-mc-agent-id"], agentId);
    assert.equal(received.headers["x-mc-credential-id"], credentialId);
    const signingKey = createHash("sha256").update(secret).digest("hex");
    const signatureInput = [
      "POST",
      "/api/agent-protocol/v1/messages",
      received.headers["x-mc-timestamp"],
      received.headers["x-mc-nonce"],
      received.headers["x-mc-message-id"],
      checksum,
      "1.0",
    ].join("\n");
    assert.equal(
      received.headers["x-mc-signature"],
      createHmac("sha256", signingKey).update(signatureInput).digest("hex"),
    );
    const envelope = JSON.parse(received.body);
    assert.equal(envelope.messageType, "AgentHeartbeat");
    assert.equal(envelope.workspaceId, workspaceId);
    assert.equal(envelope.agentId, agentId);
    assert.deepEqual(envelope.payload.capabilities, ["repository.read"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
