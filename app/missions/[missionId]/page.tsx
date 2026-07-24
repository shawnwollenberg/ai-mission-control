import { notFound } from "next/navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { getMissionProjection, getMissionTimeline } from "@/lib/mission-queries";
import DurableMissionConsole from "./durable-mission-console";
import { getMissionExecution } from "@/lib/execution-queries";
import { listMissionRecommendations } from "@/application/recommendation-queries";
import { getDatabasePool } from "@/lib/database";
import { ProjectBrainClient } from "@/integrations/project-brain/client";
import { ProjectBrainService } from "@/integrations/project-brain/service";
import { ProjectBrainPanel } from "@/integrations/project-brain/project-brain-panel";
import type { ProjectBrainEnvelope } from "@/integrations/project-brain/types";

export const dynamic = "force-dynamic";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const identity = await requirePageIdentity(`/missions/${missionId}`);
  const mission = await getMissionProjection(identity.workspaceId, missionId);
  if (!mission) notFound();
  const execution = await getMissionExecution(identity.workspaceId, missionId);
  let contextPreview: ProjectBrainEnvelope<Record<string, unknown>> | undefined;
  let projectBrainError: string | undefined;
  const registeredRepository = (
    await getDatabasePool().query<{ repository_id: string; local_path: string }>(
      `SELECT r.repository_id,r.local_path FROM repositories r
       JOIN execution_projections e ON e.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
       WHERE e.workspace_id=$1 AND e.mission_id=$2 AND r.disabled_at IS NULL
       ORDER BY e.created_at DESC LIMIT 1`,
      [identity.workspaceId, missionId],
    )
  ).rows[0];
  if (registeredRepository && process.env.PROJECT_BRAIN_EXECUTABLE) {
    try {
      const service = new ProjectBrainService(
        new ProjectBrainClient({ executable: process.env.PROJECT_BRAIN_EXECUTABLE }),
      );
      contextPreview = (
        await service.previewContext<Record<string, unknown>>(
          {
            workspaceId: identity.workspaceId,
            repositoryId: registeredRepository.repository_id,
            repositoryPath: registeredRepository.local_path,
            missionId,
          },
          { objective: mission.objective, role: "implementer" },
        )
      ).envelope;
    } catch (error) {
      projectBrainError = error instanceof Error ? error.message : "Context preview unavailable";
    }
  }
  return (
    <>
      <DurableMissionConsole
        initialMission={mission}
        initialTimeline={await getMissionTimeline(identity.workspaceId, missionId)}
        initialTasks={execution.tasks}
        initialApprovals={execution.approvals}
        initialExecutions={execution.executions}
        initialActions={execution.actions}
        initialRecommendations={await listMissionRecommendations(identity.workspaceId, missionId)}
      />
      {contextPreview || projectBrainError ? (
        <ProjectBrainPanel context={contextPreview} error={projectBrainError} />
      ) : null}
    </>
  );
}
