import { getDatabasePool } from "@/lib/database";
import { stableUuid } from "@/lib/stable-id";
import { handleMissionTransition, type CommandActor } from "@/application/mission-commands";
import { handleTaskTransition, type TaskCommandActor } from "@/application/task-commands";
import { changeRecommendationStatus } from "@/application/recommendation-commands";

const systemActor = (workspaceId: string): TaskCommandActor => ({
  workspaceId,
  id: "mission-coordinator",
  type: "system",
});

export async function activateMissionTasks(workspaceId: string, missionId: string, causation: string) {
  const tasks = await getDatabasePool().query<{ task_id: string; status: string; unmet: string }>(
    `SELECT t.task_id,t.status,
    count(d.depends_on_task_id) FILTER (WHERE upstream.status<>'completed')::text unmet
    FROM task_projections t LEFT JOIN task_dependencies d ON d.workspace_id=t.workspace_id AND d.task_id=t.task_id
    LEFT JOIN task_projections upstream ON upstream.workspace_id=d.workspace_id AND upstream.task_id=d.depends_on_task_id
    WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.status IN ('pending','blocked') GROUP BY t.task_id,t.status`,
    [workspaceId, missionId],
  );
  for (const task of tasks.rows)
    await handleTaskTransition({
      actor: systemActor(workspaceId),
      commandId: stableUuid(`coordinate:${causation}:${task.task_id}`),
      taskId: task.task_id,
      target: Number(task.unmet) === 0 ? "ready" : "blocked",
      details: { reason: Number(task.unmet) === 0 ? "dependencies_satisfied" : "waiting_for_dependencies" },
    });
}

export async function coordinateAfterTask(workspaceId: string, missionId: string, taskId: string, eventType: string) {
  if (eventType === "task.completed") {
    const dependents = await getDatabasePool().query<{ task_id: string; unmet: string }>(
      `SELECT d.task_id,count(*) FILTER(WHERE u.status<>'completed')::text unmet FROM task_dependencies d JOIN task_projections u ON u.workspace_id=d.workspace_id AND u.task_id=d.depends_on_task_id WHERE d.workspace_id=$1 AND d.depends_on_task_id=$2 GROUP BY d.task_id`,
      [workspaceId, taskId],
    );
    for (const row of dependents.rows)
      if (Number(row.unmet) === 0)
        await handleTaskTransition({
          actor: systemActor(workspaceId),
          commandId: stableUuid(`dependency-complete:${taskId}:${row.task_id}`),
          taskId: row.task_id,
          target: "ready",
          details: { reason: "dependencies_satisfied" },
        });
  }
  const mission = await getDatabasePool().query<{ status: string; total: string; completed: string; failed: string }>(
    `SELECT m.status,count(t.*)::text total,count(t.*) FILTER(WHERE t.status='completed')::text completed,count(t.*) FILTER(WHERE t.status='failed')::text failed FROM mission_projections m LEFT JOIN task_projections t ON t.workspace_id=m.workspace_id AND t.mission_id=m.mission_id WHERE m.workspace_id=$1 AND m.mission_id=$2 GROUP BY m.status`,
    [workspaceId, missionId],
  );
  const row = mission.rows[0];
  if (!row || row.status !== "running") return;
  const actor: CommandActor = { workspaceId, userId: "mission-coordinator", role: "owner" };
  if (Number(row.failed) > 0)
    await handleMissionTransition({
      actor,
      commandId: stableUuid(`mission-failed:${missionId}:${taskId}`),
      missionId,
      target: "failed",
    });
  else if (Number(row.total) > 0 && Number(row.total) === Number(row.completed)) {
    await handleMissionTransition({
      actor,
      commandId: stableUuid(`mission-complete:${missionId}`),
      missionId,
      target: "completed",
    });
    const recommendations = await getDatabasePool().query<{ recommendation_id: string }>(
      "SELECT recommendation_id FROM recommendation_projections WHERE workspace_id=$1 AND linked_mission_id=$2 AND status='in_progress'",
      [workspaceId, missionId],
    );
    for (const recommendation of recommendations.rows)
      await changeRecommendationStatus({
        actor: { workspaceId, id: "mission-coordinator", type: "system" },
        commandId: stableUuid(`recommendation-complete:${recommendation.recommendation_id}:${missionId}`),
        recommendationId: recommendation.recommendation_id,
        target: "completed",
        reason: "Linked change mission completed",
        linkedMissionId: missionId,
      });
  }
}

export async function cancelMissionTasks(workspaceId: string, missionId: string, causation: string) {
  const tasks = await getDatabasePool().query<{ task_id: string }>(
    "SELECT task_id FROM task_projections WHERE workspace_id=$1 AND mission_id=$2 AND status NOT IN ('completed','failed','cancelled')",
    [workspaceId, missionId],
  );
  for (const task of tasks.rows)
    await handleTaskTransition({
      actor: systemActor(workspaceId),
      commandId: stableUuid(`cancel:${causation}:${task.task_id}`),
      taskId: task.task_id,
      target: "cancelled",
      details: { reason: "mission_cancelled" },
    });
}
