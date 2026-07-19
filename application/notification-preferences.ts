import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { ValidationFailedError } from "@/lib/application-errors";
import type { CommandActor } from "@/application/mission-commands";

export const NOTIFICATION_CATEGORIES = [
  "approvals",
  "mission_outcomes",
  "failures",
  "agent_status",
  "worker_status",
  "schedules",
  "budgets",
  "security",
  "git_publication",
  "defi_analysis",
] as const;
export type NotificationSeverity = "info" | "warning" | "high" | "critical";
const severityRank: Record<NotificationSeverity, number> = { info: 0, warning: 1, high: 2, critical: 3 };

export function validateDestinationReference(reference?: string | null) {
  if (!reference) return;
  if (!/^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9._-]{3,200}$/.test(reference) || /https?:|@/.test(reference))
    throw new ValidationFailedError("Notification destinations must be registered opaque references");
}
export function isSeverityEligible(severity: NotificationSeverity, minimum: NotificationSeverity) {
  return severityRank[severity] >= severityRank[minimum];
}
export function isQuietHour(at: Date, timeZone: string, start?: string | null, end?: string | null) {
  if (!start || !end) return false;
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  const value = Number(local.replace(":", ""));
  const from = Number(start.slice(0, 5).replace(":", ""));
  const to = Number(end.slice(0, 5).replace(":", ""));
  return from <= to ? value >= from && value < to : value >= from || value < to;
}

export async function setNotificationPreferences(input: {
  actor: CommandActor;
  commandId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  outboundEnabled: boolean;
  deliveryMode: "immediate" | "digest";
  minimumSeverity: NotificationSeverity;
  categories: string[];
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timeZone: string;
  dailyDigestTime: string;
  highSeverityOverride: boolean;
  emailDestinationRef?: string | null;
  outboundDestinationRef?: string | null;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  validateDestinationReference(input.emailDestinationRef);
  validateDestinationReference(input.outboundDestinationRef);
  if (input.categories.some((category) => !NOTIFICATION_CATEGORIES.includes(category as never)))
    throw new ValidationFailedError("Unsupported notification category");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(new Date());
  } catch {
    throw new ValidationFailedError("Notification timezone must be an IANA identifier");
  }
  const aggregateId = input.actor.workspaceId;
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "notification_preferences",
    aggregateId,
  });
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "notification_preferences",
    aggregateId,
    expectedVersion: events.length,
    commandId: input.commandId,
    commandType: "SetNotificationPreferences",
    correlationId: aggregateId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "notification.preferences_set",
        eventSchemaVersion: 1,
        payload: { ...input, actor: undefined, commandId: undefined },
      },
    ],
    applyProjections: applyNotificationPreferenceProjection,
  });
  return { preferenceId: aggregateId };
}

export async function applyNotificationPreferenceProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events)
    if (event.eventType === "notification.preferences_set")
      await client.query(
        `INSERT INTO notification_preferences(workspace_id,in_app_enabled,email_enabled,outbound_enabled,delivery_mode,minimum_severity,categories,quiet_hours_start,quiet_hours_end,timezone,daily_digest_time,high_severity_override,email_destination_ref,outbound_destination_ref,aggregate_version,updated_at,last_event_position)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT(workspace_id) DO UPDATE SET in_app_enabled=EXCLUDED.in_app_enabled,email_enabled=EXCLUDED.email_enabled,outbound_enabled=EXCLUDED.outbound_enabled,delivery_mode=EXCLUDED.delivery_mode,minimum_severity=EXCLUDED.minimum_severity,categories=EXCLUDED.categories,quiet_hours_start=EXCLUDED.quiet_hours_start,quiet_hours_end=EXCLUDED.quiet_hours_end,timezone=EXCLUDED.timezone,daily_digest_time=EXCLUDED.daily_digest_time,high_severity_override=EXCLUDED.high_severity_override,email_destination_ref=EXCLUDED.email_destination_ref,outbound_destination_ref=EXCLUDED.outbound_destination_ref,aggregate_version=EXCLUDED.aggregate_version,updated_at=EXCLUDED.updated_at,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.payload.inAppEnabled,
          event.payload.emailEnabled,
          event.payload.outboundEnabled,
          event.payload.deliveryMode,
          event.payload.minimumSeverity,
          event.payload.categories,
          event.payload.quietHoursStart,
          event.payload.quietHoursEnd,
          event.payload.timeZone,
          event.payload.dailyDigestTime,
          event.payload.highSeverityOverride,
          event.payload.emailDestinationRef,
          event.payload.outboundDestinationRef,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
}
