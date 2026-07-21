import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function applyActionProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "action.requested") {
      await client.query(
        `INSERT INTO action_request_projections(workspace_id,action_request_id,mission_id,task_id,execution_id,agent_id,repository_id,aggregate_version,action_type,target_resource,parameters_summary,action_hash,status,requested_by,idempotency_key,requested_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'requested',$13,$14,$15,$15,$16) ON CONFLICT(workspace_id,action_request_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.missionId,
          event.payload.taskId ?? null,
          event.payload.executionId ?? null,
          event.payload.agentId ?? null,
          event.payload.repositoryId ?? null,
          event.aggregateVersion,
          event.payload.actionType,
          event.payload.targetResource,
          event.payload.parametersSummary,
          event.payload.actionHash,
          event.payload.requestedBy,
          event.payload.idempotencyKey,
          event.occurredAt,
          event.position,
        ],
      );
    } else {
      await client.query(
        `UPDATE action_request_projections SET aggregate_version=$3,status=COALESCE($4,status),policy_version=COALESCE($5,policy_version),policy_outcome=COALESCE($6,policy_outcome),policy_reasons=CASE WHEN $7::jsonb IS NULL THEN policy_reasons ELSE $7::jsonb END,approval_id=COALESCE($8,approval_id),result=COALESCE($9,result),failure_classification=CASE WHEN $4='succeeded' THEN NULL ELSE COALESCE($10,failure_classification) END,retry_disposition=CASE WHEN $4='succeeded' THEN NULL ELSE COALESCE($11,retry_disposition) END,executed_at=CASE WHEN $4='executing' THEN $12 ELSE executed_at END,completed_at=CASE WHEN $4='executing' THEN NULL WHEN $4 IN('succeeded','failed','denied','expired','cancelled') THEN $12 ELSE completed_at END,updated_at=$12,last_event_position=$13 WHERE workspace_id=$1 AND action_request_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.payload.status ?? null,
          event.payload.policyVersion ?? null,
          event.payload.outcome ?? null,
          event.payload.reasons ? JSON.stringify(event.payload.reasons) : null,
          event.payload.approvalId ?? null,
          event.payload.result ?? null,
          event.payload.classification ?? null,
          event.payload.retryDisposition ?? null,
          event.occurredAt,
          event.position,
        ],
      );
    }
  }
}
