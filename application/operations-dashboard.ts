import { getDatabasePool } from "@/lib/database";
import { usageRollup } from "@/application/usage-budget";
import { workerHealth } from "@/application/worker-operations";
import { emergencyControlState } from "@/application/emergency-controls";

export async function operationsDashboard(workspaceId: string) {
  const db = getDatabasePool();
  const [counts, activity, upcoming, outcomes, usage, workers, emergencyControls] = await Promise.all([
    db.query(
      `SELECT
      (SELECT count(*) FROM approval_projections WHERE workspace_id=$1 AND status='pending')::int pending_approvals,
      (SELECT count(*) FROM mission_projections WHERE workspace_id=$1 AND status='failed')::int failed_missions,
      (SELECT count(*) FROM task_projections WHERE workspace_id=$1 AND status='failed')::int failed_tasks,
      (SELECT count(*) FROM jobs WHERE workspace_id=$1 AND status='dead_letter')::int dead_letters,
      (SELECT count(*) FROM schedule_projections WHERE workspace_id=$1 AND consecutive_skips>=skip_warning_threshold)::int schedule_warnings,
      (SELECT count(*) FROM notification_deliveries WHERE workspace_id=$1 AND status='failed')::int notification_failures,
      (SELECT count(*) FROM budget_decisions WHERE workspace_id=$1 AND decision IN('deny','approval_required'))::int budget_blocks,
      (SELECT count(*) FROM anomaly_projections WHERE workspace_id=$1 AND status='open')::int anomalies`,
      [workspaceId],
    ),
    db.query(
      `SELECT mission_id,name,status,domain,updated_at FROM mission_projections WHERE workspace_id=$1 AND status IN('draft','planned','running','paused') ORDER BY updated_at DESC LIMIT 20`,
      [workspaceId],
    ),
    db.query(
      `SELECT schedule_id,name,next_run_at,last_run_status FROM schedule_projections WHERE workspace_id=$1 AND enabled=true AND paused=false AND deleted_at IS NULL ORDER BY next_run_at NULLS LAST LIMIT 20`,
      [workspaceId],
    ),
    db.query(
      `SELECT mission_id,name,status,domain,updated_at FROM mission_projections WHERE workspace_id=$1 AND status IN('completed','failed','cancelled') ORDER BY updated_at DESC LIMIT 20`,
      [workspaceId],
    ),
    usageRollup(workspaceId),
    workerHealth(workspaceId),
    emergencyControlState(workspaceId),
  ]);
  const unhealthyWorkers = workers.filter((worker) => worker.calculated_status !== "active" || !worker.ready);
  return {
    attention: { ...counts.rows[0], offline_workers: unhealthyWorkers.length },
    activity: activity.rows,
    upcoming: upcoming.rows,
    outcomes: outcomes.rows,
    usage,
    workers,
    unhealthyWorkers,
    emergencyControls,
  };
}
