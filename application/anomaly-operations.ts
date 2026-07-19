import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { stableUuid } from "@/lib/stable-id";
import { calculateWorkerStatus } from "@/application/worker-operations";
import { applyNotificationProjection } from "@/application/notification-projector";
import { ValidationFailedError } from "@/lib/application-errors";
import type { CommandActor } from "@/application/mission-commands";
export async function detectOperationalAnomalies(workspaceId: string, now = new Date()) {
  const workers = (
    await getDatabasePool().query("SELECT * FROM worker_projections WHERE workspace_id=$1", [workspaceId])
  ).rows;
  const created: string[] = [];
  for (const worker of workers) {
    const status = calculateWorkerStatus(worker, now);
    if (!["stale", "offline"].includes(status)) continue;
    const anomalyId = stableUuid(
      `anomaly:worker:${workspaceId}:${worker.worker_id}:${new Date(worker.last_heartbeat).toISOString()}`,
    );
    const result = await appendEvents({
      workspaceId,
      aggregateType: "anomaly",
      aggregateId: anomalyId,
      expectedVersion: 0,
      commandId: anomalyId,
      commandType: "DetectWorkerAnomaly",
      correlationId: anomalyId,
      actor: { type: "system", id: "deterministic-anomaly-detector" },
      events: [
        {
          eventType: "anomaly.detected",
          eventSchemaVersion: 1,
          payload: {
            anomalyType: "worker_heartbeat_stale",
            resourceType: "worker",
            resourceId: worker.worker_id,
            severity: status === "offline" ? "high" : "warning",
            status: "open",
            summary: `${worker.worker_type} is ${status}`,
            evidence: { lastHeartbeat: worker.last_heartbeat, calculatedStatus: status },
          },
        },
      ],
      applyProjections: applyAnomalyProjection,
    });
    if (!result.duplicateCommand) {
      created.push(anomalyId);
      const source = result.events[0];
      const notificationId = stableUuid(`notification:${source.eventId}:worker_status`);
      await appendEvents({
        workspaceId,
        aggregateType: "notification",
        aggregateId: notificationId,
        expectedVersion: 0,
        commandId: notificationId,
        commandType: "CreateAnomalyNotification",
        correlationId: anomalyId,
        causationId: source.eventId,
        actor: { type: "system", id: "anomaly-notifier" },
        events: [
          {
            eventType: "notification.created",
            eventSchemaVersion: 1,
            payload: {
              sourceEventId: source.eventId,
              category: "worker_status",
              severity: status === "offline" ? "high" : "warning",
              title: `${worker.worker_type} ${status}`,
              summary: "Mission Control calculated worker health from its last durable heartbeat.",
              missionId: null,
              scheduleId: null,
              approvalId: null,
            },
          },
        ],
        applyProjections: applyNotificationProjection,
      });
    }
  }
  return created;
}
export async function requestProhibitedRemediation(input: {
  actor: CommandActor;
  commandId: string;
  anomalyId: string;
  recommendation?: string;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "anomaly",
    aggregateId: input.anomalyId,
  });
  if (!existing.length) throw new ValidationFailedError("Anomaly does not exist");
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "anomaly",
    aggregateId: input.anomalyId,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: "RequestRemediation",
    correlationId: input.anomalyId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "anomaly.remediation_denied",
        eventSchemaVersion: 1,
        payload: {
          recommendation: input.recommendation ?? null,
          policy: "phase5.no_production_remediation",
          executed: false,
          reason: "Production remediation and infrastructure modification are permanently unavailable in Phase 5",
        },
      },
    ],
    applyProjections: applyAnomalyProjection,
  });
  return { denied: true, executed: false };
}
export async function applyAnomalyProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events)
    if (event.eventType === "anomaly.detected")
      await client.query(
        `INSERT INTO anomaly_projections(workspace_id,anomaly_id,anomaly_type,resource_type,resource_id,severity,status,summary,evidence,detected_at,aggregate_version,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.anomalyType,
          event.payload.resourceType,
          event.payload.resourceId,
          event.payload.severity,
          event.payload.status,
          event.payload.summary,
          JSON.stringify(event.payload.evidence),
          event.occurredAt,
          event.aggregateVersion,
          event.position,
        ],
      );
    else if (event.eventType === "anomaly.remediation_denied")
      await client.query(
        `UPDATE anomaly_projections SET aggregate_version=$3,last_event_position=$4,evidence=evidence||$5::jsonb WHERE workspace_id=$1 AND anomaly_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.position,
          JSON.stringify({ remediationDecision: event.payload }),
        ],
      );
}
