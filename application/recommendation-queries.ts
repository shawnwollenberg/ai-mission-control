import { getDatabasePool } from "@/lib/database";

export type RecommendationReadModel = {
  recommendationId: string;
  repositoryId: string;
  repositoryName: string;
  sourceMissionId: string;
  sourceExecutionId: string;
  sourceArtifactId?: string;
  title: string;
  description: string;
  reasoning: string;
  evidence: Array<{ path: string; line?: number; description?: string }>;
  estimatedImpact: string;
  estimatedRisk: string;
  estimatedEffort: string;
  suggestedValidation: string[];
  acceptanceCriteria: string[];
  status: string;
  linkedMissionId?: string;
  linkedMissionStatus?: string;
  supersededBy?: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
};

const select = `SELECT p.*,r.name repository_name,lm.status linked_mission_status FROM recommendation_projections p
  JOIN repositories r ON r.workspace_id=p.workspace_id AND r.repository_id=p.repository_id
  LEFT JOIN mission_projections lm ON lm.workspace_id=p.workspace_id AND lm.mission_id=p.linked_mission_id`;
type RecommendationRow = {
  recommendation_id: string;
  repository_id: string;
  repository_name: string;
  source_mission_id: string;
  source_execution_id: string;
  source_artifact_id: string | null;
  title: string;
  description: string;
  reasoning: string;
  evidence: RecommendationReadModel["evidence"];
  estimated_impact: string;
  estimated_risk: string;
  estimated_effort: string;
  suggested_validation: string[];
  acceptance_criteria: string[];
  status: string;
  linked_mission_id: string | null;
  linked_mission_status: string | null;
  superseded_by: string | null;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
};
function map(row: RecommendationRow): RecommendationReadModel {
  return {
    recommendationId: row.recommendation_id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    sourceMissionId: row.source_mission_id,
    sourceExecutionId: row.source_execution_id,
    ...(row.source_artifact_id ? { sourceArtifactId: row.source_artifact_id } : {}),
    title: row.title,
    description: row.description,
    reasoning: row.reasoning,
    evidence: row.evidence,
    estimatedImpact: row.estimated_impact,
    estimatedRisk: row.estimated_risk,
    estimatedEffort: row.estimated_effort,
    suggestedValidation: row.suggested_validation,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    ...(row.linked_mission_id ? { linkedMissionId: row.linked_mission_id } : {}),
    ...(row.linked_mission_status ? { linkedMissionStatus: row.linked_mission_status } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export async function getRecommendation(workspaceId: string, recommendationId: string) {
  const row = (
    await getDatabasePool().query<RecommendationRow>(`${select} WHERE p.workspace_id=$1 AND p.recommendation_id=$2`, [
      workspaceId,
      recommendationId,
    ])
  ).rows[0];
  return row ? map(row) : undefined;
}
export async function listMissionRecommendations(workspaceId: string, missionId: string) {
  return (
    await getDatabasePool().query<RecommendationRow>(
      `${select} WHERE p.workspace_id=$1 AND p.source_mission_id=$2 ORDER BY p.created_at`,
      [workspaceId, missionId],
    )
  ).rows.map(map);
}
export async function listRepositoryRecommendations(workspaceId: string, repositoryId: string) {
  return (
    await getDatabasePool().query<RecommendationRow>(
      `${select} WHERE p.workspace_id=$1 AND p.repository_id=$2 ORDER BY p.created_at DESC`,
      [workspaceId, repositoryId],
    )
  ).rows.map(map);
}
