import { randomUUID } from "node:crypto";
import {
  createMissionEvent,
  rehydrateMission,
  transitionMission,
  type CreateMissionInput,
  type MissionStatus,
} from "@/domain/mission";
import { NotFoundError } from "@/lib/application-errors";
import { ConcurrencyConflictError } from "@/lib/application-errors";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { applyMissionProjection } from "@/application/mission-projector";

export type CommandActor = {
  workspaceId: string;
  userId: string;
  role: "owner" | "member";
};

export type CommandResult = {
  missionId: string;
  aggregateVersion: number;
  status: MissionStatus;
  eventIds: string[];
  duplicateCommand: boolean;
  alreadyInState: boolean;
};

export async function handleCreateMission(input: {
  actor: CommandActor;
  commandId: string;
  missionId?: string;
  mission: Omit<CreateMissionInput, "createdBy">;
}): Promise<CommandResult> {
  const missionId = input.missionId ?? randomUUID();
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "mission",
    aggregateId: missionId,
    missionId,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "CreateMission",
    correlationId: missionId,
    actor: { type: "human", id: input.actor.userId },
    events: [createMissionEvent({ ...input.mission, createdBy: input.actor.userId })],
    outbox: [
      {
        eventIndex: 0,
        topic: "mission.events",
        idempotencyKey: `${input.commandId}:mission.created`,
        payload: { missionId, eventType: "mission.created" },
      },
    ],
    applyProjections: applyMissionProjection,
  });
  const durableMissionId = result.events[0]?.aggregateId ?? missionId;
  return {
    missionId: durableMissionId,
    aggregateVersion: result.events.at(-1)?.aggregateVersion ?? 1,
    status: "draft",
    eventIds: result.events.map((event) => event.eventId),
    duplicateCommand: result.duplicateCommand,
    alreadyInState: false,
  };
}

export async function handleMissionTransition(input: {
  actor: CommandActor;
  commandId: string;
  missionId: string;
  target: MissionStatus;
  expectedVersion?: number;
}): Promise<CommandResult> {
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "mission",
    aggregateId: input.missionId,
  });
  const state = rehydrateMission(existing);
  if (!state) throw new NotFoundError("Mission");
  if (input.expectedVersion !== undefined && input.expectedVersion !== state.version) {
    throw new ConcurrencyConflictError({ expectedVersion: input.expectedVersion, actualVersion: state.version });
  }
  const nextEvent = transitionMission(state, input.target);
  if (!nextEvent) {
    return {
      missionId: input.missionId,
      aggregateVersion: state.version,
      status: state.status,
      eventIds: [],
      duplicateCommand: false,
      alreadyInState: true,
    };
  }
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "mission",
    aggregateId: input.missionId,
    missionId: input.missionId,
    expectedVersion: state.version,
    commandId: input.commandId,
    commandType: `${state.status}->${input.target}`,
    correlationId: input.missionId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: "human", id: input.actor.userId },
    events: [nextEvent],
    outbox: [
      {
        eventIndex: 0,
        topic: "mission.events",
        idempotencyKey: `${input.commandId}:${nextEvent.eventType}`,
        payload: { missionId: input.missionId, eventType: nextEvent.eventType },
      },
    ],
    applyProjections: applyMissionProjection,
  });
  return {
    missionId: input.missionId,
    aggregateVersion: result.events.at(-1)?.aggregateVersion ?? state.version,
    status: input.target,
    eventIds: result.events.map((event) => event.eventId),
    duplicateCommand: result.duplicateCommand,
    alreadyInState: false,
  };
}
