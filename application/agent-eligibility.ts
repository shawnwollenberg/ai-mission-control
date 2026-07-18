import { getDatabasePool } from "@/lib/database";

export type AgentHealthStatus = "active" | "degraded" | "stale" | "offline" | "disabled";
export type RequiredResource = { resourceType: string; resourceId: string; permission: string };
export type EligibilityResult = { eligible: boolean; reasons: string[]; health: AgentHealthStatus; score: number };
type AgentRow = {
  status: string;
  credential_status: string;
  last_heartbeat_at: Date | null;
  concurrency_limit: number;
  capabilities: string[];
  supported_domains: string[];
  protocol_versions: string[];
  current_executions: number;
  delivery_failures: number;
  execution_failures: number;
  protocol_failures: number;
  trust_level: string;
  cost_metadata: Record<string, unknown>;
  valid_credentials: number;
};
export function calculateAgentHealth(
  row: AgentRow,
  now = Date.now(),
): { status: AgentHealthStatus; reasons: string[] } {
  if (row.status === "disabled") return { status: "disabled", reasons: ["Agent is manually disabled"] };
  if (!row.valid_credentials || row.credential_status === "revoked")
    return { status: "offline", reasons: ["No valid credential"] };
  if (!row.last_heartbeat_at) return { status: "offline", reasons: ["No heartbeat received"] };
  const interval = Number(process.env.REMOTE_AGENT_HEARTBEAT_INTERVAL_MS ?? 30_000),
    age = now - row.last_heartbeat_at.getTime(),
    offline = Number(process.env.REMOTE_AGENT_OFFLINE_MS ?? 300_000);
  if (age > offline) return { status: "offline", reasons: ["Heartbeat exceeded offline threshold"] };
  if (age > interval * 4) return { status: "stale", reasons: ["Heartbeat missed more than four intervals"] };
  if (
    age > interval * 2 ||
    row.delivery_failures > 0 ||
    row.protocol_failures > 0 ||
    row.execution_failures > 0 ||
    row.current_executions >= row.concurrency_limit
  )
    return {
      status: "degraded",
      reasons: [
        age > interval * 2 ? "Heartbeat missed at least two intervals" : "Recent failure or concurrency saturation",
      ],
    };
  return { status: "active", reasons: ["Heartbeat and operational signals are healthy"] };
}
async function row(workspaceId: string, agentId: string) {
  return (
    await getDatabasePool().query<AgentRow>(
      `SELECT a.*,count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled'))::int current_executions,count(e.*) FILTER(WHERE e.status IN('failed','timed_out') AND e.updated_at>now()-interval '1 hour')::int execution_failures,(SELECT count(*)::int FROM webhook_deliveries d WHERE d.workspace_id=a.workspace_id AND d.agent_id=a.agent_id AND d.status='failed' AND d.updated_at>now()-interval '1 hour') delivery_failures,(SELECT count(*)::int FROM protocol_security_events s WHERE s.workspace_id=a.workspace_id AND s.agent_id=a.agent_id AND s.occurred_at>now()-interval '1 hour') protocol_failures,(SELECT count(*)::int FROM agent_credentials c WHERE c.workspace_id=a.workspace_id AND c.agent_id=a.agent_id AND c.status IN('active','pending_verification','expiring') AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now())) valid_credentials FROM agents a LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id WHERE a.workspace_id=$1 AND a.agent_id=$2 GROUP BY a.workspace_id,a.agent_id`,
      [workspaceId, agentId],
    )
  ).rows[0];
}
export async function evaluateAgentEligibility(input: {
  workspaceId: string;
  agentId: string;
  domain: string;
  requiredCapabilities: string[];
  requiredResources: RequiredResource[];
  protocolVersion?: string;
}): Promise<EligibilityResult> {
  const agent = await row(input.workspaceId, input.agentId);
  if (!agent)
    return { eligible: false, reasons: ["Agent does not belong to this workspace"], health: "offline", score: 0 };
  const health = calculateAgentHealth(agent),
    reasons: string[] = [];
  if (!["active", "degraded"].includes(health.status)) reasons.push(`Agent health is ${health.status}`);
  if (!(agent.protocol_versions ?? []).includes(input.protocolVersion ?? "1.0"))
    reasons.push("Unsupported protocol version");
  if (!(agent.supported_domains ?? []).includes(input.domain)) reasons.push("Unsupported domain");
  for (const capability of input.requiredCapabilities)
    if (!(agent.capabilities ?? []).includes(capability)) reasons.push(`Missing capability: ${capability}`);
  if (agent.current_executions >= agent.concurrency_limit) reasons.push("Concurrency limit reached");
  for (const resource of input.requiredResources) {
    const permission = await getDatabasePool().query<{ permissions: string[] }>(
      `SELECT permissions FROM agent_resource_permissions WHERE workspace_id=$1 AND agent_id=$2 AND resource_type=$3 AND resource_id=$4 AND revoked_at IS NULL`,
      [input.workspaceId, input.agentId, resource.resourceType, resource.resourceId],
    );
    if (!permission.rows[0]?.permissions.includes(resource.permission))
      reasons.push(`Resource access denied: ${resource.resourceType}/${resource.resourceId}:${resource.permission}`);
  }
  const score = Math.max(
    0,
    100 -
      reasons.length * 25 -
      agent.current_executions * 10 -
      agent.delivery_failures * 5 -
      agent.execution_failures * 5,
  );
  return { eligible: reasons.length === 0, reasons: [...health.reasons, ...reasons], health: health.status, score };
}
export async function grantAgentResource(input: {
  workspaceId: string;
  agentId: string;
  resourceType: string;
  resourceId: string;
  permissions: string[];
}) {
  await getDatabasePool().query(
    `INSERT INTO agent_resource_permissions(workspace_id,agent_id,resource_type,resource_id,permissions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,agent_id,resource_type,resource_id) DO UPDATE SET permissions=EXCLUDED.permissions,revoked_at=NULL`,
    [
      input.workspaceId,
      input.agentId,
      input.resourceType,
      input.resourceId,
      JSON.stringify(Array.from(new Set(input.permissions)).sort()),
    ],
  );
}
