import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";
export async function applyExecutionProjection(client: PoolClient, events: DomainEvent[]) {
  for (const e of events) {
    if (e.eventType === "execution.requested")
      await client.query(
        `INSERT INTO execution_projections(workspace_id,execution_id,mission_id,task_id,agent_id,aggregate_version,attempt,status,input,idempotency_key,repository_id,adapter_type,timeout_at,created_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,'requested',$8,$9,$10,$11,$12,$13,$13,$14) ON CONFLICT(workspace_id,execution_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,last_event_position=EXCLUDED.last_event_position`,
        [
          e.workspaceId,
          e.aggregateId,
          e.missionId,
          e.payload.taskId,
          e.payload.agentId,
          e.aggregateVersion,
          e.payload.attempt,
          JSON.stringify(e.payload),
          e.payload.idempotencyKey,
          e.payload.repositoryId,
          e.payload.adapterType,
          new Date(Date.parse(e.occurredAt) + Number(e.payload.timeoutSeconds) * 1000).toISOString(),
          e.occurredAt,
          e.position,
        ],
      );
    else {
      await client.query(
        `UPDATE execution_projections SET status=COALESCE($3,status),aggregate_version=$4,stage=COALESCE($5,stage),progress_summary=COALESCE($6,progress_summary),worker_id=COALESCE($7,worker_id),external_execution_id=COALESCE($8,external_execution_id),branch_name=COALESCE($9,branch_name),worktree_path=COALESCE($10,worktree_path),commit_id=COALESCE($11,commit_id),failure_classification=COALESCE($12,failure_classification),retry_disposition=COALESCE($13,retry_disposition),started_at=CASE WHEN $14 THEN COALESCE(started_at,$15) ELSE started_at END,completed_at=CASE WHEN $16 THEN $15 ELSE completed_at END,cancellation_requested_at=CASE WHEN $17 THEN $15 ELSE cancellation_requested_at END,updated_at=$15,last_event_position=$18 WHERE workspace_id=$1 AND execution_id=$2`,
        [
          e.workspaceId,
          e.aggregateId,
          e.payload.status ?? null,
          e.aggregateVersion,
          e.payload.stage ?? null,
          e.payload.summary ?? null,
          e.payload.workerId ?? null,
          e.payload.externalExecutionId ?? null,
          e.payload.branchName ?? null,
          e.payload.worktreePath ?? null,
          e.payload.commitId ?? null,
          e.payload.classification ?? null,
          e.payload.retryDisposition ?? null,
          e.eventType === "execution.started",
          e.occurredAt,
          ["execution.succeeded", "execution.failed", "execution.timed_out", "execution.cancelled"].includes(
            e.eventType,
          ),
          e.eventType === "execution.cancellation_requested",
          e.position,
        ],
      );
    }
  }
}
