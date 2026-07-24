import { notFound } from "next/navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { getMissionProjection, getMissionTimeline } from "@/lib/mission-queries";
import DurableMissionConsole from "./durable-mission-console";
import { getMissionExecution } from "@/lib/execution-queries";
import { listMissionRecommendations } from "@/application/recommendation-queries";
import { getDatabasePool } from "@/lib/database";
import { ProjectBrainPanel } from "@/integrations/project-brain/project-brain-panel";
import { revalidatePath } from "next/cache";
import { requestProjectBrainOperation, requestProjectBrainWriteApproval } from "@/application/project-brain-commands";

export const dynamic = "force-dynamic";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const identity = await requirePageIdentity(`/missions/${missionId}`);
  const mission = await getMissionProjection(identity.workspaceId, missionId);
  if (!mission) return notFound();
  const missionObjective = mission.objective;
  const execution = await getMissionExecution(identity.workspaceId, missionId);
  const registeredRepository = (
    await getDatabasePool().query<{ repository_id: string; local_path: string }>(
      `SELECT r.repository_id,r.local_path FROM repositories r
       JOIN execution_projections e ON e.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
       WHERE e.workspace_id=$1 AND e.mission_id=$2 AND r.disabled_at IS NULL
       ORDER BY e.created_at DESC LIMIT 1`,
      [identity.workspaceId, missionId],
    )
  ).rows[0];
  const projectBrainProjection = (
    await getDatabasePool().query<Record<string, unknown>>(
      "SELECT * FROM mission_project_brain_projections WHERE workspace_id=$1 AND mission_id=$2",
      [identity.workspaceId, missionId],
    )
  ).rows[0];
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
    if (!binding) throw new Error("Project Brain context generation is unavailable");
    const contextRequest = {
      repositoryId: binding.repository_id,
      missionId,
      executionId: binding.execution_id,
      operation: "prepare_context" as const,
      arguments: {
        objective: missionObjective,
        role: "implementer",
        preview: false,
        output: `.project-brain/context-packs/${missionId}.yaml`,
      },
    };
    const granted = (
      await getDatabasePool().query<{ approval_id: string; requested_action: Record<string, unknown> }>(
        `SELECT approval_id,requested_action FROM approval_projections
         WHERE workspace_id=$1 AND mission_id=$2 AND execution_id=$3
           AND approval_type='project_brain_repository_write' AND status='granted'
           AND requested_action->>'operation'='prepare_context'
           AND requested_action->>'repositoryId'=$4
           AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1`,
        [actionIdentity.workspaceId, missionId, binding.execution_id, binding.repository_id],
      )
    ).rows[0];
    if (!granted) {
      await requestProjectBrainWriteApproval({
        actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
        request: contextRequest,
      });
      revalidatePath(`/missions/${missionId}`);
      return;
    }
    await requestProjectBrainOperation({
      actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
      request: {
        ...contextRequest,
        approvalId: granted.approval_id,
        idempotencyKey: `project-brain-context-final:${missionId}:${binding.execution_id}`,
      },
    });
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
      {registeredRepository || projectBrainProjection ? (
        <section aria-label="Project Brain mission evidence">
          <ProjectBrainPanel projection={projectBrainProjection} />
          {execution.executions[0] ? (
            <form action={generateProjectBrainContext}>
              <button type="submit">Authorize or generate verified context</button>
            </form>
          ) : (
            <p>Context can be bound after an execution is assigned.</p>
          )}
        </section>
      ) : null}
    </>
  );
}
