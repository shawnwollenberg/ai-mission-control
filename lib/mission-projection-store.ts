import { getDatabasePool } from "@/lib/database";

export type MissionReadModel = {
  workspaceId: string;
  missionId: string;
  aggregateVersion: number;
  name: string;
  objective: string;
  description?: string;
  domain: string;
  priority: string;
  riskLevel: string;
  status: string;
  requestedOutcome?: string;
  successCriteria: string[];
  constraints: string[];
  budgetLimits: Record<string, number>;
  deadline?: string;
  totalTaskCount: number;
  completedTaskCount: number;
  blockedTaskCount: number;
  readyTaskCount: number;
  runningTaskCount: number;
  waitingApprovalTaskCount: number;
  failedTaskCount: number;
  cancelledTaskCount: number;
  currentCriticalBlocker?: string;
  executionMode: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastEventPosition: number;
  missionType: string;
  repositoryId?: string;
  baseBranch?: string;
  baseCommit?: string;
  repositorySnapshot?: string;
  parentConsensusMissionId?: string;
  approvedPlanArtifactId?: string;
  approvedPlanHash?: string;
};

type MissionProjectionRow = {
  workspace_id: string;
  mission_id: string;
  aggregate_version: number;
  name: string;
  objective: string;
  description: string | null;
  domain: string;
  priority: string;
  risk_level: string;
  status: string;
  requested_outcome: string | null;
  success_criteria: string[];
  constraints: string[];
  budget_limits: Record<string, number>;
  deadline: Date | null;
  total_task_count: number;
  completed_task_count: number;
  blocked_task_count: number;
  ready_task_count: number;
  running_task_count: number;
  waiting_approval_task_count: number;
  failed_task_count: number;
  cancelled_task_count: number;
  current_critical_blocker: string | null;
  execution_mode: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_event_position: string;
  mission_type: string;
  repository_id: string | null;
  base_branch: string | null;
  base_commit: string | null;
  repository_snapshot: string | null;
  parent_consensus_mission_id: string | null;
  approved_plan_artifact_id: string | null;
  approved_plan_hash: string | null;
};

function mapMission(row: MissionProjectionRow): MissionReadModel {
  return {
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    aggregateVersion: row.aggregate_version,
    name: row.name,
    objective: row.objective,
    ...(row.description ? { description: row.description } : {}),
    domain: row.domain,
    priority: row.priority,
    riskLevel: row.risk_level,
    status: row.status,
    ...(row.requested_outcome ? { requestedOutcome: row.requested_outcome } : {}),
    successCriteria: row.success_criteria,
    constraints: row.constraints,
    budgetLimits: row.budget_limits,
    ...(row.deadline ? { deadline: row.deadline.toISOString() } : {}),
    totalTaskCount: row.total_task_count,
    completedTaskCount: row.completed_task_count,
    blockedTaskCount: row.blocked_task_count,
    readyTaskCount: row.ready_task_count,
    runningTaskCount: row.running_task_count,
    waitingApprovalTaskCount: row.waiting_approval_task_count,
    failedTaskCount: row.failed_task_count,
    cancelledTaskCount: row.cancelled_task_count,
    ...(row.current_critical_blocker ? { currentCriticalBlocker: row.current_critical_blocker } : {}),
    executionMode: row.execution_mode,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastEventPosition: Number(row.last_event_position),
    missionType: row.mission_type,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    ...(row.base_branch ? { baseBranch: row.base_branch } : {}),
    ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
    ...(row.repository_snapshot ? { repositorySnapshot: row.repository_snapshot } : {}),
    ...(row.parent_consensus_mission_id ? { parentConsensusMissionId: row.parent_consensus_mission_id } : {}),
    ...(row.approved_plan_artifact_id ? { approvedPlanArtifactId: row.approved_plan_artifact_id } : {}),
    ...(row.approved_plan_hash ? { approvedPlanHash: row.approved_plan_hash } : {}),
  };
}

const columns = `workspace_id, mission_id, aggregate_version, name, objective, description, domain, priority, risk_level,
  status, requested_outcome, success_criteria, constraints, budget_limits, deadline, total_task_count,
  completed_task_count, blocked_task_count, ready_task_count, running_task_count,
  waiting_approval_task_count, failed_task_count, cancelled_task_count, current_critical_blocker,
  execution_mode, created_by, created_at, updated_at, last_event_position,mission_type,repository_id,base_branch,
  base_commit,repository_snapshot,parent_consensus_mission_id,approved_plan_artifact_id,approved_plan_hash`;

export async function getMissionProjection(
  workspaceId: string,
  missionId: string,
): Promise<MissionReadModel | undefined> {
  const result = await getDatabasePool().query<MissionProjectionRow>(
    `SELECT ${columns} FROM mission_projections WHERE workspace_id = $1 AND mission_id = $2`,
    [workspaceId, missionId],
  );
  return result.rows[0] ? mapMission(result.rows[0]) : undefined;
}

export async function listMissionProjections(workspaceId: string): Promise<MissionReadModel[]> {
  const result = await getDatabasePool().query<MissionProjectionRow>(
    `SELECT ${columns} FROM mission_projections WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return result.rows.map(mapMission);
}
