import { InvalidTransitionError, ValidationFailedError } from "@/lib/application-errors";
import type { DomainEvent, NewDomainEvent } from "@/lib/postgres-event-store";

export type TaskStatus =
  | "pending"
  | "blocked"
  | "ready"
  | "assigned"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskState = {
  id: string;
  missionId: string;
  version: number;
  status: TaskStatus;
  currentAttempt: number;
  maximumAttempts: number;
  assignedExecutor?: string;
};

export type CreateTaskInput = {
  missionId: string;
  name: string;
  instructions: string;
  expectedOutput?: string;
  priority: "high" | "normal" | "low";
  riskLevel: "unknown" | "low" | "moderate" | "high";
  requiredCapabilities?: string[];
  maximumAttempts?: number;
  timeoutSeconds?: number;
  approvalPolicy?: Record<string, unknown>;
  verificationRequirements?: string[];
};

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["blocked", "ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  ready: ["assigned", "cancelled"],
  assigned: ["running", "ready", "failed", "cancelled"],
  running: ["waiting_for_approval", "paused", "verifying", "failed", "cancelled"],
  waiting_for_approval: ["running", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  verifying: ["completed", "failed", "running", "cancelled"],
  completed: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};

export function createTaskEvent(input: CreateTaskInput): NewDomainEvent {
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  if (!name || !instructions) throw new ValidationFailedError("Task name and instructions are required");
  const maximumAttempts = input.maximumAttempts ?? 1;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1)
    throw new ValidationFailedError("Maximum attempts must be positive");
  return {
    eventType: "task.created",
    eventSchemaVersion: 1,
    payload: {
      missionId: input.missionId,
      name,
      instructions,
      expectedOutput: input.expectedOutput?.trim() || null,
      priority: input.priority,
      riskLevel: input.riskLevel,
      requiredCapabilities: input.requiredCapabilities ?? [],
      maximumAttempts,
      timeoutSeconds: input.timeoutSeconds ?? null,
      approvalPolicy: input.approvalPolicy ?? {},
      verificationRequirements: input.verificationRequirements ?? [],
      status: "pending",
      currentAttempt: 0,
    },
  };
}

export function rehydrateTask(events: DomainEvent[]): TaskState | undefined {
  let state: TaskState | undefined;
  for (const event of events) {
    if (event.eventType === "task.created")
      state = {
        id: event.aggregateId,
        missionId: String(event.payload.missionId),
        version: event.aggregateVersion,
        status: "pending",
        currentAttempt: 0,
        maximumAttempts: Number(event.payload.maximumAttempts ?? 1),
      };
    if (!state) continue;
    if (typeof event.payload.status === "string") state.status = event.payload.status as TaskStatus;
    if (typeof event.payload.currentAttempt === "number") state.currentAttempt = event.payload.currentAttempt;
    if (typeof event.payload.assignedExecutor === "string") state.assignedExecutor = event.payload.assignedExecutor;
    state.version = event.aggregateVersion;
  }
  return state;
}

export function transitionTask(
  state: TaskState,
  target: TaskStatus,
  extra: Record<string, unknown> = {},
): NewDomainEvent | undefined {
  if (state.status === target) return undefined;
  if (state.status === "failed" && target === "ready" && state.currentAttempt >= state.maximumAttempts)
    throw new ValidationFailedError("Task has exhausted its maximum attempts");
  if (!transitions[state.status].includes(target)) throw new InvalidTransitionError("Task", state.status, target);
  const names: Partial<Record<TaskStatus, string>> = {
    blocked: "task.became_blocked",
    ready: state.status === "failed" ? "task.retry_requested" : "task.became_ready",
    assigned: "task.assigned",
    running: state.status === "paused" || state.status === "waiting_for_approval" ? "task.resumed" : "task.started",
    waiting_for_approval: "task.approval_requested",
    paused: "task.paused",
    verifying: "task.verification_started",
    completed: "task.completed",
    failed: "task.failed",
    cancelled: "task.cancelled",
  };
  return { eventType: names[target]!, eventSchemaVersion: 1, payload: { ...extra, status: target } };
}

export function progressTask(state: TaskState, summary: string, percent?: number): NewDomainEvent {
  if (state.status !== "running") throw new InvalidTransitionError("Task", state.status, "progress");
  if (!summary.trim()) throw new ValidationFailedError("Progress summary is required");
  return {
    eventType: "task.progress_reported",
    eventSchemaVersion: 1,
    payload: { status: "running", summary: summary.trim(), percent: percent ?? null },
  };
}
