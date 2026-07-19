#!/usr/bin/env node
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const connectorDir = join(homedir(), ".mission-control");

async function sendHeartbeat(config) {
  const path = "/api/agent-protocol/v1/messages";
  const sentAt = new Date().toISOString();
  const messageId = randomUUID();
  const nonce = randomBytes(18).toString("base64url");
  const body = JSON.stringify({
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: `heartbeat:${messageId}`,
    agentId: config.agentId,
    workspaceId: config.workspaceId,
    sentAt,
    messageType: "AgentHeartbeat",
    correlationId: config.agentId,
    payload: {
      status: "ready",
      agentType: config.agentType,
      runtime: `node ${process.version}`,
      capabilities: config.capabilities,
    },
  });
  const checksum = createHash("sha256").update(body).digest("hex");
  const signingKey = createHash("sha256").update(config.secret).digest("hex");
  const signatureInput = ["POST", path, sentAt, nonce, messageId, checksum, "1.0"].join("\n");
  const signature = createHmac("sha256", signingKey).update(signatureInput).digest("hex");
  const response = await fetch(`${config.missionControlUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": config.agentId,
      "x-mc-credential-id": config.credentialId,
      "x-mc-timestamp": sentAt,
      "x-mc-nonce": nonce,
      "x-mc-message-id": messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": checksum,
      "x-mc-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Mission Control rejected the heartbeat (${response.status}).`);
}

async function run(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await sendHeartbeat(config);
  if (args.includes("--once")) return;
  setInterval(() => void sendHeartbeat(config).catch(() => {}), 30_000);
}

async function install(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const agentDir = join(connectorDir, "agents", config.agentId);
  const configPath = join(agentDir, "config.json");
  const scriptPath = join(connectorDir, "connect-agent.mjs");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  const source = await (await fetch(`${config.missionControlUrl}/connect-agent.mjs`)).text();
  await mkdir(dirname(scriptPath), { recursive: true, mode: 0o700 });
  await writeFile(scriptPath, source, { mode: 0o700 });
  await sendHeartbeat(config);
  const child = spawn(process.execPath, [scriptPath, "--run", configPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(
    `\n✓ Connected\n\nAgent:\n${config.agentName}\n\nWorkspace:\nAuthenticated\n\nHeartbeat:\nReceived\n\nMission Control:\n${config.missionControlUrl}\n\nDone.`,
  );
}

try {
  const encoded = valueAfter("--install");
  const configPath = valueAfter("--run");
  if (encoded) await install(encoded);
  else if (configPath) await run(configPath);
  else throw new Error("Use the connection command shown by Mission Control.");
} catch (error) {
  console.error(`Mission Control connection failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
