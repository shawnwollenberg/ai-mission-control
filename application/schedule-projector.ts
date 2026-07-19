import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";
export async function applyScheduleProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "schedule.created")
      await client.query(
        `INSERT INTO schedule_projections(workspace_id,schedule_id,aggregate_version,name,template_id,template_version,inputs,timezone,schedule_rule,enabled,start_at,end_at,next_run_at,concurrency_policy,missed_run_policy,maximum_active_runs,maximum_queued_runs,maximum_recovery_runs,skip_warning_threshold,created_by,created_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22) ON CONFLICT(workspace_id,schedule_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.payload.name,
          event.payload.templateId,
          event.payload.templateVersion,
          JSON.stringify(event.payload.inputs),
          event.payload.timeZone,
          JSON.stringify(event.payload.rule),
          event.payload.enabled,
          event.payload.startAt,
          event.payload.endAt,
          event.payload.nextRunAt,
          event.payload.concurrencyPolicy,
          event.payload.missedRunPolicy,
          event.payload.maximumActiveRuns,
          event.payload.maximumQueuedRuns ?? 1,
          event.payload.maximumRecoveryRuns ?? 3,
          event.payload.skipWarningThreshold ?? 3,
          event.payload.createdBy,
          event.occurredAt,
          event.position,
        ],
      );
    else if (["schedule.enabled", "schedule.disabled", "schedule.deleted"].includes(event.eventType))
      await client.query(
        `UPDATE schedule_projections SET enabled=$3,deleted_at=CASE WHEN $4='schedule.deleted' THEN $5 ELSE deleted_at END,aggregate_version=$6,updated_at=$5,last_event_position=$7 WHERE workspace_id=$1 AND schedule_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.enabled,
          event.eventType,
          event.occurredAt,
          event.aggregateVersion,
          event.position,
        ],
      );
    else if (["schedule.paused", "schedule.resumed"].includes(event.eventType))
      await client.query(
        `UPDATE schedule_projections SET paused=$3,aggregate_version=$4,updated_at=$5,last_event_position=$6 WHERE workspace_id=$1 AND schedule_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.paused,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    else if (event.eventType === "schedule.updated")
      await client.query(
        `UPDATE schedule_projections SET name=$3,template_version=$4,inputs=$5,timezone=$6,schedule_rule=$7,next_run_at=$8,concurrency_policy=$9,missed_run_policy=$10,maximum_active_runs=$11,aggregate_version=$12,updated_at=$13,last_event_position=$14 WHERE workspace_id=$1 AND schedule_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.name,
          event.payload.templateVersion,
          JSON.stringify(event.payload.inputs),
          event.payload.timeZone,
          JSON.stringify(event.payload.rule),
          event.payload.nextRunAt,
          event.payload.concurrencyPolicy,
          event.payload.missedRunPolicy,
          event.payload.maximumActiveRuns,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    else if (event.eventType.startsWith("schedule.run_")) {
      await client.query(
        `INSERT INTO schedule_run_projections(workspace_id,schedule_run_id,schedule_id,template_id,template_version,intended_run_at,mission_id,status,reason,trigger_type,actual_created_at,concurrency_decision,missed_run_decision,coalesced_run_count,created_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $8='created' THEN $14::timestamptz ELSE NULL END,$11,$12,$13,$14,$14,$15) ON CONFLICT(workspace_id,schedule_run_id) DO UPDATE SET mission_id=EXCLUDED.mission_id,status=EXCLUDED.status,reason=EXCLUDED.reason,actual_created_at=EXCLUDED.actual_created_at,concurrency_decision=EXCLUDED.concurrency_decision,updated_at=EXCLUDED.updated_at,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.payload.scheduleRunId,
          event.aggregateId,
          event.payload.templateId,
          event.payload.templateVersion,
          event.payload.intendedRunAt,
          event.payload.missionId,
          event.payload.status,
          event.payload.reason,
          event.payload.triggerType ?? "scheduled",
          event.payload.concurrencyDecision ?? null,
          event.payload.missedRunDecision ?? null,
          event.payload.coalescedRunCount ?? 0,
          event.occurredAt,
          event.position,
        ],
      );
      await client.query(
        `UPDATE schedule_projections SET aggregate_version=$3,last_run_at=$4,last_run_status=$5,next_run_at=$6,consecutive_skips=CASE WHEN $5='skipped' THEN consecutive_skips+1 ELSE 0 END,total_created=total_created+CASE WHEN $5='created' THEN 1 ELSE 0 END,total_skipped=total_skipped+CASE WHEN $5='skipped' THEN 1 ELSE 0 END,total_queued=total_queued+CASE WHEN $5='queued' THEN 1 ELSE 0 END,lease_owner=NULL,lease_expires_at=NULL,updated_at=$7,last_event_position=$8 WHERE workspace_id=$1 AND schedule_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.payload.intendedRunAt,
          event.payload.status,
          event.payload.nextRunAt,
          event.occurredAt,
          event.position,
        ],
      );
    }
  }
}
