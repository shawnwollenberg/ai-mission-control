import { randomBytes } from "node:crypto";
import { getDatabasePool } from "@/lib/database";
import { sha256, signProtocolRequest, type ProtocolEnvelope } from "@/remote-agent/protocol";
import { ValidationFailedError } from "@/lib/application-errors";

export async function deliverRemoteMessage(workspaceId: string, payload: Record<string, unknown>) {
  const agentId = String(payload.agentId),
    messageId = String(payload.messageId);
  const row = (
    await getDatabasePool().query<{ endpoint: string; credential_id: string; secret_verifier: string }>(
      `SELECT a.endpoint,c.credential_id,c.secret_verifier FROM agents a JOIN LATERAL (SELECT credential_id,secret_verifier FROM agent_credentials WHERE workspace_id=a.workspace_id AND agent_id=a.agent_id AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY version DESC LIMIT 1) c ON true WHERE a.workspace_id=$1 AND a.agent_id=$2 AND a.status<>'disabled'`,
      [workspaceId, agentId],
    )
  ).rows[0];
  if (!row) throw new ValidationFailedError("Remote agent has no deliverable endpoint credential");
  const path = new URL(row.endpoint).pathname || "/",
    sentAt = new Date().toISOString(),
    nonce = randomBytes(18).toString("base64url");
  const isExecution = String(payload.messageType).startsWith("Execution");
  const envelope: ProtocolEnvelope = {
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: `delivery:${messageId}`,
    agentId,
    workspaceId,
    sentAt,
    messageType: payload.messageType as ProtocolEnvelope["messageType"],
    correlationId: String(payload.missionId ?? payload.executionId),
    ...(isExecution
      ? {
          missionId: String(payload.missionId),
          taskId: String(payload.taskId),
          executionId: String(payload.executionId),
          attempt: Number(payload.attempt),
        }
      : {}),
    payload: {
      ...((isExecution ? payload.taskEnvelope : payload.decisionPayload) as Record<string, unknown>),
      callback: {
        url: `${process.env.MISSION_CONTROL_PUBLIC_URL ?? "http://127.0.0.1:3000"}/api/agent-protocol/v1/messages`,
      },
    },
  };
  const body = JSON.stringify(envelope),
    bodyChecksum = sha256(body),
    signature = signProtocolRequest(row.secret_verifier, {
      method: "POST",
      path,
      timestamp: sentAt,
      nonce,
      messageId,
      protocolVersion: "1.0",
      bodyChecksum,
    });
  await getDatabasePool().query(
    `INSERT INTO webhook_deliveries(workspace_id,delivery_id,execution_id,endpoint_reference,idempotency_key,status,attempt_count,message_id,agent_id,message_type,created_at,updated_at) VALUES($1,gen_random_uuid(),$2,$3,$4,'pending',0,$5,$6,$7,now(),now()) ON CONFLICT(workspace_id,message_id) WHERE message_id IS NOT NULL DO UPDATE SET updated_at=now()`,
    [workspaceId, payload.executionId, row.endpoint, `delivery:${messageId}`, messageId, agentId, payload.messageType],
  );
  try {
    const response = await fetch(row.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "x-mc-agent-id": agentId,
        "x-mc-credential-id": row.credential_id,
        "x-mc-timestamp": sentAt,
        "x-mc-nonce": nonce,
        "x-mc-message-id": messageId,
        "x-mc-protocol-version": "1.0",
        "x-mc-body-sha256": bodyChecksum,
        "x-mc-signature": signature,
      },
      body,
    });
    const acknowledgement = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || acknowledgement?.messageId !== messageId || acknowledgement?.received !== true)
      throw new Error(`Invalid remote transport acknowledgement (${response.status})`);
    await getDatabasePool().query(
      "UPDATE webhook_deliveries SET status='delivered',attempt_count=attempt_count+1,response_status=$3,response_summary='transport acknowledged',delivered_at=now(),updated_at=now() WHERE workspace_id=$1 AND message_id=$2",
      [workspaceId, messageId, response.status],
    );
    if (String(payload.messageType).startsWith("Approval"))
      await getDatabasePool().query(
        "UPDATE approval_projections SET remote_decision_delivery_status=CASE WHEN remote_decision_delivery_status='acknowledged' THEN 'acknowledged' ELSE 'delivered' END,remote_decision_message_id=$3,remote_decision_delivered_at=now() WHERE workspace_id=$1 AND approval_id=$2",
        [workspaceId, payload.approvalId, messageId],
      );
    return acknowledgement;
  } catch (error) {
    await getDatabasePool().query(
      "UPDATE webhook_deliveries SET status='failed',attempt_count=attempt_count+1,last_error_class='retryable_transport',response_summary=$3,updated_at=now() WHERE workspace_id=$1 AND message_id=$2",
      [workspaceId, messageId, error instanceof Error ? error.message : "Remote delivery failed"],
    );
    if (String(payload.messageType).startsWith("Approval"))
      await getDatabasePool().query(
        "UPDATE approval_projections SET remote_decision_delivery_status='failed',remote_decision_message_id=$3 WHERE workspace_id=$1 AND approval_id=$2",
        [workspaceId, payload.approvalId, messageId],
      );
    throw error;
  }
}
