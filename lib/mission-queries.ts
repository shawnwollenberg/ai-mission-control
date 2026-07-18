import { getMissionProjection, listMissionProjections } from "@/lib/mission-projection-store";
import { loadMissionEvents, type DomainEvent } from "@/lib/postgres-event-store";

export type MissionTimelineEntry = {
  eventId: string;
  eventType: string;
  label: string;
  timestamp: string;
  actor: string;
  sequence: number;
  summary: string;
  correlationId: string;
  imported: boolean;
};

const labels: Record<string, string> = {
  "mission.created": "Mission created",
  "mission.planned": "Mission planned",
  "mission.started": "Simulated execution started",
  "mission.paused": "Mission paused",
  "mission.resumed": "Simulated execution resumed",
  "mission.completed": "Simulated execution completed",
  "mission.failed": "Mission failed",
  "mission.cancelled": "Mission cancelled",
};

function safeSummary(event: DomainEvent): string {
  if (event.eventType === "mission.created") return String(event.payload.objective ?? "Mission accepted").slice(0, 300);
  if (typeof event.payload.summary === "string") return event.payload.summary.slice(0, 300);
  if (typeof event.payload.status === "string") return `Mission status changed to ${event.payload.status}`;
  return "This event type is not yet supported by the current timeline renderer.";
}

export async function getMissionTimeline(workspaceId: string, missionId: string): Promise<MissionTimelineEntry[]> {
  const events = await loadMissionEvents({ workspaceId, missionId });
  return events.map((event) => ({
    eventId: event.eventId,
    eventType: event.eventType,
    label: labels[event.eventType] ?? "Unsupported event",
    timestamp: event.occurredAt,
    actor: event.actorType === "human" ? "Mission owner" : event.actorType,
    sequence: event.aggregateVersion,
    summary: safeSummary(event),
    correlationId: event.correlationId,
    imported: event.metadata.importSource === "dynamodb-demo-v1",
  }));
}

export { getMissionProjection, listMissionProjections as listMissionsForWorkspace };
