import { randomUUID } from "node:crypto";
import { appendEvents, loadAggregateEvents, type ActorType } from "@/lib/postgres-event-store";

export async function recordOnboardingEvent(input: {
  workspaceId: string;
  actorId: string;
  actorType?: ActorType;
  eventType: string;
  payload?: Record<string, unknown>;
  commandId?: string;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.workspaceId,
    aggregateType: "workspace",
    aggregateId: input.workspaceId,
  });
  return appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "workspace",
    aggregateId: input.workspaceId,
    expectedVersion: events.length,
    commandId: input.commandId ?? randomUUID(),
    commandType: input.eventType,
    correlationId: input.workspaceId,
    causationId: events.at(-1)?.eventId,
    actor: { type: input.actorType ?? "human", id: input.actorId },
    events: [{ eventType: input.eventType, eventSchemaVersion: 1, payload: input.payload ?? {} }],
  });
}
