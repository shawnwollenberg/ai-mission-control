import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  deriveSigningKey,
  safeSignatureEqual,
  sha256,
  signProtocolRequest,
  type ProtocolEnvelope,
} from "../../remote-agent/protocol";

type Ledger = { messages: Record<string, { status: string; executionId: string; updatedAt: string }> };
const port = Number(process.env.HERMES_BRIDGE_PORT ?? 4100);
const agentId = process.env.HERMES_AGENT_ID!;
const credentialId = process.env.HERMES_CREDENTIAL_ID!;
const workspaceId = process.env.HERMES_WORKSPACE_ID!;
const secret = process.env.HERMES_AGENT_SECRET!;
const callbackUrl = process.env.MISSION_CONTROL_PROTOCOL_URL ?? "http://127.0.0.1:3000/api/agent-protocol/v1/messages";
const ledgerPath = process.env.HERMES_LEDGER_PATH ?? "/tmp/mission-control-hermes/ledger.json";
if (!agentId || !credentialId || !workspaceId || !secret)
  throw new Error("Hermes bridge credential environment is required");
const key = deriveSigningKey(secret);

async function ledger(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(ledgerPath, "utf8")) as Ledger;
  } catch {
    return { messages: {} };
  }
}
async function save(value: Ledger) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const temporary = `${ledgerPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, ledgerPath);
}
async function callback(message: ProtocolEnvelope) {
  const target = new URL(callbackUrl);
  const body = JSON.stringify(message);
  const bodyChecksum = sha256(body);
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(18).toString("base64url");
  const signature = signProtocolRequest(key, {
    method: "POST",
    path: target.pathname,
    timestamp,
    nonce,
    messageId: message.messageId,
    protocolVersion: "1.0",
    bodyChecksum,
  });
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": agentId,
      "x-mc-credential-id": credentialId,
      "x-mc-timestamp": timestamp,
      "x-mc-nonce": nonce,
      "x-mc-message-id": message.messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Hermes callback failed: ${response.status}`);
  return response.json();
}
function executionMessage(
  request: ProtocolEnvelope,
  messageType: ProtocolEnvelope["messageType"],
  payload: Record<string, unknown>,
): ProtocolEnvelope {
  return {
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: `${request.executionId}:${messageType}`,
    agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: request.correlationId,
    missionId: request.missionId,
    taskId: request.taskId,
    executionId: request.executionId,
    attempt: request.attempt,
    payload,
  };
}
function agentMessage(
  messageType: "AgentHeartbeat" | "AgentCapabilitiesReported" | "ApprovalDecisionAcknowledged",
  payload: Record<string, unknown>,
): ProtocolEnvelope {
  return {
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: `${messageType}:${Date.now()}`,
    agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: agentId,
    payload,
  };
}
async function run(request: ProtocolEnvelope) {
  const state = await ledger();
  try {
    await callback(
      executionMessage(request, "ExecutionAccepted", {
        externalExecutionId: `hermes-${request.executionId}`,
      }),
    );
    await callback(
      executionMessage(request, "ExecutionProgressReported", {
        phase: "health-check",
        summary: "Reading the configured Mission Control health endpoint",
        percent: 25,
      }),
    );
    const capabilities = Array.isArray(request.payload.allowedCapabilities)
      ? (request.payload.allowedCapabilities as string[])
      : [];
    if (capabilities.includes("portfolio.read")) {
      const portfolio = JSON.parse(
        await readFile(new URL("../../fixtures/hermes-defi/aerodrome-portfolio.json", import.meta.url), "utf8"),
      ) as Record<string, unknown>;
      await callback(
        executionMessage(request, "ExecutionProgressReported", {
          phase: "defi-analysis",
          summary: "Analyzing the approved Aerodrome portfolio fixture and simulating read-only candidates",
          percent: 65,
        }),
      );
      const statement = "Analysis only.  No transaction was signed or submitted.";
      const recommendation = {
        recommendation: "Hold",
        rationale: "The position remains in range and estimated fees exceed estimated impermanent loss.",
        statement,
        transactionSigned: false,
        transactionSubmitted: false,
        transactionHash: null,
        portfolio,
      };
      const markdown = [
        "# Aerodrome Portfolio Review",
        "",
        "Recommendation: **Hold**",
        "",
        "The position remains in range. Estimated 30-day fees exceed estimated impermanent loss, and no immediate rebalance is justified by the approved fixture.",
        "",
        statement,
      ].join("\n");
      for (const artifact of [
        {
          name: "aerodrome-analysis.md",
          mediaType: "text/markdown",
          body: Buffer.from(markdown),
          artifactType: "report",
        },
        {
          name: "aerodrome-analysis.json",
          mediaType: "application/json",
          body: Buffer.from(JSON.stringify(recommendation, null, 2)),
          artifactType: "structured_result",
        },
      ])
        await callback(
          executionMessage(request, "ExecutionArtifactSubmitted", {
            artifactType: artifact.artifactType,
            name: artifact.name,
            mediaType: artifact.mediaType,
            size: artifact.body.byteLength,
            checksum: sha256(new Uint8Array(artifact.body)),
            description: "Read-only Aerodrome analysis",
            contentBase64: artifact.body.toString("base64"),
          }),
        );
      await callback(
        executionMessage(request, "ExecutionApprovalRequested", {
          actionType: "transaction.sign",
          parameters: { simulationOnly: false },
          targetResource: "aerodrome-position",
          riskExplanation: "Controlled prohibited-action safety test",
          evidence: [],
        }),
      );
      await callback(
        executionMessage(request, "ExecutionSucceeded", { summary: `${statement} Recommendation: Hold.` }),
      );
      state.messages[request.messageId] = {
        status: "completed",
        executionId: request.executionId!,
        updatedAt: new Date().toISOString(),
      };
      await save(state);
      return;
    }
    const healthUrl = process.env.MISSION_CONTROL_HEALTH_URL ?? "http://127.0.0.1:3000/api/health";
    const healthResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    const health = await healthResponse.json().catch(() => ({ status: "unreadable" }));
    await callback(
      executionMessage(request, "ExecutionProgressReported", {
        phase: "report",
        summary: "Preparing the operational health recommendation",
        percent: 75,
      }),
    );
    const mixed = String(request.payload.instructions ?? "")
      .toLowerCase()
      .includes("recommend one bounded");
    const report = [
      "# Mission Control Daily System Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      `Health endpoint: ${healthResponse.ok ? "reachable" : "unhealthy"}`,
      "",
      "## Observed result",
      "",
      "```json",
      JSON.stringify(health, null, 2),
      "```",
      "",
      "## Recommendation",
      "",
      healthResponse.ok
        ? "Continue normal operations and review pending approvals."
        : "Human review is required; no remediation was attempted.",
      "",
      "No service, database, policy, infrastructure, secret, or financial action was modified.",
    ].join("\n");
    const body = Buffer.from(report);
    await callback(
      executionMessage(request, "ExecutionArtifactSubmitted", {
        artifactType: "report",
        name: "mission-control-daily-health.md",
        mediaType: "text/markdown",
        size: body.byteLength,
        checksum: sha256(new Uint8Array(body)),
        description: "Read-only operational health report",
        contentBase64: body.toString("base64"),
      }),
    );
    if (mixed) {
      await callback(
        executionMessage(request, "ExecutionApprovalRequested", {
          actionType: "task.activate_codex",
          parameters: {
            handoff: {
              recommendationTitle: "Add a bounded health-response timestamp",
              problemStatement: "The fixture health response does not expose when it was generated.",
              evidence: ["mission-control-daily-health.md"],
              suggestedChange: "Add a generatedAt timestamp to the fixture health response and update its test.",
              expectedOutcome: "One tested local commit adding generatedAt metadata.",
              riskLevel: "low",
              acceptanceCriteria: ["Health response includes generatedAt", "Existing and updated tests pass"],
              testExpectations: ["node --test health.test.mjs"],
              nonGoals: ["No deployment", "No infrastructure change", "No production remediation"],
            },
          },
          targetResource: "mission:codex-task",
          riskExplanation: "Activate one bounded low-risk Codex implementation task",
          evidence: ["mission-control-daily-health.md"],
        }),
      );
      state.messages[request.messageId] = {
        status: "waiting_for_approval",
        executionId: request.executionId!,
        updatedAt: new Date().toISOString(),
      };
      await save(state);
      return;
    }
    await callback(
      executionMessage(request, "ExecutionSucceeded", {
        summary: "Operational health report completed without modifying the system",
      }),
    );
    state.messages[request.messageId] = {
      status: "completed",
      executionId: request.executionId!,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    state.messages[request.messageId] = {
      status: "failed",
      executionId: request.executionId!,
      updatedAt: new Date().toISOString(),
    };
    await callback(
      executionMessage(request, "ExecutionFailed", {
        code: "hermes_bridge_failure",
        retryable: true,
        summary: error instanceof Error ? error.message : "Hermes bridge failed",
      }),
    ).catch(() => undefined);
  }
  await save(state);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: number[] = [];
    for await (const chunk of request) chunks.push(...Array.from(new Uint8Array(Buffer.from(chunk))));
    const body = new TextDecoder().decode(Uint8Array.from(chunks));
    const message = JSON.parse(body) as ProtocolEnvelope;
    const bodyChecksum = String(request.headers["x-mc-body-sha256"] ?? "");
    const timestamp = String(request.headers["x-mc-timestamp"] ?? "");
    const nonce = String(request.headers["x-mc-nonce"] ?? "");
    const messageId = String(request.headers["x-mc-message-id"] ?? "");
    const protocolVersion = String(request.headers["x-mc-protocol-version"] ?? "");
    const signature = String(request.headers["x-mc-signature"] ?? "");
    const expected = signProtocolRequest(key, {
      method: "POST",
      path: request.url ?? "/",
      timestamp,
      nonce,
      messageId,
      protocolVersion,
      bodyChecksum,
    });
    if (sha256(body) !== bodyChecksum || message.messageId !== messageId || !safeSignatureEqual(expected, signature)) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ received: false }));
      return;
    }
    const state = await ledger();
    if (["ApprovalGranted", "ApprovalDenied", "ApprovalExpired", "ApprovalCancelled"].includes(message.messageType)) {
      await callback(
        agentMessage("ApprovalDecisionAcknowledged", {
          approvalId: message.payload.approvalId,
          decisionMessageId: message.messageId,
        }),
      );
      if (message.messageType === "ApprovalGranted") {
        const executionRequest: ProtocolEnvelope = {
          protocolVersion: "1.0",
          messageId: randomUUID(),
          idempotencyKey: `resume:${message.payload.approvalId}`,
          agentId,
          workspaceId,
          sentAt: new Date().toISOString(),
          messageType: "ExecutionRequested",
          correlationId: String(message.payload.missionId),
          missionId: String(message.payload.missionId),
          taskId: String(message.payload.taskId),
          executionId: String(message.payload.executionId),
          attempt: Number(message.payload.attempt),
          payload: {},
        };
        await callback(
          executionMessage(executionRequest, "ExecutionResumed", { approvalId: message.payload.approvalId }),
        );
        await callback(
          executionMessage(executionRequest, "ExecutionSucceeded", {
            summary: "Hermes recommendation was approved and the bounded Codex handoff was activated.",
          }),
        );
      } else if (message.messageType === "ApprovalDenied") {
        const executionRequest: ProtocolEnvelope = {
          protocolVersion: "1.0",
          messageId: randomUUID(),
          idempotencyKey: `retry-approval:${message.payload.approvalId}`,
          agentId,
          workspaceId,
          sentAt: new Date().toISOString(),
          messageType: "ExecutionRequested",
          correlationId: String(message.payload.missionId),
          missionId: String(message.payload.missionId),
          taskId: String(message.payload.taskId),
          executionId: String(message.payload.executionId),
          attempt: Number(message.payload.attempt),
          payload: {},
        };
        const requestedAction = message.payload.requestedAction as Record<string, unknown>;
        await callback(
          executionMessage(executionRequest, "ExecutionApprovalRequested", {
            actionType: requestedAction.actionType,
            parameters: requestedAction.parameters,
            targetResource: requestedAction.targetResource,
            riskExplanation: "Second owner review requested after the first recommendation was denied",
            evidence: ["mission-control-daily-health.md"],
          }),
        );
      }
      response
        .writeHead(202, { "content-type": "application/json" })
        .end(JSON.stringify({ received: true, messageId, duplicate: false }));
      return;
    }
    const duplicate = Boolean(state.messages[messageId]);
    if (!duplicate) {
      state.messages[messageId] = {
        status: "received",
        executionId: message.executionId!,
        updatedAt: new Date().toISOString(),
      };
      await save(state);
      setImmediate(() => void run(message));
    }
    response
      .writeHead(202, { "content-type": "application/json" })
      .end(JSON.stringify({ received: true, messageId, duplicate }));
  } catch {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ received: false }));
  }
});
server.listen(port, "127.0.0.1", async () => {
  console.log(JSON.stringify({ event: "hermes_bridge_started", port, agentId }));
  try {
    const advertisedCapabilities =
      process.env.HERMES_MODE === "defi"
        ? [
            "portfolio.read",
            "market.read",
            "protocol.read",
            "position.analyze",
            "transaction.simulate",
            "strategy.recommend",
            "artifact.create",
          ]
        : ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"];
    await callback(
      agentMessage("AgentCapabilitiesReported", {
        capabilities: advertisedCapabilities,
        domains: [process.env.HERMES_MODE === "defi" ? "defi_analysis" : "systems_monitoring"],
      }),
    );
    await callback(agentMessage("AgentHeartbeat", { status: "ready", concurrencyAvailable: 1 }));
    console.log(JSON.stringify({ event: "hermes_bridge_ready", agentId }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "hermes_bridge_registration_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
