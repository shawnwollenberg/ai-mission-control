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
import { evaluateAgentEligibility, type RequiredResource } from "@/application/agent-eligibility";
import { evaluateExecutionBudget, recordUsage } from "@/application/usage-budget";
import { assertCapabilityEnabled } from "@/application/emergency-controls";
import { createPullAssignment, completePullAssignment } from "@/application/pull-assignments";
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
  if (
    ["execution.succeeded", "execution.failed", "execution.timed_out", "execution.cancelled"].includes(event.eventType)
  ) {
    const execution = (
      await getDatabasePool().query(
        "SELECT mission_id,task_id,agent_id,adapter_type,started_at FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
        [actor.workspaceId, executionId],
      )
    ).rows[0];
    if (execution)
      await recordUsage({
        workspaceId: actor.workspaceId,
        commandId: stableUuid(`execution-operational-usage:${executionId}`),
        actorId: "usage-recorder",
        missionId: execution.mission_id,
        taskId: execution.task_id,
        executionId,
        agentId: execution.agent_id,
        provider: execution.adapter_type === "codex" ? "openai" : "remote_agent",
        runtime: execution.adapter_type,
        metricType: "duration",
        quantity: execution.started_at ? Math.max(0, Date.now() - new Date(execution.started_at).getTime()) : undefined,
        unit: "milliseconds",
        costConfidence: "unknown",
        source: "mission_control_execution",
      });
    await completePullAssignment(actor.workspaceId, executionId);
  }
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
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_new_executions");
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_codex_assignments");
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
  await evaluateExecutionBudget({ workspaceId: input.actor.workspaceId, missionId: task.mission_id, executionId });
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
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_new_executions");
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_remote_assignments");
  const task = (
    await getDatabasePool().query<
      DispatchTaskRow & {
        name: string;
        instructions: string;
        expected_output: string | null;
        required_capabilities: string[];
        domain: string;
        required_resources: RequiredResource[];
        approval_requirements: { missionType?: string; writeApprovalRequired?: boolean };
        verification_requirements: string[];
      }
    >(
      `SELECT t.mission_id,t.status,t.current_attempt,t.timeout_seconds,t.name,t.instructions,t.expected_output,t.required_capabilities,t.required_resources,t.approval_requirements,t.verification_requirements,m.domain FROM task_projections t JOIN mission_projections m ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id WHERE t.workspace_id=$1 AND t.task_id=$2`,
      [input.actor.workspaceId, input.taskId],
    )
  ).rows[0];
  if (!task) throw new NotFoundError("Task");
  if (task.status !== "ready") throw new ValidationFailedError("Task must be ready for execution");
  const eligibility = await evaluateAgentEligibility({
    workspaceId: input.actor.workspaceId,
    agentId: input.agentId,
    domain: task.domain,
    requiredCapabilities: task.required_capabilities,
    requiredResources: task.required_resources,
    protocolVersion: "1.0",
  });
  if (!eligibility.eligible)
    throw new ValidationFailedError("Remote agent is ineligible", { reasons: eligibility.reasons });
  const executionId = input.executionId ?? randomUUID(),
    attempt = task.current_attempt + 1,
    timeoutSeconds = input.timeoutSeconds ?? task.timeout_seconds ?? 3600,
    messageId = randomUUID();
  const deliveryMode = (
    await getDatabasePool().query<{ delivery_mode: "push" | "pull" }>(
      "SELECT delivery_mode FROM agents WHERE workspace_id=$1 AND agent_id=$2",
      [input.actor.workspaceId, input.agentId],
    )
  ).rows[0]?.delivery_mode;
  if (!deliveryMode) throw new NotFoundError("Agent");
  await evaluateExecutionBudget({ workspaceId: input.actor.workspaceId, missionId: task.mission_id, executionId });
  const event = requestExecution({
    missionId: task.mission_id,
    taskId: input.taskId,
    agentId: input.agentId,
    repositoryId: task.required_resources.find((resource) => resource.resourceType === "repository")?.resourceId,
    attempt,
    adapterType: "remote_http",
    timeoutSeconds,
    idempotencyKey: input.commandId,
  });
  const repositoryChange = task.approval_requirements?.missionType === "change";
  const taskEnvelope = {
    missionType: repositoryChange ? "repository_change" : "repository_analysis",
    taskObjective: task.name,
    instructions: task.instructions,
    expectedOutput: task.expected_output,
    allowedCapabilities: task.required_capabilities,
    allowedResources: task.required_resources,
    prohibitedActions: [
      ...(!repositoryChange ? ["file.modify", "package.install", "git.commit"] : []),
      "git.push",
      "pull_request.create",
      "repository.merge",
      "deployment.execute",
      "production.remediate",
      "secret.access",
      "transaction.sign",
      "transaction.submit",
    ],
    constraints: repositoryChange
      ? ["write_requires_approval", "isolated_worktree", "local_commit_only", "no_network_side_effects"]
      : ["read_only_repository_analysis"],
    validationCommands: repositoryChange
      ? task.verification_requirements.map((command) => command.split(/\s+/))
      : [],
    timeoutSeconds,
    heartbeatIntervalSeconds: 30,
    artifactRequirements: repositoryChange
      ? ["implementation_plan", "git_patch", "validation_results", "change_summary"]
      : ["repository_analysis"],
  };
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
    outbox:
      deliveryMode === "push"
        ? [
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
                taskEnvelope,
              },
            },
          ]
        : [],
    applyProjections: async (client, events) => {
      await applyExecutionProjection(client, events);
      if (deliveryMode === "pull")
        await createPullAssignment(client, {
          workspaceId: input.actor.workspaceId,
          executionId,
          missionId: task.mission_id,
          taskId: input.taskId,
          agentId: input.agentId,
          attempt,
          payload: taskEnvelope,
        });
    },
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
  type:
    | "execution.progress_reported"
    | "execution.command_completed"
    | "execution.artifact_produced"
    | "execution.remote_approval_denied"
    | "execution.approval_decision_acknowledged";
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
