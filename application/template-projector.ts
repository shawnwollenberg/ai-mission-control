import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function applyTemplateProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "template.version_created")
      await client.query(
        `INSERT INTO mission_template_projections(workspace_id,template_id,version,aggregate_version,name,description,domain,status,default_objective,input_schema,task_definitions,dependencies,defaults,artifact_expectations,created_by,created_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,$15,$16) ON CONFLICT(workspace_id,template_id,version) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.version,
          event.aggregateVersion,
          event.payload.name,
          event.payload.description,
          event.payload.domain,
          event.payload.defaultObjective,
          JSON.stringify(event.payload.inputSchema),
          JSON.stringify(event.payload.tasks),
          JSON.stringify(event.payload.dependencies),
          JSON.stringify(event.payload.defaults),
          JSON.stringify(event.payload.artifactExpectations),
          event.payload.createdBy,
          event.occurredAt,
          event.position,
        ],
      );
    else if (event.eventType === "template.published" || event.eventType === "template.deprecated")
      await client.query(
        `UPDATE mission_template_projections SET status=$4,aggregate_version=$5,updated_at=$6,published_at=CASE WHEN $4='published' THEN $6 ELSE published_at END,deprecated_at=CASE WHEN $4='deprecated' THEN $6 ELSE deprecated_at END,last_event_position=$7 WHERE workspace_id=$1 AND template_id=$2 AND version=$3`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.version,
          event.payload.status,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
  }
}
