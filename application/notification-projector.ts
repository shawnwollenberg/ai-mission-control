import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";
import { insertDelivery } from "@/application/notification-delivery";
import { isQuietHour, isSeverityEligible, type NotificationSeverity } from "@/application/notification-preferences";
export async function applyNotificationProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events)
    if (event.eventType === "notification.created") {
      const preference = (
        await client.query("SELECT * FROM notification_preferences WHERE workspace_id=$1", [event.workspaceId])
      ).rows[0] ?? {
        in_app_enabled: true,
        email_enabled: false,
        outbound_enabled: false,
        minimum_severity: "info",
        categories: [],
        timezone: "UTC",
        high_severity_override: true,
      };
      const category = event.payload.category === "schedule_run" ? "schedules" : String(event.payload.category);
      const severity = event.payload.severity as NotificationSeverity;
      const eligible =
        (!preference.categories.length || preference.categories.includes(category)) &&
        isSeverityEligible(severity, preference.minimum_severity);
      if (preference.in_app_enabled && eligible)
        await client.query(
          `INSERT INTO notification_projections(workspace_id,notification_id,source_event_id,category,severity,title,summary,mission_id,schedule_id,approval_id,created_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(workspace_id,source_event_id,category) DO NOTHING`,
          [
            event.workspaceId,
            event.aggregateId,
            event.payload.sourceEventId,
            category,
            event.payload.severity,
            event.payload.title,
            event.payload.summary,
            event.payload.missionId,
            event.payload.scheduleId,
            event.payload.approvalId,
            event.occurredAt,
            event.position,
          ],
        );
      if (!eligible) continue;
      const quiet = isQuietHour(
        new Date(event.occurredAt),
        preference.timezone,
        preference.quiet_hours_start,
        preference.quiet_hours_end,
      );
      const override = preference.high_severity_override && ["high", "critical"].includes(severity);
      const deliveryStatus =
        preference.delivery_mode === "digest" || (quiet && !override) ? "digest_pending" : "pending";
      for (const channel of ["email", "outbound"] as const) {
        if (!preference[`${channel}_enabled`] || !preference[`${channel}_destination_ref`]) continue;
        await insertDelivery(client, {
          workspaceId: event.workspaceId,
          notificationId: event.aggregateId,
          sourceEventId: String(event.payload.sourceEventId),
          category,
          severity,
          channel,
          destinationRef: preference[`${channel}_destination_ref`],
          status: deliveryStatus,
          title: String(event.payload.title),
          summary: String(event.payload.summary),
        });
      }
    }
}
