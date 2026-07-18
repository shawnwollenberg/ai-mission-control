import { getDatabasePool } from "@/lib/database";
export async function listApprovalInbox(
  workspaceId: string,
  filters: { status?: string; actionType?: string; missionId?: string; agentId?: string; riskLevel?: string } = {},
) {
  return (
    await getDatabasePool().query(
      `SELECT ap.*,m.name mission_name,t.name task_name,a.name agent_name,ar.status action_status,ar.policy_outcome,ar.policy_reasons,ar.result action_result,ar.parameters_summary FROM approval_projections ap LEFT JOIN mission_projections m ON m.workspace_id=ap.workspace_id AND m.mission_id=ap.mission_id LEFT JOIN task_projections t ON t.workspace_id=ap.workspace_id AND t.task_id=ap.task_id LEFT JOIN agents a ON a.workspace_id=ap.workspace_id AND a.agent_id=ap.agent_id LEFT JOIN action_request_projections ar ON ar.workspace_id=ap.workspace_id AND ar.action_request_id=ap.action_request_id WHERE ap.workspace_id=$1 AND ap.action_request_id IS NOT NULL AND ($2::text IS NULL OR ap.status=$2) AND ($3::text IS NULL OR ar.action_type=$3) AND ($4::uuid IS NULL OR ap.mission_id=$4) AND ($5::uuid IS NULL OR ap.agent_id=$5) AND ($6::text IS NULL OR ap.risk_level=$6) ORDER BY CASE ap.status WHEN 'pending' THEN 0 ELSE 1 END,ap.expires_at NULLS LAST,ap.created_at DESC`,
      [
        workspaceId,
        filters.status ?? null,
        filters.actionType ?? null,
        filters.missionId ?? null,
        filters.agentId ?? null,
        filters.riskLevel ?? null,
      ],
    )
  ).rows;
}
export async function listGovernanceAudit(workspaceId: string) {
  return (
    await getDatabasePool().query(
      `SELECT position,event_id,event_type,aggregate_type,aggregate_id,mission_id,actor_type,actor_id,correlation_id,occurred_at,payload FROM events WHERE workspace_id=$1 AND (aggregate_type IN('action_request','approval') OR event_type LIKE 'policy.%') ORDER BY position DESC LIMIT 250`,
      [workspaceId],
    )
  ).rows;
}
