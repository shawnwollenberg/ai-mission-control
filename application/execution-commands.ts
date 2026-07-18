import { randomUUID } from "node:crypto";
import {
  executionFact,
  rehydrateExecution,
  requestExecution,
  requestExecutionCancellation,
  transitionExecution,
  type ExecutionStatus,
} from "@/domain/execution";
import { ConcurrencyConflictError, NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { appendEvents, loadAggregateEvents, type ActorType, type NewDomainEvent } from "@/lib/postgres-event-store";
import { applyExecutionProjection } from "@/application/execution-projector";
import { getDispatchPolicy } from "@/application/registry";
import { getDatabasePool } from "@/lib/database";
import { enqueueJob } from "@/lib/job-store";
import { handleTaskTransition } from "@/application/task-commands";
import { stableUuid } from "@/lib/stable-id";
export type ExecutionActor = { workspaceId: string; id: string; type: ActorType };
type DispatchTaskRow = { mission_id: string; status: string; current_attempt: number; timeout_seconds: number | null };
async function append(
  actor: ExecutionActor,
  commandId: string,
  executionId: string,
  event: NewDomainEvent,
  commandType: string,
  expected?: number,
) {
  const existing = await loadAggregateEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
  });
  const state = rehydrateExecution(existing);
  if (!state) throw new NotFoundError("Execution");
  if (expected !== undefined && expected !== state.version)
    throw new ConcurrencyConflictError({ expectedVersion: expected, actualVersion: state.version });
  const result = await appendEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
    missionId: state.missionId,
    expectedVersion: state.version,
    commandId,
    commandType,
    correlationId: state.missionId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: actor.type, id: actor.id },
    events: [event],
    applyProjections: applyExecutionProjection,
  });
  return {
    executionId,
    events: result.events,
    state: rehydrateExecution([...existing, ...result.events])!,
    duplicateCommand: result.duplicateCommand,
  };
}
export async function handleRequestExecution(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId?: string;
  taskId: string;
  agentId: string;
  repositoryId: string;
  timeoutSeconds?: number;
}) {
  const policy = await getDispatchPolicy(input.actor.workspaceId, input.agentId, input.repositoryId);
  if (policy.adapter_type !== "codex") throw new ValidationFailedError("This command requires a Codex agent");
  if (!policy.read_allowed || !policy.write_allowed)
    throw new ValidationFailedError("Repository does not allow the required access");
  const task = (
    await getDatabasePool().query<DispatchTaskRow>(
      "SELECT mission_id,status,current_attempt,timeout_seconds FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
      [input.actor.workspaceId, input.taskId],
    )
  ).rows[0];
  if (!task) throw new NotFoundError("Task");
  if (task.status !== "ready") throw new ValidationFailedError("Task must be ready for execution");
  const executionId = input.executionId ?? randomUUID();
  const attempt = task.current_attempt + 1;
  const timeoutSeconds = input.timeoutSeconds ?? task.timeout_seconds ?? 3600;
  const event = requestExecution({
    missionId: task.mission_id,
    taskId: input.taskId,
    agentId: input.agentId,
    repositoryId: input.repositoryId,
    attempt,
    adapterType: "codex",
    timeoutSeconds,
    idempotencyKey: input.commandId,
  });
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
    missionId: task.mission_id,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RequestExecution",
    correlationId: task.mission_id,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [event],
    applyProjections: applyExecutionProjection,
  });
  await handleTaskTransition({
    actor: input.actor,
    commandId: stableUuid(`execution-assignment:${executionId}`),
    taskId: input.taskId,
    target: "assigned",
    details: { assignedExecutor: input.agentId },
  });
  await enqueueJob({
    workspaceId: input.actor.workspaceId,
    jobType: "execute_codex",
    payload: { executionId },
    idempotencyKey: `execute:${executionId}`,
    correlationId: task.mission_id,
    maxAttempts: 3,
  });
  return { executionId, events: result.events, duplicateCommand: result.duplicateCommand };
}
export async function handleExecutionTransition(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
  target: ExecutionStatus;
  details?: Record<string, unknown>;
  expectedVersion?: number;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events);
  if (!state) throw new NotFoundError("Execution");
  const event = transitionExecution(state, input.target, input.details);
  if (!event) return { executionId: input.executionId, events: [], state, duplicateCommand: false };
  return append(
    input.actor,
    input.commandId,
    input.executionId,
    event,
    `Execution:${state.status}->${input.target}`,
    input.expectedVersion ?? state.version,
  );
}
export async function handleExecutionFact(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
  type: "execution.progress_reported" | "execution.command_completed" | "execution.artifact_produced";
  payload: Record<string, unknown>;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events);
  if (!state) throw new NotFoundError("Execution");
  return append(
    input.actor,
    input.commandId,
    input.executionId,
    executionFact(state, input.type, input.payload),
    input.type,
    state.version,
  );
}
export async function handleExecutionCancellation(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events);
  if (!state) throw new NotFoundError("Execution");
  const event = requestExecutionCancellation(state);
  if (!event) return { executionId: input.executionId, events: [], state, duplicateCommand: false };
  return append(input.actor, input.commandId, input.executionId, event, "RequestExecutionCancellation", state.version);
}
