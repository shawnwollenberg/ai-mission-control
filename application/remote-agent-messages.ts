import { getDatabasePool } from "@/lib/database";
import { ValidationFailedError } from "@/lib/application-errors";
import { handleExecutionFact, handleExecutionTransition } from "@/application/execution-commands";
import { handleTaskTransition } from "@/application/task-commands";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { storeExecutionArtifact } from "@/execution/artifact-store";
import { stableUuid } from "@/lib/stable-id";
import { coordinateAfterTask } from "@/application/mission-coordinator";
import type { ProtocolEnvelope } from "@/remote-agent/protocol";
import { sha256 } from "@/remote-agent/protocol";

type Credential = { workspace_id: string; agent_id: string; credential_id: string };
async function executionRow(message: ProtocolEnvelope, workspaceId: string) {
  const row = (
    await getDatabasePool().query<{
      mission_id: string;
      task_id: string;
      agent_id: string;
      attempt: number;
      status: string;
    }>(
      "SELECT mission_id,task_id,agent_id,attempt,status FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
      [workspaceId, message.executionId],
    )
  ).rows[0];
  if (
    !row ||
    row.agent_id !== message.agentId ||
    row.mission_id !== message.missionId ||
    row.task_id !== message.taskId ||
    row.attempt !== message.attempt
  )
    throw new ValidationFailedError("Message is not authorized for this execution");
  return row;
}
const actor = (credential: Credential) => ({
  workspaceId: credential.workspace_id,
  id: credential.agent_id,
  type: "agent" as const,
});
async function transition(
  message: ProtocolEnvelope,
  credential: Credential,
  target: Parameters<typeof handleExecutionTransition>[0]["target"],
  suffix = target,
) {
  return handleExecutionTransition({
    actor: actor(credential),
    commandId: stableUuid(`remote:${message.messageId}:${suffix}`),
    executionId: message.executionId!,
    target,
    details: message.payload,
  });
}
export async function processRemoteMessage(message: ProtocolEnvelope, credential: Credential) {
  if (message.messageType === "AgentHeartbeat" || message.messageType === "AgentCapabilitiesReported") {
    const events = await loadAggregateEvents({
      workspaceId: credential.workspace_id,
      aggregateType: "agent",
      aggregateId: credential.agent_id,
    });
    const eventType =
      message.messageType === "AgentHeartbeat" ? "agent.heartbeat_received" : "agent.capabilities_reported";
    await appendEvents({
      workspaceId: credential.workspace_id,
      aggregateType: "agent",
      aggregateId: credential.agent_id,
      expectedVersion: events.length,
      commandId: stableUuid(`remote:${message.messageId}`),
      commandType: message.messageType,
      correlationId: message.correlationId,
      causationId: events.at(-1)?.eventId,
      actor: { type: "agent", id: credential.agent_id },
      events: [{ eventType, eventSchemaVersion: 1, occurredAt: message.sentAt, payload: message.payload }],
      applyProjections: async (client, appended) => {
        const last = appended.at(-1)!;
        if (eventType === "agent.heartbeat_received") {
          await client.query(
            "UPDATE agents SET last_heartbeat_at=$3,status=CASE WHEN status='disabled' THEN status ELSE 'active' END,updated_at=$3 WHERE workspace_id=$1 AND agent_id=$2",
            [credential.workspace_id, credential.agent_id, last.occurredAt],
          );
          await client.query(
            `INSERT INTO agent_heartbeats(workspace_id,agent_id,credential_id,protocol_version,received_at,reported_at) VALUES($1,$2,$3,'1.0',now(),$4) ON CONFLICT(workspace_id,agent_id) DO UPDATE SET credential_id=EXCLUDED.credential_id,protocol_version=EXCLUDED.protocol_version,received_at=EXCLUDED.received_at,reported_at=EXCLUDED.reported_at`,
            [credential.workspace_id, credential.agent_id, credential.credential_id, message.sentAt],
          );
        } else if (Array.isArray(message.payload.capabilities)) {
          const allowed = (
            await client.query<{ capabilities: string[] }>(
              "SELECT capabilities FROM agents WHERE workspace_id=$1 AND agent_id=$2",
              [credential.workspace_id, credential.agent_id],
            )
          ).rows[0]?.capabilities;
          if (
            !allowed ||
            !message.payload.capabilities.every(
              (capability) => typeof capability === "string" && allowed.includes(capability),
            )
          )
            throw new ValidationFailedError("Agent cannot advertise capabilities outside its owner-approved set");
          await client.query(
            "UPDATE agents SET capabilities=$3,updated_at=now() WHERE workspace_id=$1 AND agent_id=$2",
            [credential.workspace_id, credential.agent_id, JSON.stringify(message.payload.capabilities)],
          );
        }
      },
    });
    return { status: "accepted", eventType };
  }
  const current = await executionRow(message, credential.workspace_id);
  if (["succeeded", "failed", "timed_out", "cancelled"].includes(current.status))
    return { status: "ignored_terminal", executionStatus: current.status };
  switch (message.messageType) {
    case "ExecutionAccepted":
      await transition(message, credential, "accepted");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-running`),
        taskId: message.taskId!,
        target: "running",
        details: { assignedExecutor: message.agentId },
      });
      return { status: "accepted" };
    case "ExecutionRejected":
      await transition(message, credential, "failed");
      return { status: "rejected" };
    case "ExecutionHeartbeat": {
      if (current.status === "accepted") await transition(message, credential, "preparing", "preparing");
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:heartbeat`),
        executionId: message.executionId!,
        type: "execution.progress_reported",
        payload: { ...message.payload, heartbeat: true },
      });
      await getDatabasePool().query(
        "UPDATE execution_projections SET last_heartbeat_at=now() WHERE workspace_id=$1 AND execution_id=$2",
        [credential.workspace_id, message.executionId],
      );
      return { status: "accepted" };
    }
    case "ExecutionProgressReported": {
      if (current.status === "accepted") {
        await transition(message, credential, "preparing", "preparing");
        await transition(message, credential, "running", "running");
      } else if (current.status === "preparing") await transition(message, credential, "running", "running");
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:progress`),
        executionId: message.executionId!,
        type: "execution.progress_reported",
        payload: message.payload,
      });
      return { status: "accepted" };
    }
    case "ExecutionArtifactSubmitted": {
      if (current.status === "accepted") {
        await transition(message, credential, "preparing", "preparing");
        await transition(message, credential, "running", "running");
      } else if (current.status === "preparing") await transition(message, credential, "running", "running");
      const content = String(message.payload.contentBase64 ?? ""),
        body = Buffer.from(content, "base64");
      if (!content || body.byteLength > 128 * 1024)
        throw new ValidationFailedError("Inline artifact is missing or oversized");
      if (message.payload.checksum !== sha256(new Uint8Array(body)))
        throw new ValidationFailedError("Submitted artifact checksum does not match content");
      const artifact = await storeExecutionArtifact({
        workspaceId: credential.workspace_id,
        missionId: message.missionId!,
        taskId: message.taskId!,
        executionId: message.executionId!,
        kind: String(message.payload.artifactType ?? "report"),
        mediaType: String(message.payload.mediaType ?? "text/markdown"),
        body,
        maxBytes: 128 * 1024,
        metadata: {
          name: message.payload.name,
          description: message.payload.description,
          source: "remote-agent",
          messageId: message.messageId,
        },
      });
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:artifact`),
        executionId: message.executionId!,
        type: "execution.artifact_produced",
        payload: {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          byteSize: artifact.byteSize,
          checksum: artifact.checksum,
        },
      });
      return { status: "accepted", artifactId: artifact.artifactId };
    }
    case "ExecutionPaused":
      await transition(message, credential, "paused");
      return { status: "accepted" };
    case "ExecutionResumed":
      await transition(message, credential, "running");
      return { status: "accepted" };
    case "ExecutionSucceeded": {
      const latest = (
        await getDatabasePool().query<{ status: string }>(
          "SELECT status FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
          [credential.workspace_id, message.executionId],
        )
      ).rows[0]?.status;
      if (latest === "accepted") {
        await transition(message, credential, "preparing", "preparing");
        await transition(message, credential, "running", "running");
      } else if (latest === "preparing") await transition(message, credential, "running", "running");
      await transition(message, credential, "verifying", "verifying");
      await transition(message, credential, "succeeded", "succeeded");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-verifying`),
        taskId: message.taskId!,
        target: "verifying",
        details: { verificationSummary: "Remote execution reported success" },
      });
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-complete`),
        taskId: message.taskId!,
        target: "completed",
        details: { outputSummary: message.payload.summary },
      });
      await coordinateAfterTask(credential.workspace_id, message.missionId!, message.taskId!, "task.completed");
      return { status: "completed" };
    }
    case "ExecutionFailed":
      await transition(message, credential, "failed");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-failed`),
        taskId: message.taskId!,
        target: "failed",
        details: message.payload,
      });
      await coordinateAfterTask(credential.workspace_id, message.missionId!, message.taskId!, "task.failed");
      return { status: "failed" };
    case "ExecutionCancellationAcknowledged":
      await transition(message, credential, "cancelled");
      return { status: "cancelled" };
    default:
      throw new ValidationFailedError(`${message.messageType} is not enabled in the first remote-agent slice`);
  }
}

export async function reserveProtocolMessage(input: {
  credential: Credential;
  message: ProtocolEnvelope;
  nonce: string;
  checksum: string;
}) {
  try {
    await getDatabasePool().query(
      `INSERT INTO agent_protocol_receipts(workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`,
      [
        input.credential.workspace_id,
        input.credential.agent_id,
        input.message.messageId,
        input.nonce,
        input.checksum,
        JSON.stringify({ status: "processing" }),
      ],
    );
    return { duplicate: false };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const prior = (
      await getDatabasePool().query<{ body_checksum: string; nonce: string; acknowledgement: Record<string, unknown> }>(
        "SELECT body_checksum,nonce,acknowledgement FROM agent_protocol_receipts WHERE workspace_id=$1 AND agent_id=$2 AND (message_id=$3 OR nonce=$4)",
        [input.credential.workspace_id, input.credential.agent_id, input.message.messageId, input.nonce],
      )
    ).rows[0];
    if (!prior || prior.body_checksum !== input.checksum || prior.nonce !== input.nonce)
      throw new ValidationFailedError("Protocol replay or changed-payload reuse was rejected");
    return { duplicate: true, acknowledgement: prior.acknowledgement };
  }
}
export async function completeProtocolMessage(
  credential: Credential,
  messageId: string,
  acknowledgement: Record<string, unknown>,
) {
  await getDatabasePool().query(
    "UPDATE agent_protocol_receipts SET acknowledgement=$4 WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3",
    [credential.workspace_id, credential.agent_id, messageId, JSON.stringify(acknowledgement)],
  );
}
export async function releaseProtocolMessage(credential: Credential, messageId: string) {
  await getDatabasePool().query(
    "DELETE FROM agent_protocol_receipts WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3 AND acknowledgement=$4",
    [credential.workspace_id, credential.agent_id, messageId, JSON.stringify({ status: "processing" })],
  );
}
