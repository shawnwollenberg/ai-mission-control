import { InvalidTransitionError, ValidationFailedError } from "@/lib/application-errors";
import type { DomainEvent, NewDomainEvent } from "@/lib/postgres-event-store";

export type MissionStatus = "draft" | "planned" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type MissionState = {
  id: string;
  version: number;
  status: MissionStatus;
};

export type CreateMissionInput = {
  name: string;
  objective: string;
  description?: string;
  domain: string;
  priority: "high" | "normal" | "low";
  riskLevel: "unknown" | "low" | "moderate" | "high";
  requestedOutcome?: string;
  successCriteria?: string[];
  constraints?: string[];
  budgetLimits?: Record<string, number>;
  deadline?: string;
  createdBy: string;
  templateId?: string;
  templateVersion?: number;
  resolvedInputs?: Record<string, unknown>;
  resolvedTaskPlan?: unknown[];
  originScheduleId?: string;
  intendedRunAt?: string;
};

const transitions: Record<MissionStatus, readonly MissionStatus[]> = {
  draft: ["planned", "cancelled"],
  planned: ["running", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createMissionEvent(input: CreateMissionInput): NewDomainEvent {
  const name = input.name.trim();
  const objective = input.objective.trim();
  const domain = input.domain.trim();
  if (!name || !objective || !domain)
    throw new ValidationFailedError("Mission name, objective, and domain are required");
  if (input.deadline && Number.isNaN(Date.parse(input.deadline))) {
    throw new ValidationFailedError("Mission deadline must be an ISO-8601 timestamp");
  }
  return {
    eventType: "mission.created",
    eventSchemaVersion: 1,
    payload: {
      name,
      objective,
      description: input.description?.trim() || null,
      domain,
      priority: input.priority,
      riskLevel: input.riskLevel,
      requestedOutcome: input.requestedOutcome?.trim() || null,
      successCriteria: input.successCriteria ?? [],
      constraints: input.constraints ?? [],
      budgetLimits: input.budgetLimits ?? {},
      deadline: input.deadline ?? null,
      createdBy: input.createdBy,
      templateId: input.templateId ?? null,
      templateVersion: input.templateVersion ?? null,
      resolvedInputs: input.resolvedInputs ?? {},
      resolvedTaskPlan: input.resolvedTaskPlan ?? [],
      originScheduleId: input.originScheduleId ?? null,
      intendedRunAt: input.intendedRunAt ?? null,
      status: "draft",
    },
  };
}

export function rehydrateMission(events: DomainEvent[]): MissionState | undefined {
  let state: MissionState | undefined;
  for (const event of events) {
    if (event.eventType === "mission.created") {
      state = { id: event.aggregateId, version: event.aggregateVersion, status: "draft" };
      continue;
    }
    if (!state) continue;
    const status = event.payload.status;
    if (typeof status === "string" && status in transitions) state.status = status as MissionStatus;
    state.version = event.aggregateVersion;
  }
  return state;
}

export function transitionMission(state: MissionState, target: MissionStatus): NewDomainEvent | undefined {
  if (state.status === target) return undefined;
  if (!transitions[state.status].includes(target)) throw new InvalidTransitionError("Mission", state.status, target);
  const eventType =
    target === "planned"
      ? "mission.planned"
      : target === "running" && state.status === "paused"
        ? "mission.resumed"
        : target === "running"
          ? "mission.started"
          : `mission.${target}`;
  return { eventType, eventSchemaVersion: 1, payload: { status: target } };
}
