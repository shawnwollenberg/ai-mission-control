import { NextResponse } from "next/server";
import { launchFirstRepositoryMission } from "@/application/onboarding-mission";
import { changeRecommendationStatus } from "@/application/recommendation-commands";
import { getRecommendation } from "@/application/recommendation-queries";
import { getDatabasePool } from "@/lib/database";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
import { NotFoundError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";

export async function POST(request: Request, { params }: { params: Promise<{ recommendationId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { recommendationId } = await params;
    const recommendation = await getRecommendation(identity.workspaceId, recommendationId);
    if (!recommendation) throw new NotFoundError("Recommendation");
    const retriableMissionStatuses = new Set(["failed", "cancelled", "completed"]);
    if (
      recommendation.linkedMissionId &&
      !retriableMissionStatuses.has(recommendation.linkedMissionStatus ?? "")
    )
      return NextResponse.json({ missionId: recommendation.linkedMissionId });
    const agent = (
      await getDatabasePool().query(
        "SELECT agent_id FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
        [identity.workspaceId, recommendation.sourceExecutionId],
      )
    ).rows[0];
    if (!agent) throw new NotFoundError("Source execution agent");
    // A recommendation may create at most one change mission. Derive the command
    // identity from the recommendation so a retry after a partial response cannot
    // create a second mission, even when the browser supplies a new request key.
    const commandId = stableUuid(
      `recommendation-change-mission:${recommendationId}:${recommendation.linkedMissionId ?? "initial"}`,
    );
    const launched = await launchFirstRepositoryMission({
      actor: { workspaceId: identity.workspaceId, userId: identity.userId, role: identity.role },
      commandId,
      agentId: agent.agent_id,
      repositoryId: recommendation.repositoryId,
      missionType: "change",
      objective: `${recommendation.title}: ${recommendation.description}`,
      acceptanceCriteria: recommendation.acceptanceCriteria.join("\n"),
      validationInstructions: recommendation.suggestedValidation.join("\n"),
      sourceRecommendationId: recommendation.recommendationId,
      sourceEvidence: recommendation.evidence,
    });
    await changeRecommendationStatus({
      actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human" },
      commandId: stableUuid(
        `recommendation-link:${recommendationId}:${recommendation.linkedMissionId ?? "initial"}`,
      ),
      recommendationId,
      target: "in_progress",
      reason: recommendation.linkedMissionId
        ? `Change mission retried after ${recommendation.linkedMissionStatus ?? "terminal"} mission`
        : "Change mission created from recommendation",
      linkedMissionId: launched.missionId,
    });
    return NextResponse.json(launched, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "recommendation_change_mission_failed");
  }
}
