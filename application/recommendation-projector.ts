import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function applyRecommendationProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "recommendation.created") {
      await client.query(
        `INSERT INTO recommendation_projections (
          workspace_id,recommendation_id,aggregate_version,repository_id,source_mission_id,source_execution_id,
          source_artifact_id,title,description,reasoning,evidence,estimated_impact,estimated_risk,estimated_effort,
          suggested_validation,acceptance_criteria,status,created_at,updated_at,last_event_position
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'open',$17,$17,$18)
        ON CONFLICT(workspace_id,recommendation_id) DO UPDATE SET
          aggregate_version=excluded.aggregate_version,title=excluded.title,description=excluded.description,
          reasoning=excluded.reasoning,evidence=excluded.evidence,estimated_impact=excluded.estimated_impact,
          estimated_risk=excluded.estimated_risk,estimated_effort=excluded.estimated_effort,
          suggested_validation=excluded.suggested_validation,acceptance_criteria=excluded.acceptance_criteria,
          status='open',updated_at=excluded.updated_at,last_event_position=excluded.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.payload.repositoryId,
          event.payload.sourceMissionId,
          event.payload.sourceExecutionId,
          event.payload.sourceArtifactId ?? null,
          event.payload.title,
          event.payload.description,
          event.payload.reasoning,
          JSON.stringify(event.payload.evidence),
          event.payload.estimatedImpact,
          event.payload.estimatedRisk,
          event.payload.estimatedEffort,
          JSON.stringify(event.payload.suggestedValidation),
          JSON.stringify(event.payload.acceptanceCriteria),
          event.occurredAt,
          event.position,
        ],
      );
    } else if (event.eventType === "recommendation.status_changed") {
      await client.query(
        `UPDATE recommendation_projections SET status=$3,status_reason=$4,linked_mission_id=coalesce($5,linked_mission_id),
         superseded_by=coalesce($6,superseded_by),aggregate_version=$7,updated_at=$8,last_event_position=$9
         WHERE workspace_id=$1 AND recommendation_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.status,
          event.payload.reason ?? null,
          event.payload.linkedMissionId ?? null,
          event.payload.supersededBy ?? null,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    }
  }
}
