import { InvalidTransitionError, ValidationFailedError } from "@/lib/application-errors";
import type { DomainEvent, NewDomainEvent } from "@/lib/postgres-event-store";

export type ExecutionStatus =
  | "requested"
  | "accepted"
  | "preparing"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "verifying"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";
export type ExecutionState = {
  id: string;
  version: number;
  status: ExecutionStatus;
  missionId: string;
  taskId: string;
  agentId: string;
  attempt: number;
  adapterType: "mock" | "codex" | "remote_http";
  cancellationRequested: boolean;
};
const transitions: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  requested: ["accepted", "cancelled", "failed"],
  accepted: ["preparing", "cancelled", "failed"],
  preparing: ["running", "cancelled", "failed", "timed_out"],
  running: ["waiting_for_approval", "paused", "verifying", "failed", "timed_out", "cancelled"],
  waiting_for_approval: ["running", "paused", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed", "timed_out"],
  verifying: ["succeeded", "failed", "timed_out", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};
const names: Partial<Record<ExecutionStatus, string>> = {
  accepted: "execution.accepted",
  preparing: "execution.preparation_started",
  running: "execution.started",
  waiting_for_approval: "execution.approval_requested",
  paused: "execution.paused",
  verifying: "execution.verification_started",
  succeeded: "execution.succeeded",
  failed: "execution.failed",
  timed_out: "execution.timed_out",
  cancelled: "execution.cancelled",
};
export function requestExecution(input: {
  missionId: string;
  taskId: string;
  agentId: string;
  repositoryId?: string;
  attempt: number;
  adapterType: "mock" | "codex" | "remote_http";
  timeoutSeconds: number;
  idempotencyKey: string;
}): NewDomainEvent {
  if (input.attempt < 1 || input.timeoutSeconds < 1)
    throw new ValidationFailedError("Execution attempt and timeout must be positive");
  return { eventType: "execution.requested", eventSchemaVersion: 1, payload: { ...input, status: "requested" } };
}
export function rehydrateExecution(events: DomainEvent[]): ExecutionState | undefined {
  let state: ExecutionState | undefined;
  for (const e of events) {
    if (e.eventType === "execution.requested")
      state = {
        id: e.aggregateId,
        version: e.aggregateVersion,
        status: "requested",
        missionId: String(e.missionId),
        taskId: String(e.payload.taskId),
        agentId: String(e.payload.agentId),
        attempt: Number(e.payload.attempt),
        adapterType: e.payload.adapterType as "mock" | "codex" | "remote_http",
        cancellationRequested: false,
      };
    if (!state) continue;
    if (typeof e.payload.status === "string") state.status = e.payload.status as ExecutionStatus;
    if (e.eventType === "execution.cancellation_requested") state.cancellationRequested = true;
    state.version = e.aggregateVersion;
  }
  return state;
}
export function transitionExecution(
  state: ExecutionState,
  target: ExecutionStatus,
  details: Record<string, unknown> = {},
): NewDomainEvent | undefined {
  if (state.status === target) return;
  if (!transitions[state.status].includes(target)) throw new InvalidTransitionError("Execution", state.status, target);
  return { eventType: names[target]!, eventSchemaVersion: 1, payload: { ...details, status: target } };
}
export function executionFact(
  state: ExecutionState,
  type:
    | "execution.progress_reported"
    | "execution.command_completed"
    | "execution.artifact_produced"
    | "execution.heartbeat_received",
  payload: Record<string, unknown>,
): NewDomainEvent {
  if (!["preparing", "running", "waiting_for_approval", "verifying"].includes(state.status))
    throw new InvalidTransitionError("Execution", state.status, type);
  return { eventType: type, eventSchemaVersion: 1, payload: { ...payload, status: state.status } };
}
export function requestExecutionCancellation(state: ExecutionState): NewDomainEvent | undefined {
  if (state.cancellationRequested) return;
  if (["succeeded", "failed", "timed_out", "cancelled"].includes(state.status))
    throw new InvalidTransitionError("Execution", state.status, "cancellation_requested");
  return { eventType: "execution.cancellation_requested", eventSchemaVersion: 1, payload: { status: state.status } };
}
