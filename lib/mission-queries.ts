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
  "mission.started": "Mission execution started",
  "mission.paused": "Mission paused",
  "mission.resumed": "Simulated execution resumed",
  "mission.completed": "Mission completed",
  "mission.failed": "Mission failed",
  "mission.cancelled": "Mission cancelled",
  "task.created": "Task created",
  "task.dependency_added": "Task dependency added",
  "task.became_blocked": "Task blocked",
  "task.became_ready": "Task ready",
  "task.assigned": "Executor assigned",
  "task.started": "Task started",
  "task.progress_reported": "Task progress recorded",
  "task.approval_requested": "Approval requested",
  "task.resumed": "Task resumed",
  "task.verification_started": "Verification started",
  "task.completed": "Task completed",
  "task.failed": "Task failed",
  "task.cancelled": "Task cancelled",
  "approval.requested": "Approval requested",
  "approval.granted": "Approval granted",
  "approval.denied": "Approval denied",
  "approval.expired": "Approval expired",
  "approval.consumed": "Approval consumed",
  "execution.requested": "Execution requested",
  "execution.accepted": "Execution accepted",
  "execution.preparation_started": "Execution preparation started",
  "execution.started": "Live execution started",
  "execution.progress_reported": "Execution progress recorded",
  "execution.command_completed": "Execution command completed",
  "execution.artifact_produced": "Execution artifact recorded",
  "execution.approval_requested": "Execution approval requested",
  "execution.paused": "Execution paused",
  "execution.resumed": "Execution resumed",
  "execution.verification_started": "Execution verification started",
  "execution.succeeded": "Live execution succeeded",
  "execution.failed": "Execution failed",
  "execution.timed_out": "Execution timed out",
  "execution.cancellation_requested": "Execution cancellation requested",
  "execution.cancelled": "Execution cancelled",
  "action.requested": "Sensitive action requested",
  "policy.evaluation_started": "Policy evaluation started",
  "policy.evaluated": "Policy evaluated",
  "action.approval_requested": "Action approval requested",
  "action.approved": "Action approved",
  "action.denied": "Action denied",
  "action.execution_started": "Action execution started",
  "action.execution_succeeded": "Action execution succeeded",
  "action.execution_failed": "Action execution failed",
  "action.expired": "Action expired",
  "action.cancelled": "Action cancelled",
};

function safeSummary(event: DomainEvent): string {
  if (event.eventType === "mission.created") return String(event.payload.objective ?? "Mission accepted").slice(0, 300);
  if (typeof event.payload.summary === "string") return event.payload.summary.slice(0, 300);
  if (typeof event.payload.name === "string") return event.payload.name.slice(0, 300);
  if (typeof event.payload.reason === "string") return event.payload.reason.slice(0, 300);
  if (typeof event.payload.outcome === "string") {
    const reasons = Array.isArray(event.payload.reasons)
      ? event.payload.reasons
          .map((item) => (typeof item === "object" && item && "message" in item ? String(item.message) : ""))
          .filter(Boolean)
          .join(" ")
      : "";
    return `Policy outcome: ${event.payload.outcome}.${reasons ? ` ${reasons}` : ""}`.slice(0, 300);
  }
  if (event.eventType === "action.requested")
    return `${String(event.payload.actionType)} requested for ${String(event.payload.targetResource)}`.slice(0, 300);
  if (event.eventType === "action.execution_succeeded")
    return "The approved external action was confirmed by its provider.";
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
