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
export async function handleRequestRemoteExecution(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId?: string;
  taskId: string;
  agentId: string;
  timeoutSeconds?: number;
}) {
  const task = (
    await getDatabasePool().query<
      DispatchTaskRow & {
        name: string;
        instructions: string;
        expected_output: string | null;
        required_capabilities: string[];
        domain: string;
      }
    >(
      `SELECT t.mission_id,t.status,t.current_attempt,t.timeout_seconds,t.name,t.instructions,t.expected_output,t.required_capabilities,m.domain FROM task_projections t JOIN mission_projections m ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id WHERE t.workspace_id=$1 AND t.task_id=$2`,
      [input.actor.workspaceId, input.taskId],
    )
  ).rows[0];
  if (!task) throw new NotFoundError("Task");
  if (task.status !== "ready") throw new ValidationFailedError("Task must be ready for execution");
  const agent = (
    await getDatabasePool().query<{
      adapter_type: string;
      status: string;
      capabilities: string[];
      supported_domains: string[];
      protocol_versions: string[];
      concurrency_limit: number;
      current_executions: number;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT a.*,count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled'))::int current_executions FROM agents a LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id WHERE a.workspace_id=$1 AND a.agent_id=$2 GROUP BY a.workspace_id,a.agent_id`,
      [input.actor.workspaceId, input.agentId],
    )
  ).rows[0];
  if (!agent || agent.adapter_type !== "remote_http")
    throw new ValidationFailedError("A registered remote HTTP agent is required");
  if (agent.status !== "active" || !agent.last_heartbeat_at || Date.now() - agent.last_heartbeat_at.getTime() > 90_000)
    throw new ValidationFailedError("Remote agent is not active with a fresh heartbeat");
  if (
    !agent.supported_domains.includes(task.domain) ||
    task.required_capabilities.some((capability) => !agent.capabilities.includes(capability))
  )
    throw new ValidationFailedError("Remote agent is missing the task domain or required capabilities");
  if (!agent.protocol_versions.includes("1.0") || agent.current_executions >= agent.concurrency_limit)
    throw new ValidationFailedError("Remote agent is not eligible for another protocol 1.0 execution");
  const executionId = input.executionId ?? randomUUID(),
    attempt = task.current_attempt + 1,
    timeoutSeconds = input.timeoutSeconds ?? task.timeout_seconds ?? 3600,
    messageId = randomUUID();
  const event = requestExecution({
    missionId: task.mission_id,
    taskId: input.taskId,
    agentId: input.agentId,
    attempt,
    adapterType: "remote_http",
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
    commandType: "RequestRemoteExecution",
    correlationId: task.mission_id,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [event],
    outbox: [
      {
        eventIndex: 0,
        messageId,
        topic: "remote-agent.delivery",
        idempotencyKey: `remote-execution:${executionId}`,
        payload: {
          messageId,
          agentId: input.agentId,
          messageType: "ExecutionRequested",
          protocolVersion: "1.0",
          executionId,
          missionId: task.mission_id,
          taskId: input.taskId,
          attempt,
          taskEnvelope: {
            taskObjective: task.name,
            instructions: task.instructions,
            expectedOutput: task.expected_output,
            allowedCapabilities: task.required_capabilities,
            prohibitedActions: [
              "merge",
              "deploy",
              "production.remediate",
              "secret.access",
              "transaction.sign",
              "transaction.submit",
            ],
            timeoutSeconds,
            heartbeatIntervalSeconds: 30,
            artifactRequirements: ["structured-result"],
          },
        },
      },
    ],
    applyProjections: applyExecutionProjection,
  });
  await handleTaskTransition({
    actor: input.actor,
    commandId: stableUuid(`execution-assignment:${executionId}`),
    taskId: input.taskId,
    target: "assigned",
    details: { assignedExecutor: input.agentId },
  });
  return { executionId, messageId, events: result.events, duplicateCommand: result.duplicateCommand };
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
