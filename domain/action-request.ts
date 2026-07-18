import { InvalidTransitionError, ValidationFailedError } from "@/lib/application-errors";
import type { DomainEvent, NewDomainEvent } from "@/lib/postgres-event-store";
import type { ActionType, PolicyDecision } from "@/policy/policy-engine";

export type ActionStatus =
  | "requested"
  | "evaluating"
  | "denied"
  | "waiting_for_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";
export type ActionState = {
  id: string;
  missionId: string;
  status: ActionStatus;
  version: number;
  actionType: ActionType;
  actionHash: string;
  approvalId?: string;
};
const transitions: Record<ActionStatus, ActionStatus[]> = {
  requested: ["evaluating", "cancelled"],
  evaluating: ["denied", "waiting_for_approval", "approved"],
  denied: [],
  waiting_for_approval: ["approved", "denied", "expired", "cancelled"],
  approved: ["executing", "denied", "expired", "cancelled"],
  executing: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  expired: [],
  cancelled: [],
};
export function requestAction(input: {
  actionType: ActionType;
  targetResource: string;
  parametersSummary: Record<string, unknown>;
  actionHash: string;
  requestedBy: string;
  idempotencyKey: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  repositoryId?: string;
}): NewDomainEvent {
  if (!input.targetResource || !input.actionHash)
    throw new ValidationFailedError("Action target and hash are required");
  return { eventType: "action.requested", eventSchemaVersion: 1, payload: { ...input, status: "requested" } };
}
export function transitionAction(
  state: ActionState,
  target: ActionStatus,
  details: Record<string, unknown> = {},
): NewDomainEvent {
  if (!transitions[state.status].includes(target))
    throw new InvalidTransitionError("ActionRequest", state.status, target);
  const eventType: Record<ActionStatus, string> = {
    requested: "action.requested",
    evaluating: "policy.evaluation_started",
    denied: "action.denied",
    waiting_for_approval: "action.approval_requested",
    approved: "action.approved",
    executing: "action.execution_started",
    succeeded: "action.execution_succeeded",
    failed: "action.execution_failed",
    expired: "action.expired",
    cancelled: "action.cancelled",
  };
  return { eventType: eventType[target], eventSchemaVersion: 1, payload: { ...details, status: target } };
}
export function policyEvaluated(state: ActionState, decision: PolicyDecision): NewDomainEvent {
  if (state.status !== "evaluating")
    throw new InvalidTransitionError("ActionRequest", state.status, "policy_evaluated");
  return { eventType: "policy.evaluated", eventSchemaVersion: 1, payload: { ...decision } };
}
export function rehydrateAction(events: DomainEvent[]): ActionState | undefined {
  if (!events.length) return undefined;
  const first = events[0];
  let status = "requested" as ActionStatus;
  let approvalId: string | undefined;
  for (const event of events) {
    if (event.payload.status) status = event.payload.status as ActionStatus;
    if (event.payload.approvalId) approvalId = String(event.payload.approvalId);
  }
  return {
    id: first.aggregateId,
    missionId: first.missionId!,
    status,
    version: events.at(-1)!.aggregateVersion,
    actionType: first.payload.actionType as ActionType,
    actionHash: String(first.payload.actionHash),
    ...(approvalId ? { approvalId } : {}),
  };
}
