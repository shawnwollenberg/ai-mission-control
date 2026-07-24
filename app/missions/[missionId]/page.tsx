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
import { contextEvidence } from "@/integrations/project-brain/projections";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const identity = await requirePageIdentity(`/missions/${missionId}`);
  const mission = await getMissionProjection(identity.workspaceId, missionId);
  if (!mission) return notFound();
  const missionObjective = mission.objective;
  const execution = await getMissionExecution(identity.workspaceId, missionId);
  let contextPreview: ProjectBrainEnvelope<Record<string, unknown>> | undefined;
  let boundContext: ProjectBrainEnvelope<Record<string, unknown>> | undefined;
  let boundContextEvidence: ReturnType<typeof contextEvidence> | undefined;
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
          { objective: missionObjective, role: "implementer" },
        )
      ).envelope;
      const activeExecutionId = execution.executions[0]?.executionId;
      if (activeExecutionId) {
        try {
          boundContext = (
            await service.readContext<Record<string, unknown>>(
              {
                workspaceId: identity.workspaceId,
                repositoryId: registeredRepository.repository_id,
                repositoryPath: registeredRepository.local_path,
                missionId,
                executionId: activeExecutionId,
              },
              { path: `.project-brain/context-packs/${missionId}.yaml` },
            )
          ).envelope;
          boundContextEvidence = contextEvidence(boundContext, {
            missionId,
            executionId: activeExecutionId,
            startingSha: boundContext.repository?.head_sha ?? "",
          });
        } catch {
          // A missing final pack is expected before the explicit generation action.
        }
      }
    } catch (error) {
      projectBrainError = error instanceof Error ? error.message : "Context preview unavailable";
    }
  }
  async function generateProjectBrainContext() {
    "use server";
    const actionIdentity = await requirePageIdentity(`/missions/${missionId}`);
    const binding = (
      await getDatabasePool().query<{ repository_id: string; local_path: string; execution_id: string }>(
        `SELECT r.repository_id,r.local_path,e.execution_id FROM repositories r
         JOIN execution_projections e ON e.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
         WHERE e.workspace_id=$1 AND e.mission_id=$2 AND r.disabled_at IS NULL
         ORDER BY e.created_at DESC LIMIT 1`,
        [actionIdentity.workspaceId, missionId],
      )
    ).rows[0];
    const executable = process.env.PROJECT_BRAIN_EXECUTABLE;
    if (!binding || !executable) throw new Error("Project Brain context generation is unavailable");
    const service = new ProjectBrainService(new ProjectBrainClient({ executable }));
    await service.prepareAndBindContext(
      {
        workspaceId: actionIdentity.workspaceId,
        repositoryId: binding.repository_id,
        repositoryPath: binding.local_path,
        missionId,
        executionId: binding.execution_id,
      },
      { objective: missionObjective, role: "implementer", output: `.project-brain/context-packs/${missionId}.yaml` },
    );
    revalidatePath(`/missions/${missionId}`);
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
      {contextPreview || boundContext || projectBrainError ? (
        <section aria-label="Project Brain mission evidence">
          <ProjectBrainPanel context={boundContext ?? contextPreview} error={projectBrainError} />
          {boundContextEvidence ? (
            <pre>{JSON.stringify(boundContextEvidence.timelineItem, null, 2)}</pre>
          ) : execution.executions[0] ? (
            <form action={generateProjectBrainContext}>
              <button type="submit">Generate and bind verified context</button>
            </form>
          ) : (
            <p>Context can be bound after an execution is assigned.</p>
          )}
        </section>
      ) : null}
    </>
  );
}
