import { getDatabasePool } from "@/lib/database";
export type TaskReadModel = {
  taskId: string;
  missionId: string;
  name: string;
  status: string;
  priority: string;
  riskLevel: string;
  assignedExecutor?: string;
  currentAttempt: number;
  maximumAttempts: number;
  progressSummary?: string;
  aggregateVersion: number;
  blockingDependencies: string[];
  createdAt: string;
  updatedAt: string;
};
export type ApprovalReadModel = {
  approvalId: string;
  taskId?: string;
  status: string;
  riskExplanation: string;
  requestedAt: string;
  decidedAt?: string;
  decisionReason?: string;
};
type TaskRow = {
  task_id: string;
  mission_id: string;
  name: string;
  status: string;
  priority: string;
  risk_level: string;
  assigned_executor: string | null;
  current_attempt: number;
  maximum_attempts: number;
  progress_summary: string | null;
  aggregate_version: number;
  blocking: string[];
  created_at: Date;
  updated_at: Date;
};
type ApprovalRow = {
  approval_id: string;
  task_id: string | null;
  status: string;
  risk_explanation: string;
  created_at: Date;
  decided_at: Date | null;
  decision_reason: string | null;
};
export async function getMissionExecution(workspaceId: string, missionId: string) {
  const tasks = await getDatabasePool().query<TaskRow>(
    `SELECT t.*,coalesce(array_agg(d.depends_on_task_id::text) FILTER(WHERE d.depends_on_task_id IS NOT NULL AND u.status<>'completed'),'{}') blocking FROM task_projections t LEFT JOIN task_dependencies d ON d.workspace_id=t.workspace_id AND d.task_id=t.task_id LEFT JOIN task_projections u ON u.workspace_id=d.workspace_id AND u.task_id=d.depends_on_task_id WHERE t.workspace_id=$1 AND t.mission_id=$2 GROUP BY t.workspace_id,t.task_id ORDER BY t.created_at`,
    [workspaceId, missionId],
  );
  const approvals = await getDatabasePool().query<ApprovalRow>(
    "SELECT * FROM approval_projections WHERE workspace_id=$1 AND mission_id=$2 ORDER BY created_at",
    [workspaceId, missionId],
  );
  return {
    tasks: tasks.rows.map((r) => ({
      taskId: r.task_id,
      missionId: r.mission_id,
      name: r.name,
      status: r.status,
      priority: r.priority,
      riskLevel: r.risk_level,
      ...(r.assigned_executor ? { assignedExecutor: r.assigned_executor } : {}),
      currentAttempt: r.current_attempt,
      maximumAttempts: r.maximum_attempts,
      ...(r.progress_summary ? { progressSummary: r.progress_summary } : {}),
      aggregateVersion: r.aggregate_version,
      blockingDependencies: r.blocking,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    })),
    dependencies: await getDatabasePool()
      .query<{ task_id: string; depends_on_task_id: string }>(
        "SELECT task_id,depends_on_task_id FROM task_dependencies WHERE workspace_id=$1 AND mission_id=$2 ORDER BY created_at",
        [workspaceId, missionId],
      )
      .then((r) => r.rows.map((x) => ({ taskId: x.task_id, dependsOnTaskId: x.depends_on_task_id }))),
    approvals: approvals.rows.map((r) => ({
      approvalId: r.approval_id,
      ...(r.task_id ? { taskId: r.task_id } : {}),
      status: r.status,
      riskExplanation: r.risk_explanation,
      requestedAt: r.created_at.toISOString(),
      ...(r.decided_at ? { decidedAt: r.decided_at.toISOString() } : {}),
      ...(r.decision_reason ? { decisionReason: r.decision_reason } : {}),
    })),
  };
}
