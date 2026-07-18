import { randomUUID } from "node:crypto";
import {
  createTaskEvent,
  progressTask,
  rehydrateTask,
  transitionTask,
  type CreateTaskInput,
  type TaskStatus,
} from "@/domain/task";
import { ConcurrencyConflictError, NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents, type ActorType, type NewDomainEvent } from "@/lib/postgres-event-store";
import { applyTaskProjection } from "@/application/task-projector";

export type TaskCommandActor = { workspaceId: string; id: string; type: ActorType };
export type TaskCommandResult = {
  taskId: string;
  aggregateVersion: number;
  status: TaskStatus;
  eventIds: string[];
  duplicateCommand: boolean;
  alreadyInState: boolean;
};

async function missionStatus(workspaceId: string, missionId: string) {
  const result = await getDatabasePool().query<{ status: string }>(
    "SELECT status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
    [workspaceId, missionId],
  );
  if (!result.rowCount) throw new NotFoundError("Mission");
  return result.rows[0].status;
}

export async function handleCreateTask(input: {
  actor: TaskCommandActor;
  commandId: string;
  taskId?: string;
  task: CreateTaskInput;
}) {
  const status = await missionStatus(input.actor.workspaceId, input.task.missionId);
  if (["completed", "failed", "cancelled"].includes(status))
    throw new ValidationFailedError("Terminal missions cannot receive tasks");
  const taskId = input.taskId ?? randomUUID();
  const event = createTaskEvent(input.task);
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "task",
    aggregateId: taskId,
    missionId: input.task.missionId,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "CreateTask",
    correlationId: input.task.missionId,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [event],
    outbox: [
      {
        eventIndex: 0,
        topic: "task.events",
        idempotencyKey: `${input.commandId}:task.created`,
        payload: { taskId, missionId: input.task.missionId, eventType: event.eventType },
      },
    ],
    applyProjections: applyTaskProjection,
  });
  return {
    taskId: result.events[0]?.aggregateId ?? taskId,
    aggregateVersion: result.events.at(-1)?.aggregateVersion ?? 1,
    status: "pending" as const,
    eventIds: result.events.map((e) => e.eventId),
    duplicateCommand: result.duplicateCommand,
    alreadyInState: false,
  };
}

export async function handleAddTaskDependency(input: {
  actor: TaskCommandActor;
  commandId: string;
  taskId: string;
  dependsOnTaskId: string;
}) {
  if (input.taskId === input.dependsOnTaskId) throw new ValidationFailedError("A task cannot depend on itself");
  const rows = await getDatabasePool().query<{ task_id: string; mission_id: string }>(
    "SELECT task_id,mission_id FROM task_projections WHERE workspace_id=$1 AND task_id=ANY($2::uuid[])",
    [input.actor.workspaceId, [input.taskId, input.dependsOnTaskId]],
  );
  if (rows.rowCount !== 2) throw new NotFoundError("Task");
  if (rows.rows[0].mission_id !== rows.rows[1].mission_id)
    throw new ValidationFailedError("Dependencies must belong to the same mission");
  const duplicate = await getDatabasePool().query(
    "SELECT 1 FROM task_dependencies WHERE workspace_id=$1 AND task_id=$2 AND depends_on_task_id=$3",
    [input.actor.workspaceId, input.taskId, input.dependsOnTaskId],
  );
  if (duplicate.rowCount) {
    const events = await loadAggregateEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "task",
      aggregateId: input.taskId,
    });
    const state = rehydrateTask(events)!;
    return {
      taskId: input.taskId,
      aggregateVersion: state.version,
      status: state.status,
      eventIds: [],
      duplicateCommand: true,
      alreadyInState: true,
    };
  }
  const cycle = await getDatabasePool().query(
    `WITH RECURSIVE chain(id) AS (SELECT depends_on_task_id FROM task_dependencies WHERE workspace_id=$1 AND task_id=$2 UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id=c.id WHERE d.workspace_id=$1) SELECT 1 FROM chain WHERE id=$3 LIMIT 1`,
    [input.actor.workspaceId, input.dependsOnTaskId, input.taskId],
  );
  if (cycle.rowCount) throw new ValidationFailedError("Dependency would create a cycle");
  return appendTaskEvent(input.actor, input.commandId, input.taskId, "AddTaskDependency", {
    eventType: "task.dependency_added",
    eventSchemaVersion: 1,
    payload: { dependsOnTaskId: input.dependsOnTaskId },
  });
}

export async function appendTaskEvent(
  actor: TaskCommandActor,
  commandId: string,
  taskId: string,
  commandType: string,
  event: NewDomainEvent,
  expectedVersion?: number,
): Promise<TaskCommandResult> {
  const existing = await loadAggregateEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "task",
    aggregateId: taskId,
  });
  const state = rehydrateTask(existing);
  if (!state) throw new NotFoundError("Task");
  if (expectedVersion !== undefined && expectedVersion !== state.version)
    throw new ConcurrencyConflictError({ expectedVersion, actualVersion: state.version });
  const result = await appendEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "task",
    aggregateId: taskId,
    missionId: state.missionId,
    expectedVersion: state.version,
    commandId,
    commandType,
    correlationId: state.missionId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: actor.type, id: actor.id },
    events: [event],
    outbox: [
      {
        eventIndex: 0,
        topic: event.eventType === "task.became_ready" ? "task.ready" : "task.events",
        idempotencyKey: `${commandId}:${event.eventType}`,
        payload: { taskId, missionId: state.missionId, eventType: event.eventType },
      },
    ],
    applyProjections: applyTaskProjection,
  });
  return {
    taskId,
    aggregateVersion: result.events.at(-1)?.aggregateVersion ?? state.version,
    status: (event.payload.status as TaskStatus) ?? state.status,
    eventIds: result.events.map((e) => e.eventId),
    duplicateCommand: result.duplicateCommand,
    alreadyInState: false,
  };
}

export async function handleTaskTransition(input: {
  actor: TaskCommandActor;
  commandId: string;
  taskId: string;
  target: TaskStatus;
  expectedVersion?: number;
  details?: Record<string, unknown>;
}) {
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "task",
    aggregateId: input.taskId,
  });
  const state = rehydrateTask(existing);
  if (!state) throw new NotFoundError("Task");
  if (input.expectedVersion !== undefined && input.expectedVersion !== state.version)
    throw new ConcurrencyConflictError({ expectedVersion: input.expectedVersion, actualVersion: state.version });
  const mission = await missionStatus(input.actor.workspaceId, state.missionId);
  if (["completed", "failed", "cancelled"].includes(mission) && input.target !== "cancelled")
    throw new ValidationFailedError("Terminal mission rejects task transition");
  const details = { ...(input.details ?? {}) };
  if (input.target === "assigned") details.assignedExecutor = details.assignedExecutor ?? "simulated";
  if (input.target === "running" && state.status === "assigned") details.currentAttempt = state.currentAttempt + 1;
  const event = transitionTask(state, input.target, details);
  if (!event)
    return {
      taskId: input.taskId,
      aggregateVersion: state.version,
      status: state.status,
      eventIds: [],
      duplicateCommand: false,
      alreadyInState: true,
    };
  return appendTaskEvent(
    input.actor,
    input.commandId,
    input.taskId,
    `Task:${state.status}->${input.target}`,
    event,
    state.version,
  );
}

export async function handleReportTaskProgress(input: {
  actor: TaskCommandActor;
  commandId: string;
  taskId: string;
  summary: string;
  percent?: number;
}) {
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "task",
    aggregateId: input.taskId,
  });
  const state = rehydrateTask(existing);
  if (!state) throw new NotFoundError("Task");
  return appendTaskEvent(
    input.actor,
    input.commandId,
    input.taskId,
    "ReportTaskProgress",
    progressTask(state, input.summary, input.percent),
    state.version,
  );
}

export async function handleRetryTask(input: { actor: TaskCommandActor; commandId: string; taskId: string }) {
  return handleTaskTransition({ ...input, target: "ready" });
}

export async function handleReassignTask(input: {
  actor: TaskCommandActor;
  commandId: string;
  taskId: string;
  assignedExecutor: string;
}) {
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "task",
    aggregateId: input.taskId,
  });
  const state = rehydrateTask(existing);
  if (!state) throw new NotFoundError("Task");
  if (["completed", "failed", "cancelled"].includes(state.status))
    throw new ValidationFailedError("Terminal tasks cannot be reassigned");
  return appendTaskEvent(
    input.actor,
    input.commandId,
    input.taskId,
    "ReassignTask",
    {
      eventType: "task.reassigned",
      eventSchemaVersion: 1,
      payload: { status: "assigned", assignedExecutor: input.assignedExecutor },
    },
    state.version,
  );
}
