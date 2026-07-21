import { getDatabasePool } from "@/lib/database";
import { ValidationFailedError } from "@/lib/application-errors";
import type { ProtocolEnvelope } from "@/remote-agent/protocol";
const limits: Record<string, number> = {
  callback: 120,
  agent_heartbeat: 6,
  execution_heartbeat: 60,
  progress: 60,
  artifact: 10,
  approval: 10,
  authentication_failure: 20,
  pull: 12,
  lease: 60,
  repository: 10,
};
export function rateCategory(message: ProtocolEnvelope) {
  if (message.messageType === "AgentHeartbeat") return "agent_heartbeat";
  if (message.messageType === "ExecutionHeartbeat") return "execution_heartbeat";
  if (message.messageType === "ExecutionProgressReported") return "progress";
  if (message.messageType === "ExecutionArtifactSubmitted") return "artifact";
  if (message.messageType === "ExecutionApprovalRequested") return "approval";
  return "callback";
}
export async function enforceProtocolRateLimit(workspaceId: string, agentId: string, category: string) {
  const result = await getDatabasePool().query<{ request_count: number }>(
    `INSERT INTO protocol_rate_limits(workspace_id,agent_id,category,window_started_at,request_count) VALUES($1,$2,$3,date_trunc('minute',now()),1) ON CONFLICT(workspace_id,agent_id,category,window_started_at) DO UPDATE SET request_count=protocol_rate_limits.request_count+1 RETURNING request_count`,
    [workspaceId, agentId, category],
  );
  if (result.rows[0].request_count > (limits[category] ?? limits.callback))
    throw new ValidationFailedError("Protocol rate limit exceeded", { category });
}
export async function auditProtocolSecurityFailure(request: Request, reasonCode: string) {
  const agentId = request.headers.get("x-mc-agent-id");
  if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId)) return;
  const agent = (
    await getDatabasePool().query<{ workspace_id: string }>("SELECT workspace_id FROM agents WHERE agent_id=$1", [
      agentId,
    ])
  ).rows[0];
  if (!agent) return;
  await getDatabasePool().query(
    "INSERT INTO protocol_security_events(workspace_id,agent_id,reason_code,metadata) VALUES($1,$2,$3,$4)",
    [agent.workspace_id, agentId, reasonCode, JSON.stringify({ path: new URL(request.url).pathname })],
  );
}
export function securityReason(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("signature")) return "invalid_signature";
  if (message.includes("clock skew") || message.includes("timestamp")) return "expired_timestamp";
  if (message.includes("replay") || message.includes("changed-payload")) return "replay_rejected";
  if (message.includes("rate limit")) return "rate_limit_exceeded";
  if (message.includes("credential")) return "credential_rejected";
  if (message.includes("workspace") || message.includes("identity")) return "identity_mismatch";
  if (message.includes("protocol version")) return "unsupported_protocol_version";
  return "protocol_rejected";
}
