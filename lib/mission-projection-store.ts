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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastEventPosition: number;
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
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_event_position: string;
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
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastEventPosition: Number(row.last_event_position),
  };
}

const columns = `workspace_id, mission_id, aggregate_version, name, objective, description, domain, priority, risk_level,
  status, requested_outcome, success_criteria, constraints, budget_limits, deadline, total_task_count,
  completed_task_count, created_by, created_at, updated_at, last_event_position`;

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
