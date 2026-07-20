import { randomUUID } from "node:crypto";
import { applyRecommendationProjection } from "@/application/recommendation-projector";
import {
  createRecommendation,
  rehydrateRecommendation,
  transitionRecommendation,
  type RecommendationStatus,
} from "@/domain/recommendation";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";

export type RecommendationActor = { workspaceId: string; id: string; type: "human" | "agent" | "system" };

export async function recordRepositoryRecommendations(input: {
  actor: RecommendationActor;
  commandId: string;
  repositoryId: string;
  sourceMissionId: string;
  sourceExecutionId: string;
  sourceArtifactId?: string;
  recommendations: Array<
    Omit<
      Parameters<typeof createRecommendation>[0],
      "repositoryId" | "sourceMissionId" | "sourceExecutionId" | "sourceArtifactId"
    >
  >;
}) {
  if (!input.recommendations.length || input.recommendations.length > 20)
    throw new ValidationFailedError("Repository analysis must contain between one and twenty recommendations");
  const prepared = input.recommendations.map((recommendation) =>
    createRecommendation({
      ...recommendation,
      repositoryId: input.repositoryId,
      sourceMissionId: input.sourceMissionId,
      sourceExecutionId: input.sourceExecutionId,
      sourceArtifactId: input.sourceArtifactId,
    }),
  );
  const ids: string[] = [];
  for (let index = 0; index < input.recommendations.length; index += 1) {
    const recommendationId = randomUUID();
    ids.push(recommendationId);
    await appendEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "recommendation",
      aggregateId: recommendationId,
      missionId: input.sourceMissionId,
      expectedVersion: 0,
      commandId: stableUuid(`${input.commandId}:${index}`),
      commandType: "RecordRepositoryRecommendation",
      correlationId: input.sourceMissionId,
      actor: { type: input.actor.type, id: input.actor.id },
      events: [prepared[index]],
      applyProjections: applyRecommendationProjection,
    });
  }
  return ids;
}

export async function changeRecommendationStatus(input: {
  actor: RecommendationActor;
  commandId: string;
  recommendationId: string;
  target: RecommendationStatus;
  reason?: string;
  linkedMissionId?: string;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "recommendation",
    aggregateId: input.recommendationId,
  });
  const state = rehydrateRecommendation(events);
  if (!state) throw new NotFoundError("Recommendation");
  return appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "recommendation",
    aggregateId: input.recommendationId,
    missionId: events[0].missionId,
    expectedVersion: state.version,
    commandId: input.commandId,
    commandType: "ChangeRecommendationStatus",
    correlationId: events[0].correlationId,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [
      transitionRecommendation(state, input.target, { reason: input.reason, linkedMissionId: input.linkedMissionId }),
    ],
    applyProjections: applyRecommendationProjection,
  });
}
