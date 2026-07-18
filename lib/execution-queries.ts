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
export type ExecutionReadModel = {
  executionId: string;
  taskId: string;
  agentId?: string;
  agentName?: string;
  adapterType: string;
  status: string;
  stage?: string;
  progressSummary?: string;
  attempt: number;
  workerId?: string;
  lastHeartbeat?: string;
  startedAt?: string;
  completedAt?: string;
  branchName?: string;
  worktreePath?: string;
  commitId?: string;
  failureClassification?: string;
  cancellationRequestedAt?: string;
  commandsCompleted: number;
  artifacts: Array<{
    artifactId: string;
    kind: string;
    mediaType: string;
    byteSize: number;
    checksum: string;
    createdAt: string;
  }>;
};
export type ActionReadModel = {
  actionRequestId: string;
  executionId?: string;
  actionType: string;
  status: string;
  policyOutcome?: string;
  policyVersion?: string;
  policyReasons: Array<{ code: string; message: string }>;
  approvalId?: string;
  parameters: Record<string, unknown>;
  result?: Record<string, unknown>;
  requestedAt: string;
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
type ExecutionRow = {
  execution_id: string;
  task_id: string;
  agent_id: string | null;
  agent_name: string | null;
  adapter_type: string;
  status: string;
  stage: string | null;
  progress_summary: string | null;
  attempt: number;
  worker_id: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  branch_name: string | null;
  worktree_path: string | null;
  commit_id: string | null;
  failure_classification: string | null;
  cancellation_requested_at: Date | null;
  commands_completed: number;
};
type ExecutionArtifactRow = {
  artifact_id: string;
  execution_id: string;
  kind: string;
  media_type: string;
  byte_size: string;
  checksum_sha256: string;
  created_at: Date;
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
  const executions = await getDatabasePool().query<ExecutionRow>(
    `SELECT e.*,a.name agent_name,h.received_at heartbeat_at,(SELECT count(*)::int FROM events ev WHERE ev.workspace_id=e.workspace_id AND ev.aggregate_type='execution' AND ev.aggregate_id=e.execution_id AND ev.event_type='execution.command_completed') commands_completed FROM execution_projections e LEFT JOIN agents a ON a.workspace_id=e.workspace_id AND a.agent_id=e.agent_id LEFT JOIN execution_heartbeats h ON h.workspace_id=e.workspace_id AND h.execution_id=e.execution_id WHERE e.workspace_id=$1 AND e.mission_id=$2 ORDER BY e.created_at`,
    [workspaceId, missionId],
  );
  const artifactRows = await getDatabasePool().query<ExecutionArtifactRow>(
    "SELECT artifact_id,execution_id,kind,media_type,byte_size,checksum_sha256,created_at FROM artifacts WHERE workspace_id=$1 AND mission_id=$2 AND deleted_at IS NULL ORDER BY created_at",
    [workspaceId, missionId],
  );
  const actions = await getDatabasePool().query(
    `SELECT * FROM action_request_projections WHERE workspace_id=$1 AND mission_id=$2 ORDER BY requested_at`,
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
    executions: executions.rows.map((e) => ({
      executionId: e.execution_id,
      taskId: e.task_id,
      ...(e.agent_id ? { agentId: e.agent_id } : {}),
      ...(e.agent_name ? { agentName: e.agent_name } : {}),
      adapterType: e.adapter_type,
      status: e.status,
      ...(e.stage ? { stage: e.stage } : {}),
      ...(e.progress_summary ? { progressSummary: e.progress_summary } : {}),
      attempt: e.attempt,
      ...(e.worker_id ? { workerId: e.worker_id } : {}),
      ...(e.heartbeat_at ? { lastHeartbeat: e.heartbeat_at.toISOString() } : {}),
      ...(e.started_at ? { startedAt: e.started_at.toISOString() } : {}),
      ...(e.completed_at ? { completedAt: e.completed_at.toISOString() } : {}),
      ...(e.branch_name ? { branchName: e.branch_name } : {}),
      ...(e.worktree_path ? { worktreePath: e.worktree_path } : {}),
      ...(e.commit_id ? { commitId: e.commit_id } : {}),
      ...(e.failure_classification ? { failureClassification: e.failure_classification } : {}),
      ...(e.cancellation_requested_at ? { cancellationRequestedAt: e.cancellation_requested_at.toISOString() } : {}),
      commandsCompleted: e.commands_completed,
      artifacts: artifactRows.rows
        .filter((a) => a.execution_id === e.execution_id)
        .map((a) => ({
          artifactId: a.artifact_id,
          kind: a.kind,
          mediaType: a.media_type,
          byteSize: Number(a.byte_size),
          checksum: a.checksum_sha256,
          createdAt: a.created_at.toISOString(),
        })),
    })),
    actions: actions.rows.map((a) => ({
      actionRequestId: a.action_request_id,
      ...(a.execution_id ? { executionId: a.execution_id } : {}),
      actionType: a.action_type,
      status: a.status,
      ...(a.policy_outcome ? { policyOutcome: a.policy_outcome } : {}),
      ...(a.policy_version ? { policyVersion: a.policy_version } : {}),
      policyReasons: a.policy_reasons,
      ...(a.approval_id ? { approvalId: a.approval_id } : {}),
      parameters: a.parameters_summary,
      ...(a.result ? { result: a.result } : {}),
      requestedAt: a.requested_at.toISOString(),
    })),
  };
}
