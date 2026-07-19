import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { stableUuid } from "@/lib/stable-id";

export type WorkerStatus = "active" | "degraded" | "stale" | "offline" | "stopping";
export function calculateWorkerStatus(
  row: { last_heartbeat: Date | string; heartbeat_interval_seconds: number; shutdown_requested: boolean },
  now = new Date(),
): WorkerStatus {
  if (row.shutdown_requested) return "stopping";
  const missed = (now.getTime() - new Date(row.last_heartbeat).getTime()) / (row.heartbeat_interval_seconds * 1000);
  if (missed <= 2) return "active";
  if (missed <= 4) return "degraded";
  if (missed <= 8) return "stale";
  return "offline";
}
export async function recordWorkerHeartbeat(input: {
  workspaceId: string;
  workerId: string;
  workerType: string;
  version?: string;
  hostId?: string;
  heartbeatIntervalSeconds?: number;
  currentJobCount?: number;
  currentExecutionIds?: string[];
  jobsCompleted?: number;
  jobsFailed?: number;
  readiness?: Record<string, { ok: boolean; summary: string }>;
  commandId?: string;
}) {
  const existing = await loadAggregateEvents({
    workspaceId: input.workspaceId,
    aggregateType: "worker",
    aggregateId: stableUuid(`worker:${input.workspaceId}:${input.workerId}`),
  });
  const aggregateId = stableUuid(`worker:${input.workspaceId}:${input.workerId}`);
  const first = existing.length === 0;
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "worker",
    aggregateId,
    expectedVersion: existing.length,
    commandId:
      input.commandId ??
      stableUuid(`worker-heartbeat:${input.workspaceId}:${input.workerId}:${Math.floor(Date.now() / 10000)}`),
    commandType: first ? "RegisterWorker" : "HeartbeatWorker",
    correlationId: aggregateId,
    actor: { type: "system", id: input.workerId },
    events: [
      {
        eventType: first ? "worker.registered" : "worker.heartbeat_recorded",
        eventSchemaVersion: 1,
        payload: {
          workerId: input.workerId,
          workerType: input.workerType,
          version: input.version ?? process.env.APP_VERSION ?? "development",
          hostId: input.hostId ?? process.env.HOST_ID ?? "local",
          heartbeatIntervalSeconds: input.heartbeatIntervalSeconds ?? 15,
          currentJobCount: input.currentJobCount ?? 0,
          currentExecutionIds: input.currentExecutionIds ?? [],
          jobsCompleted: input.jobsCompleted ?? 0,
          jobsFailed: input.jobsFailed ?? 0,
          readiness: input.readiness ?? {},
        },
      },
    ],
    applyProjections: applyWorkerProjection,
  });
  return { workerId: input.workerId };
}
export async function requestWorkerShutdown(input: {
  workspaceId: string;
  workerId: string;
  graceful: boolean;
  commandId: string;
}) {
  const aggregateId = stableUuid(`worker:${input.workspaceId}:${input.workerId}`);
  const existing = await loadAggregateEvents({ workspaceId: input.workspaceId, aggregateType: "worker", aggregateId });
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "worker",
    aggregateId,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: "ShutdownWorker",
    correlationId: aggregateId,
    actor: { type: "system", id: input.workerId },
    events: [
      {
        eventType: "worker.shutdown_recorded",
        eventSchemaVersion: 1,
        payload: { workerId: input.workerId, graceful: input.graceful },
      },
    ],
    applyProjections: applyWorkerProjection,
  });
}
export async function applyWorkerProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "worker.registered")
      await client.query(
        `INSERT INTO worker_projections(workspace_id,worker_id,worker_type,version,host_id,started_at,last_heartbeat,heartbeat_interval_seconds,current_job_count,current_execution_ids,jobs_completed,jobs_failed,readiness,aggregate_version,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,worker_id) DO UPDATE SET worker_type=EXCLUDED.worker_type,version=EXCLUDED.version,host_id=EXCLUDED.host_id,started_at=EXCLUDED.started_at,last_heartbeat=EXCLUDED.last_heartbeat,shutdown_requested=false,readiness=EXCLUDED.readiness,aggregate_version=EXCLUDED.aggregate_version,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.payload.workerId,
          event.payload.workerType,
          event.payload.version,
          event.payload.hostId,
          event.occurredAt,
          event.payload.heartbeatIntervalSeconds,
          event.payload.currentJobCount,
          event.payload.currentExecutionIds,
          event.payload.jobsCompleted,
          event.payload.jobsFailed,
          JSON.stringify(event.payload.readiness),
          event.aggregateVersion,
          event.position,
        ],
      );
    else if (event.eventType === "worker.heartbeat_recorded")
      await client.query(
        `UPDATE worker_projections SET last_heartbeat=$3,current_job_count=$4,current_execution_ids=$5,jobs_completed=$6,jobs_failed=$7,readiness=$8,shutdown_requested=false,aggregate_version=$9,last_event_position=$10 WHERE workspace_id=$1 AND worker_id=$2`,
        [
          event.workspaceId,
          event.payload.workerId,
          event.occurredAt,
          event.payload.currentJobCount,
          event.payload.currentExecutionIds,
          event.payload.jobsCompleted,
          event.payload.jobsFailed,
          JSON.stringify(event.payload.readiness),
          event.aggregateVersion,
          event.position,
        ],
      );
    else if (event.eventType === "worker.shutdown_recorded")
      await client.query(
        `UPDATE worker_projections SET shutdown_requested=true,last_graceful_shutdown=CASE WHEN $3 THEN $4::timestamptz ELSE last_graceful_shutdown END,aggregate_version=$5,last_event_position=$6 WHERE workspace_id=$1 AND worker_id=$2`,
        [
          event.workspaceId,
          event.payload.workerId,
          event.payload.graceful,
          event.occurredAt,
          event.aggregateVersion,
          event.position,
        ],
      );
  }
}
export async function workerHealth(workspaceId: string) {
  const rows = (
    await getDatabasePool().query(
      "SELECT * FROM worker_projections WHERE workspace_id=$1 ORDER BY worker_type,worker_id",
      [workspaceId],
    )
  ).rows;
  return rows.map((row) => ({
    ...row,
    calculated_status: calculateWorkerStatus(row),
    ready: Object.values(row.readiness as Record<string, { ok: boolean }>).every((item) => item.ok),
  }));
}
