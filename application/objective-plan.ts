import { handleCreateTask } from "@/application/task-commands";
import { getDatabasePool } from "@/lib/database";
import { NotFoundError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";

export async function createObjectivePlan(workspaceId: string, userId: string, missionId: string) {
  const mission = (
    await getDatabasePool().query(
      "SELECT name,objective,priority,risk_level FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, missionId],
    )
  ).rows[0];
  if (!mission) throw new NotFoundError("Mission");
  const taskId = stableUuid(`${missionId}:objective-task`);
  await handleCreateTask({
    actor: { workspaceId, id: userId, type: "human" },
    commandId: stableUuid(`${missionId}:create-objective-task`),
    taskId,
    task: {
      missionId,
      name: mission.name,
      instructions: mission.objective,
      expectedOutput: "Evidence-backed mission result and final artifact",
      priority: mission.priority,
      riskLevel: mission.risk_level,
      maximumAttempts: 2,
      approvalPolicy: { required: false },
      verificationRequirements: ["Record evidence for the reported outcome"],
    },
  });
  return [taskId];
}
