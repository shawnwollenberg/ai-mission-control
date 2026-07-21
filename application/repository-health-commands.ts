import { createRepositoryHealthAssessment, type RepositoryObservation } from "@/domain/repository-health";
import { appendEvents } from "@/lib/postgres-event-store";
import { applyRepositoryHealthProjection } from "@/application/repository-health-projector";
import { stableUuid } from "@/lib/stable-id";

export async function recordRepositoryHealthAssessment(input: {
  actor: { workspaceId: string; id: string; type: "agent" | "human" | "system" };
  commandId: string;
  repositoryId: string;
  sourceMissionId: string;
  sourceExecutionId: string;
  sourceArtifactId: string;
  repositoryCommit?: string;
  observations: RepositoryObservation[];
}) {
  const assessmentId = stableUuid(`repository-health-assessment:${input.commandId}`);
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "repository_health",
    aggregateId: assessmentId,
    missionId: input.sourceMissionId,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RecordRepositoryHealthAssessment",
    correlationId: input.sourceMissionId,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [
      createRepositoryHealthAssessment({
        repositoryId: input.repositoryId,
        sourceMissionId: input.sourceMissionId,
        sourceExecutionId: input.sourceExecutionId,
        sourceArtifactId: input.sourceArtifactId,
        repositoryCommit: input.repositoryCommit,
        observations: input.observations,
      }),
    ],
    applyProjections: applyRepositoryHealthProjection,
  });
  return assessmentId;
}
