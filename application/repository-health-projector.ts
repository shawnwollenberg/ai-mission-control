import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function applyRepositoryHealthProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType !== "repository_health.assessed") continue;
    const p = event.payload;
    await client.query(
      `INSERT INTO repository_health_assessments (
        workspace_id,assessment_id,aggregate_version,repository_id,source_mission_id,source_execution_id,
        source_artifact_id,repository_commit,score,confidence,scoring_version,dimensions,observations,
        assessed_at,last_event_position
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(workspace_id,assessment_id) DO UPDATE SET aggregate_version=excluded.aggregate_version,
        score=excluded.score,confidence=excluded.confidence,dimensions=excluded.dimensions,
        observations=excluded.observations,last_event_position=excluded.last_event_position`,
      [
        event.workspaceId,
        event.aggregateId,
        event.aggregateVersion,
        p.repositoryId,
        p.sourceMissionId,
        p.sourceExecutionId,
        p.sourceArtifactId,
        p.repositoryCommit ?? null,
        p.score,
        p.confidence,
        p.scoringVersion,
        JSON.stringify(p.dimensions),
        JSON.stringify(p.observations),
        event.occurredAt,
        event.position,
      ],
    );
  }
}
