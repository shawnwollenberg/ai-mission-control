import { NextResponse } from "next/server";
import { getDatabasePool } from "@/lib/database";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, unauthenticatedResponse } from "@/lib/request-auth";

export const dynamic = "force-dynamic";

type MissionNavigationRow = {
  mission_id: string;
  name: string;
  status: string;
  priority: string;
  risk_level: string;
  updated_at: Date;
  pending_approvals: number;
  blocked_tasks: number;
  failed_tasks: number;
};

export async function GET() {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();

  try {
    const database = getDatabasePool();
    const [counts, missions] = await Promise.all([
      database.query<{
        active_missions: number;
        attention_missions: number;
        pending_approvals: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM mission_projections
           WHERE workspace_id=$1 AND status IN('draft','planned','running','paused')) active_missions,
          (SELECT count(*)::int FROM mission_projections m
           WHERE m.workspace_id=$1 AND (
             m.status IN('paused','failed')
             OR EXISTS(
               SELECT 1 FROM approval_projections approval
               WHERE approval.workspace_id=m.workspace_id AND approval.mission_id=m.mission_id
                 AND approval.status='pending'
             )
             OR EXISTS(
               SELECT 1 FROM task_projections task
               WHERE task.workspace_id=m.workspace_id AND task.mission_id=m.mission_id
                 AND task.status='blocked'
             )
             OR EXISTS(
               SELECT 1 FROM task_projections task
               WHERE task.workspace_id=m.workspace_id AND task.mission_id=m.mission_id
                 AND task.status='failed'
             )
           )) attention_missions,
          (SELECT count(*)::int FROM approval_projections
           WHERE workspace_id=$1 AND status='pending') pending_approvals`,
        [identity.workspaceId],
      ),
      database.query<MissionNavigationRow>(
        `SELECT
          m.mission_id,m.name,m.status,m.priority,m.risk_level,m.updated_at,
          (SELECT count(*)::int FROM approval_projections approval
           WHERE approval.workspace_id=m.workspace_id AND approval.mission_id=m.mission_id
             AND approval.status='pending') pending_approvals,
          (SELECT count(*)::int FROM task_projections task
           WHERE task.workspace_id=m.workspace_id AND task.mission_id=m.mission_id
             AND task.status='blocked') blocked_tasks,
          (SELECT count(*)::int FROM task_projections task
           WHERE task.workspace_id=m.workspace_id AND task.mission_id=m.mission_id
             AND task.status='failed') failed_tasks
         FROM mission_projections m
         WHERE m.workspace_id=$1
         ORDER BY
           CASE
             WHEN EXISTS(
               SELECT 1 FROM approval_projections approval
               WHERE approval.workspace_id=m.workspace_id AND approval.mission_id=m.mission_id
                 AND approval.status='pending'
             ) THEN 0
             WHEN m.status IN('paused','failed') THEN 1
             WHEN EXISTS(
             SELECT 1 FROM task_projections task
             WHERE task.workspace_id=m.workspace_id AND task.mission_id=m.mission_id
               AND task.status='failed'
             ) THEN 2
             WHEN EXISTS(
               SELECT 1 FROM task_projections task
               WHERE task.workspace_id=m.workspace_id AND task.mission_id=m.mission_id
               AND task.status='blocked'
             ) THEN 3
             WHEN m.status IN('draft','planned','running','paused') THEN 4
             ELSE 5
           END,
           m.updated_at DESC
         LIMIT 16`,
        [identity.workspaceId],
      ),
    ]);

    return NextResponse.json({
      activeMissions: Number(counts.rows[0]?.active_missions ?? 0),
      attentionMissions: Number(counts.rows[0]?.attention_missions ?? 0),
      pendingApprovals: Number(counts.rows[0]?.pending_approvals ?? 0),
      missions: missions.rows.map((mission) => ({
        missionId: mission.mission_id,
        name: mission.name,
        status: mission.status,
        priority: mission.priority,
        riskLevel: mission.risk_level,
        updatedAt: mission.updated_at,
        pendingApprovals: Number(mission.pending_approvals ?? 0),
        blockedTasks: Number(mission.blocked_tasks ?? 0),
        failedTasks: Number(mission.failed_tasks ?? 0),
      })),
    });
  } catch (error) {
    return apiErrorResponse(error, "mission_navigation_summary_failed");
  }
}
