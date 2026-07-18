import { getDatabasePool } from "@/lib/database";
import { enqueueJob, type Job } from "@/lib/job-store";
import { handleReportTaskProgress, handleTaskTransition } from "@/application/task-commands";
import { coordinateAfterTask } from "@/application/mission-coordinator";
import { stableUuid } from "@/lib/stable-id";
import { decideApproval, requestApproval } from "@/application/approval-commands";

const actor = (workspaceId: string) => ({ workspaceId, id: "simulated-executor", type: "scheduler" as const });
export async function queueReadyTasks(workspaceId: string, missionId: string) {
  const tasks = await getDatabasePool().query<{ task_id: string }>(
    "SELECT task_id FROM task_projections WHERE workspace_id=$1 AND mission_id=$2 AND status='ready'",
    [workspaceId, missionId],
  );
  for (const t of tasks.rows)
    await enqueueJob({
      workspaceId,
      jobType: "simulate_task",
      payload: { missionId, taskId: t.task_id },
      idempotencyKey: `simulate:${t.task_id}:attempt`,
      correlationId: missionId,
    });
}

export async function runSimulationJob(job: Job) {
  if (!job.workspaceId) throw new Error("Simulation job requires workspace");
  const missionId = String(job.payload.missionId),
    taskId = String(job.payload.taskId);
  const state = await getDatabasePool().query<{
    mission_status: string;
    status: string;
    approval_requirements: Record<string, unknown>;
    current_attempt: number;
  }>(
    `SELECT m.status mission_status,t.status,t.approval_requirements,t.current_attempt FROM task_projections t JOIN mission_projections m ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id WHERE t.workspace_id=$1 AND t.task_id=$2`,
    [job.workspaceId, taskId],
  );
  if (!state.rowCount) return;
  const row = state.rows[0];
  if (
    row.mission_status !== "running" ||
    ["completed", "failed", "cancelled", "waiting_for_approval"].includes(row.status)
  )
    return;
  const key = `simulation:${taskId}:${row.current_attempt + 1}`;
  if (row.status === "ready")
    await handleTaskTransition({
      actor: actor(job.workspaceId),
      commandId: stableUuid(`${key}:assign`),
      taskId,
      target: "assigned",
      details: { assignedExecutor: "simulated" },
    });
  const current = (
    await getDatabasePool().query<{ status: string }>(
      "SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
      [job.workspaceId, taskId],
    )
  ).rows[0]?.status;
  if (current === "assigned")
    await handleTaskTransition({
      actor: actor(job.workspaceId),
      commandId: stableUuid(`${key}:start`),
      taskId,
      target: "running",
    });
  await handleReportTaskProgress({
    actor: actor(job.workspaceId),
    commandId: stableUuid(`${key}:progress`),
    taskId,
    summary: "Deterministic simulated work completed",
    percent: 100,
  });
  const approval = Boolean(row.approval_requirements?.required);
  if (approval) {
    await handleTaskTransition({
      actor: actor(job.workspaceId),
      commandId: stableUuid(`${key}:approval`),
      taskId,
      target: "waiting_for_approval",
      details: { summary: "Human approval required before verification" },
    });
    await requestApproval({ workspaceId: job.workspaceId, missionId, taskId, key, actorId: "simulated-executor" });
    return;
  }
  await finish(job.workspaceId, missionId, taskId, key);
}
async function finish(workspaceId: string, missionId: string, taskId: string, key: string) {
  await handleTaskTransition({
    actor: actor(workspaceId),
    commandId: stableUuid(`${key}:verify`),
    taskId,
    target: "verifying",
  });
  await handleTaskTransition({
    actor: actor(workspaceId),
    commandId: stableUuid(`${key}:complete`),
    taskId,
    target: "completed",
    details: { summary: "Simulated verification passed" },
  });
  await coordinateAfterTask(workspaceId, missionId, taskId, "task.completed");
  await queueReadyTasks(workspaceId, missionId);
}
export async function resolveApproval(input: {
  workspaceId: string;
  approvalId: string;
  granted: boolean;
  decidedBy: string;
  reason: string;
}) {
  const decision = await decideApproval({
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    granted: input.granted,
    actorId: input.decidedBy,
    reason: input.reason,
  });
  if (!decision.applied) return false;
  const row = { task_id: String(decision.event.payload.taskId), mission_id: String(decision.event.missionId) };
  const key = `approval:${input.approvalId}`;
  if (input.granted) {
    await handleTaskTransition({
      actor: { workspaceId: input.workspaceId, id: input.decidedBy, type: "human" },
      commandId: stableUuid(`${key}:resume`),
      taskId: row.task_id,
      target: "running",
      details: { approvalId: input.approvalId },
    });
    await finish(input.workspaceId, row.mission_id, row.task_id, key);
  } else {
    await handleTaskTransition({
      actor: { workspaceId: input.workspaceId, id: input.decidedBy, type: "human" },
      commandId: stableUuid(`${key}:deny`),
      taskId: row.task_id,
      target: "failed",
      details: { reason: input.reason },
    });
    await coordinateAfterTask(input.workspaceId, row.mission_id, row.task_id, "task.failed");
  }
  return true;
}
