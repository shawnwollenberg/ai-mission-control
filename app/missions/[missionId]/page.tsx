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
import { getConsensusHistory } from "@/application/consensus-plan-commands";
import ConsensusPlanConsole from "./consensus-plan-console";

export const dynamic = "force-dynamic";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const identity = await requirePageIdentity(`/missions/${missionId}`);
  const mission = await getMissionProjection(identity.workspaceId, missionId);
  if (!mission) return notFound();
  if (mission.missionType === "consensus_plan") {
    const executors = (
      await getDatabasePool().query(
        `SELECT agent_id,name,provider_id,supported_models,model_capabilities FROM agents
         WHERE workspace_id=$1 AND status='active' AND delivery_mode='pull'
           AND repository_mutation=true AND structured_output=true
           AND provider_credentials_available=true
           AND capability_attestation_id IS NOT NULL AND capability_attestation_expires_at>now()
           AND mission_agent_checksum_status='verified' AND mission_agent_capability_expires_at>now()
           AND supported_mission_roles ? 'executor' AND supported_operations ? 'implement_change'
         ORDER BY name,agent_id`,
        [identity.workspaceId],
      )
    ).rows;
    return (
      <ConsensusPlanConsole
        mission={mission}
        initialHistory={await getConsensusHistory(identity.workspaceId, missionId)}
        executors={executors}
        owner={identity.role === "owner"}
      />
    );
  }
  const missionObjective = mission.objective;
  const missionSuccessCriteria = mission.successCriteria ?? [];
  const execution = await getMissionExecution(identity.workspaceId, missionId);
  const childRoleUsage = mission.parentConsensusMissionId
    ? (
        await getDatabasePool().query<{
          role: string;
          provider_id: string;
          model_id: string;
          metric_type: string | null;
          quantity: string | null;
          unit: string | null;
          cost_amount: string | null;
          currency: string | null;
        }>(
          `SELECT p.role,p.provider_id,p.model_id,u.metric_type,
             sum(u.quantity)::text quantity,u.unit,sum(u.cost_amount)::text cost_amount,u.currency
           FROM consensus_participant_assignments p
           LEFT JOIN usage_records u ON u.workspace_id=p.workspace_id
             AND u.participant_assignment_id=p.participant_assignment_id AND u.mission_id=$3
           WHERE p.workspace_id=$1 AND p.mission_id=$2 AND p.role IN('executor','implementation_reviewer')
           GROUP BY p.role,p.provider_id,p.model_id,u.metric_type,u.unit,u.currency
           ORDER BY p.role,u.metric_type`,
          [identity.workspaceId, mission.parentConsensusMissionId, missionId],
        )
      ).rows
    : [];
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
      await getDatabasePool().query<{
        repository_id: string;
        local_path: string;
        execution_id: string;
        observed_commit: string;
      }>(
        `SELECT r.repository_id,r.local_path,r.observed_commit,e.execution_id FROM repositories r
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
        write: true,
        mission_id: missionId,
        execution_id: binding.execution_id,
        base_sha: binding.observed_commit,
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
           AND requested_action->>'startingSha'=$5
           AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC LIMIT 1`,
        [actionIdentity.workspaceId, missionId, binding.execution_id, binding.repository_id, binding.observed_commit],
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
        idempotencyKey: `project-brain-context-final:${missionId}:${binding.execution_id}:${binding.observed_commit}`,
      },
    });
    revalidatePath(`/missions/${missionId}`);
  }
  async function previewProjectBrainContext() {
    "use server";
    const actionIdentity = await requirePageIdentity(`/missions/${missionId}`);
    const binding = (
      await getDatabasePool().query<{ repository_id: string; execution_id: string; observed_commit: string }>(
        `SELECT r.repository_id,r.observed_commit,e.execution_id FROM repositories r
         JOIN execution_projections e ON e.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
         WHERE e.workspace_id=$1 AND e.mission_id=$2 AND r.disabled_at IS NULL
         ORDER BY e.created_at DESC LIMIT 1`,
        [actionIdentity.workspaceId, missionId],
      )
    ).rows[0];
    if (!binding) throw new Error("Project Brain context preview is unavailable");
    await requestProjectBrainOperation({
      actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
      request: {
        repositoryId: binding.repository_id,
        missionId,
        executionId: binding.execution_id,
        operation: "prepare_context",
        arguments: {
          objective: missionObjective,
          role: "implementer",
          preview: true,
          write: false,
          mission_id: missionId,
          execution_id: binding.execution_id,
          base_sha: binding.observed_commit,
        },
        startingSha: binding.observed_commit,
        idempotencyKey: `project-brain-context-preview:${missionId}:${binding.execution_id}:${binding.observed_commit}`,
      },
    });
    revalidatePath(`/missions/${missionId}`);
  }
  async function advanceProjectBrainLifecycle(formData: FormData) {
    "use server";
    const actionIdentity = await requirePageIdentity(`/missions/${missionId}`);
    const operation = String(formData.get("operation"));
    if (!["initialize_repository", "record_closure", "propose_learning", "evaluate_learning"].includes(operation))
      throw new Error("Unsupported Project Brain lifecycle operation");
    const binding = (
      await getDatabasePool().query<{
        repository_id: string;
        observed_commit: string;
        execution_id: string;
        context_checksum: string | null;
        context_repository_path: string | null;
        agent_verification_status: string | null;
        execution_status: string;
        output_summary: string | null;
        base_commit: string | null;
        commit_id: string | null;
      }>(
        `SELECT r.repository_id,r.observed_commit,e.execution_id,p.context_checksum,
           p.context_repository_path,p.agent_verification_status,e.status AS execution_status,
           e.output_summary,e.base_commit,e.commit_id
         FROM repositories r
         JOIN execution_projections e ON e.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
         LEFT JOIN mission_project_brain_projections p ON p.workspace_id=e.workspace_id AND p.mission_id=e.mission_id
         WHERE e.workspace_id=$1 AND e.mission_id=$2 AND r.disabled_at IS NULL
         ORDER BY e.created_at DESC LIMIT 1`,
        [actionIdentity.workspaceId, missionId],
      )
    ).rows[0];
    if (!binding) throw new Error("Project Brain lifecycle is unavailable");
    let arguments_: Record<string, unknown>;
    if (operation === "initialize_repository") arguments_ = { repository_id: binding.repository_id };
    else if (operation === "record_closure") {
      if (
        binding.execution_status !== "succeeded" ||
        binding.agent_verification_status !== "verified" ||
        !binding.context_repository_path
      )
        throw new Error("Closure requires a succeeded execution with verified Project Brain context");
      arguments_ = {
        objective: missionObjective,
        role: "implementer",
        agent: "mission-agent",
        status: "completed",
        start_sha: binding.base_commit ?? binding.observed_commit,
        end_sha: binding.commit_id ?? binding.observed_commit,
        acceptance_criterion: missionSuccessCriteria.length ? missionSuccessCriteria : [missionObjective],
        acceptance_outcome: binding.output_summary ?? "Remote execution reported succeeded",
        evidence: [binding.context_repository_path],
        check: [`remote-execution=${binding.execution_status}`],
        context_checksum: binding.context_checksum,
      };
    } else if (operation === "propose_learning") {
      const closure = (
        await getDatabasePool().query<{ repository_path: string }>(
          `SELECT repository_path FROM remote_project_brain_artifacts
           WHERE workspace_id=$1 AND repository_id=$2 AND mission_id=$3 AND kind='mission_result'
           ORDER BY created_at DESC LIMIT 1`,
          [actionIdentity.workspaceId, binding.repository_id, missionId],
        )
      ).rows[0];
      if (!closure) throw new Error("Record mission closure before proposing a learning");
      arguments_ = {
        mission_id: closure.repository_path
          .split("/")
          .at(-1)
          ?.replace(/\.yaml$/, ""),
        title: "Retain verified mission practice",
        claim: `The verified workflow for ${missionObjective} should be retained for future repository work.`,
        scope: ["repository"],
        evidence: [`mission:${closure.repository_path}`],
        proposer: "mission-control",
        future_behavior: "Reuse only after human review of this proposal and its evidence.",
      };
    } else
      arguments_ = {
        reviewer: "independent-review",
        output: `.project-brain/evaluations/${missionId}.yaml`,
      };
    const lifecycleRequest = {
      repositoryId: binding.repository_id,
      missionId,
      executionId: binding.execution_id,
      operation: operation as "initialize_repository" | "record_closure" | "propose_learning" | "evaluate_learning",
      arguments: arguments_,
      startingSha: binding.observed_commit,
    };
    const requestedApproval = await requestProjectBrainWriteApproval({
      actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
      request: lifecycleRequest,
    });
    const approval = (
      await getDatabasePool().query<{ status: string }>(
        `SELECT status FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2`,
        [actionIdentity.workspaceId, requestedApproval.approvalId],
      )
    ).rows[0];
    if (approval?.status === "granted")
      await requestProjectBrainOperation({
        actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
        request: {
          ...lifecycleRequest,
          approvalId: requestedApproval.approvalId,
          idempotencyKey: `project-brain:${operation}:${requestedApproval.requestFingerprint}`,
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
      {mission.parentConsensusMissionId ? (
        <section className="project-brain-mission-shell" aria-label="Implementation role usage">
          <div className="command-panel project-brain-controls">
            <div className="panel-title">
              <div>
                <p className="section-label">Assignment-bound accounting</p>
                <h2>Executor and reviewer usage</h2>
              </div>
            </div>
            {Array.from(new Set(childRoleUsage.map((item) => item.role))).map((role) => {
              const rows = childRoleUsage.filter((item) => item.role === role);
              return (
                <div className="log-item" key={role}>
                  <span className="log-sequence">Σ</span>
                  <div>
                    <strong>{role.replaceAll("_", " ")}</strong>
                    <p>
                      {rows[0]?.provider_id} · {rows[0]?.model_id}
                    </p>
                    <small>
                      {rows
                        .filter((item) => item.metric_type)
                        .map(
                          (item) =>
                            `${item.metric_type} ${item.quantity ?? item.cost_amount ?? "unreported"} ${item.unit ?? item.currency ?? ""}`,
                        )
                        .join(" · ") || "No usage reported for this role"}
                    </small>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {registeredRepository || projectBrainProjection ? (
        <section className="project-brain-mission-shell" aria-label="Project Brain mission evidence">
          <ProjectBrainPanel projection={projectBrainProjection} />
          {execution.executions[0] ? (
            <div className="command-panel project-brain-controls">
              <div className="panel-title">
                <div>
                  <p className="section-label">Knowledge workflow</p>
                  <h2>Project Brain controls</h2>
                </div>
                <span>Approval governed</span>
              </div>
              <div className="project-brain-action-groups">
                <section className="project-brain-action-group" aria-labelledby="project-brain-context-actions">
                  <div>
                    <h3 id="project-brain-context-actions">Setup and context</h3>
                    <p>Prepare repository knowledge and inspect the exact context bound to this mission.</p>
                  </div>
                  <div className="project-brain-action-grid">
                    <form action={advanceProjectBrainLifecycle}>
                      <button name="operation" value="initialize_repository" type="submit">
                        Authorize or initialize
                      </button>
                    </form>
                    <form action={generateProjectBrainContext}>
                      <button type="submit">Authorize verified context</button>
                    </form>
                    <form action={previewProjectBrainContext}>
                      <button className="secondary" type="submit">
                        Preview context
                      </button>
                    </form>
                  </div>
                </section>
                <section className="project-brain-action-group" aria-labelledby="project-brain-lifecycle-actions">
                  <div>
                    <h3 id="project-brain-lifecycle-actions">Mission lifecycle</h3>
                    <p>Record closure and evaluate proposed learning after mission evidence is available.</p>
                  </div>
                  <form className="project-brain-action-grid" action={advanceProjectBrainLifecycle}>
                    <button name="operation" value="record_closure" type="submit">
                      Authorize closure
                    </button>
                    <button name="operation" value="propose_learning" type="submit">
                      Authorize learning proposal
                    </button>
                    <button name="operation" value="evaluate_learning" type="submit">
                      Authorize evaluation
                    </button>
                  </form>
                </section>
              </div>
            </div>
          ) : (
            <div className="command-panel project-brain-controls">
              <p>Context can be bound after an execution is assigned.</p>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
