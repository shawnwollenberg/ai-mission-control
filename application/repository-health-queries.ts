import { getDatabasePool } from "@/lib/database";

export type RepositoryHealthAssessment = {
  assessmentId: string;
  repositoryId: string;
  sourceMissionId: string;
  sourceExecutionId: string;
  sourceArtifactId: string;
  repositoryCommit?: string;
  score: number | null;
  confidence: number;
  scoringVersion: string;
  dimensions: Record<string, { score: number | null; status: string; observationCount: number }>;
  observations: Array<{
    dimension: string;
    status: string;
    severity: string;
    summary: string;
    evidence: Array<{ path: string; line?: number; description?: string }>;
  }>;
  assessedAt: string;
};
type Row = {
  assessment_id: string;
  repository_id: string;
  source_mission_id: string;
  source_execution_id: string;
  source_artifact_id: string;
  repository_commit: string | null;
  score: number | null;
  confidence: number;
  scoring_version: string;
  dimensions: RepositoryHealthAssessment["dimensions"];
  observations: RepositoryHealthAssessment["observations"];
  assessed_at: Date;
};
const map = (row: Row): RepositoryHealthAssessment => ({
  assessmentId: row.assessment_id,
  repositoryId: row.repository_id,
  sourceMissionId: row.source_mission_id,
  sourceExecutionId: row.source_execution_id,
  sourceArtifactId: row.source_artifact_id,
  ...(row.repository_commit ? { repositoryCommit: row.repository_commit } : {}),
  score: row.score,
  confidence: row.confidence,
  scoringVersion: row.scoring_version,
  dimensions: row.dimensions,
  observations: row.observations,
  assessedAt: row.assessed_at.toISOString(),
});
export async function listRepositoryHealthAssessments(workspaceId: string, repositoryId: string) {
  return (
    await getDatabasePool().query<Row>(
      `SELECT * FROM repository_health_assessments WHERE workspace_id=$1 AND repository_id=$2
       ORDER BY assessed_at DESC,assessment_id DESC LIMIT 24`,
      [workspaceId, repositoryId],
    )
  ).rows.map(map);
}

export async function listRepositoryTimeline(workspaceId: string, repositoryId: string) {
  const rows = await getDatabasePool().query<{
    item_type: string;
    item_id: string;
    mission_id: string | null;
    title: string;
    detail: string;
    status: string;
    occurred_at: Date;
  }>(
    `WITH repository_missions AS (
       SELECT DISTINCT m.mission_id,m.name,m.objective,m.status,m.created_at,m.updated_at
       FROM mission_projections m JOIN task_projections t ON t.workspace_id=m.workspace_id AND t.mission_id=m.mission_id
       WHERE m.workspace_id=$1 AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(t.required_resources) resource
         WHERE resource->>'resourceType'='repository' AND resource->>'resourceId'=$2::text
       )
     ), timeline AS (
       SELECT 'mission' item_type,mission_id item_id,mission_id,name title,objective detail,status,created_at occurred_at
       FROM repository_missions
       UNION ALL
       SELECT 'recommendation',recommendation_id,source_mission_id,title,description,status,created_at
       FROM recommendation_projections WHERE workspace_id=$1 AND repository_id=$2::uuid
       UNION ALL
       SELECT 'health_assessment',assessment_id,source_mission_id,'Repository health assessed',
         concat(coalesce(score::text,'Unknown'),' / 100 · ',confidence,'% confidence'),'assessed',assessed_at
       FROM repository_health_assessments WHERE workspace_id=$1 AND repository_id=$2::uuid
       UNION ALL
       SELECT 'approval',a.approval_id,a.mission_id,concat('Approval ',replace(a.status,'_',' ')),
         coalesce(a.requested_action->>'actionType',a.approval_type),a.status,a.created_at
       FROM approval_projections a JOIN repository_missions m ON m.mission_id=a.mission_id
     ) SELECT * FROM timeline ORDER BY occurred_at DESC,item_id DESC LIMIT 100`,
    [workspaceId, repositoryId],
  );
  return rows.rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() }));
}
