import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";
export async function applyNotificationProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events)
    if (event.eventType === "notification.created")
      await client.query(
        `INSERT INTO notification_projections(workspace_id,notification_id,source_event_id,category,severity,title,summary,mission_id,schedule_id,approval_id,created_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(workspace_id,source_event_id,category) DO NOTHING`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.sourceEventId,
          event.payload.category,
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
}
