import Link from "next/link";
import { AppNavigation } from "@/app/app-navigation";
import { notFound } from "next/navigation";
import { listRepositoryRecommendations } from "@/application/recommendation-queries";
import { listRepositoryHealthAssessments, listRepositoryTimeline } from "@/application/repository-health-queries";
import { repositoryHealthDimensions } from "@/domain/repository-health";
import { getDatabasePool } from "@/lib/database";
import { requirePageIdentity } from "@/lib/page-auth";
import { ProjectBrainPanel } from "@/integrations/project-brain/project-brain-panel";
import { requestProjectBrainOperation } from "@/application/project-brain-commands";
import { requestProjectBrainWriteApproval } from "@/application/project-brain-commands";
import { handleCreateMission } from "@/application/mission-commands";
import { stableUuid } from "@/lib/stable-id";
import { revalidatePath } from "next/cache";
export const dynamic = "force-dynamic";

const labels: Record<string, string> = {
  architecture: "Architecture",
  tests: "Tests",
  security: "Security",
  technical_debt: "Technical debt",
  documentation: "Documentation",
  dependencies: "Dependencies",
  ci: "CI",
};

export default async function RepositoryPage({ params }: { params: Promise<{ repositoryId: string }> }) {
  const { repositoryId } = await params;
  const identity = await requirePageIdentity(`/repositories/${repositoryId}`);
  const repository = (
    await getDatabasePool().query<{
      repository_id: string;
      name: string;
      default_branch: string;
      observed_commit: string | null;
      observed_remote_url: string | null;
      local_path: string;
    }>(
      "SELECT repository_id,name,default_branch,observed_commit,observed_remote_url,local_path FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL",
      [identity.workspaceId, repositoryId],
    )
  ).rows[0];
  if (!repository) notFound();
  const [recommendations, assessments, timeline] = await Promise.all([
    listRepositoryRecommendations(identity.workspaceId, repositoryId),
    listRepositoryHealthAssessments(identity.workspaceId, repositoryId),
    listRepositoryTimeline(identity.workspaceId, repositoryId),
  ]);
  const current = assessments[0];
  const previous = assessments[1];
  const delta = current?.score != null && previous?.score != null ? current.score - previous.score : undefined;
  const actionable = recommendations.filter((item) => ["open", "accepted", "in_progress"].includes(item.status));
  const projectBrainProjection = (
    await getDatabasePool().query<Record<string, unknown>>(
      "SELECT * FROM repository_project_brain_projections WHERE workspace_id=$1 AND repository_id=$2",
      [identity.workspaceId, repositoryId],
    )
  ).rows[0];
  const learningInbox = (
    await getDatabasePool().query<{
      kind: string;
      repository_path: string;
      sha256: string;
      created_at: Date;
      content: Buffer;
    }>(
      `SELECT kind,repository_path,sha256,created_at,content FROM remote_project_brain_artifacts
       WHERE workspace_id=$1 AND repository_id=$2 AND kind IN('proposed_learning','knowledge_evaluation')
       ORDER BY created_at DESC`,
      [identity.workspaceId, repositoryId],
    )
  ).rows.map((item) => ({
    kind: item.kind,
    path: item.repository_path,
    checksum: item.sha256,
    receivedAt: item.created_at,
    authoritativeContent: item.content.toString("utf8"),
  }));
  async function inspectProjectBrain(formData: FormData) {
    "use server";
    const actionIdentity = await requirePageIdentity(`/repositories/${repositoryId}`);
    const operation = String(formData.get("operation"));
    if (!["detect_repository", "validate_repository", "list_knowledge", "get_health"].includes(operation))
      throw new Error("Unsupported Project Brain inspection");
    const current = (
      await getDatabasePool().query<{ observed_commit: string }>(
        `SELECT observed_commit FROM repositories
         WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
        [actionIdentity.workspaceId, repositoryId],
      )
    ).rows[0];
    if (!current) throw new Error("Repository is unavailable");
    await requestProjectBrainOperation({
      actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
      request: {
        repositoryId,
        operation: operation as "detect_repository" | "validate_repository" | "list_knowledge" | "get_health",
        startingSha: current.observed_commit,
        idempotencyKey: `project-brain:${operation}:${repositoryId}:${current.observed_commit}`,
      },
    });
    revalidatePath(`/repositories/${repositoryId}`);
  }
  async function initializeProjectBrain() {
    "use server";
    const actionIdentity = await requirePageIdentity(`/repositories/${repositoryId}`);
    const current = (
      await getDatabasePool().query<{ observed_commit: string }>(
        `SELECT observed_commit FROM repositories
         WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
        [actionIdentity.workspaceId, repositoryId],
      )
    ).rows[0];
    if (!current) throw new Error("Repository is unavailable");
    const setup = await handleCreateMission({
      actor: actionIdentity,
      commandId: stableUuid(`project-brain-initialization-mission:${actionIdentity.workspaceId}:${repositoryId}`),
      mission: {
        name: `Initialize Project Brain for ${repository.name}`,
        objective: `Explicitly initialize repository knowledge for ${repository.name}`,
        domain: "software_delivery",
        priority: "normal",
        riskLevel: "moderate",
        successCriteria: ["Project Brain initialization validates in the registered repository"],
        constraints: ["No source-code, publication, merge, or deployment authority"],
      },
    });
    const request = {
      repositoryId,
      missionId: setup.missionId,
      operation: "initialize_repository" as const,
      arguments: { repository_id: repositoryId },
      startingSha: current.observed_commit,
    };
    const requestedApproval = await requestProjectBrainWriteApproval({
      actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
      request,
    });
    const approval = (
      await getDatabasePool().query<{ status: string }>(
        "SELECT status FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
        [actionIdentity.workspaceId, requestedApproval.approvalId],
      )
    ).rows[0];
    if (approval?.status === "granted")
      await requestProjectBrainOperation({
        actor: { workspaceId: actionIdentity.workspaceId, id: actionIdentity.userId, type: "human" },
        request: {
          ...request,
          approvalId: requestedApproval.approvalId,
          idempotencyKey: `project-brain:initialize:${requestedApproval.requestFingerprint}`,
        },
      });
    revalidatePath(`/repositories/${repositoryId}`);
  }
  return (
    <main className="durable-mission-shell">
      <AppNavigation subtitle="Repository detail" />
      <header className="mission-header compact">
        <div>
          <p className="section-label">{repository.observed_remote_url || "Local repository"}</p>
          <h1>{repository.name}</h1>
          <p>
            {repository.default_branch} · commit {repository.observed_commit?.slice(0, 12) || "not observed"}
          </p>
        </div>
        <div
          className="health-score"
          aria-label={
            current?.score == null ? "Repository health unknown" : `Repository health ${current.score} out of 100`
          }
        >
          <strong>{current?.score ?? "—"}</strong>
          <span>/ 100</span>
          <small>{current ? `${current.confidence}% confidence` : "Run an analysis"}</small>
        </div>
      </header>

      <section className="health-summary-grid">
        <details className="repository-knowledge-details">
          <summary>Project Brain knowledge and controls</summary>
          <div className="repository-knowledge-panel">
            <ProjectBrainPanel
              projection={projectBrainProjection}
              projectedStatus={String(projectBrainProjection?.last_operation_status ?? "not refreshed")}
              inbox={{
                proposals: learningInbox.filter((item) => item.kind === "proposed_learning"),
                evaluations: learningInbox.filter((item) => item.kind === "knowledge_evaluation"),
                promotionAvailable: false,
              }}
            />
            <form action={inspectProjectBrain}>
              <button name="operation" value="detect_repository" type="submit">
                Detect Project Brain
              </button>
              <button name="operation" value="validate_repository" type="submit">
                Validate Project Brain
              </button>
              <button name="operation" value="list_knowledge" type="submit">
                Refresh learning inbox
              </button>
              <button name="operation" value="get_health" type="submit">
                Refresh knowledge health
              </button>
            </form>
            <form action={initializeProjectBrain}>
              <button type="submit">Authorize or initialize Project Brain</button>
            </form>
          </div>
        </details>
        <article className="command-panel">
          <p className="section-label">Repository Health</p>
          <h2>
            {current?.score == null
              ? "Not assessed"
              : current.score >= 85
                ? "Healthy"
                : current.score >= 70
                  ? "Needs attention"
                  : "At risk"}
          </h2>
          <p>{actionable.length} open recommendations</p>
          {delta !== undefined ? (
            <p>
              <strong>
                {delta > 0 ? "+" : ""}
                {delta}
              </strong>{" "}
              since the previous comparable assessment
            </p>
          ) : (
            <p>Complete another analysis to establish a health trend.</p>
          )}
          {current ? (
            <small>
              Scoring: {current.scoringVersion} · assessed {new Date(current.assessedAt).toLocaleString()}
            </small>
          ) : (
            <small>Health is calculated from evidence-backed observations. Missing dimensions remain unknown.</small>
          )}
        </article>
        <article className="command-panel">
          <p className="section-label">Health dimensions</p>
          <div className="health-dimensions">
            {repositoryHealthDimensions.map((dimension) => {
              const value = current?.dimensions[dimension];
              return (
                <div key={dimension}>
                  <span>{labels[dimension]}</span>
                  <strong>
                    {value?.score ?? "Unknown"}
                    {value?.score == null ? "" : " / 100"}
                  </strong>
                  <small>{value?.status?.replace("_", " ") ?? "No evidence"}</small>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section className="durable-grid repository-intelligence-grid">
        <section className="command-panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">Act next</p>
              <h2>Recommendations</h2>
            </div>
            <span>{actionable.length} actionable</span>
          </div>
          <div className="log-list">
            {recommendations.length ? (
              recommendations.map((item) => (
                <Link
                  className="log-item"
                  href={`/recommendations/${item.recommendationId}`}
                  key={item.recommendationId}
                >
                  <span className="log-sequence">{item.estimatedImpact.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.status} · {item.estimatedRisk} risk · {item.estimatedEffort}
                    </small>
                    <p>{item.description}</p>
                  </div>
                </Link>
              ))
            ) : (
              <p>No structured recommendations yet. Update Mission Agent and run a Repository Analysis.</p>
            )}
          </div>
        </section>
        <section className="command-panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">System of record</p>
              <h2>Repository Timeline</h2>
            </div>
            <span>{timeline.length} events</span>
          </div>
          <ol className="repository-timeline">
            {timeline.length ? (
              timeline.map((item) => (
                <li key={`${item.item_type}-${item.item_id}`}>
                  <time>{new Date(item.occurred_at).toLocaleString()}</time>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.item_type.replace("_", " ")} · {item.status.replace("_", " ")}
                    </small>
                    <p>{item.detail}</p>
                    {item.mission_id ? <Link href={`/missions/${item.mission_id}`}>View mission →</Link> : null}
                  </div>
                </li>
              ))
            ) : (
              <p>No repository missions have been recorded yet.</p>
            )}
          </ol>
        </section>
      </section>

      {current ? (
        <section className="command-panel repository-evidence" id="health-evidence">
          <div className="panel-heading">
            <div>
              <p className="section-label">Why this score</p>
              <h2>Evidence-backed observations</h2>
            </div>
            <Link href={`/missions/${current.sourceMissionId}`}>Source analysis →</Link>
          </div>
          <div className="evidence-grid">
            {current.observations.map((observation, index) => (
              <article key={`${observation.dimension}-${index}`}>
                <span>
                  {labels[observation.dimension]} · {observation.status} · {observation.severity}
                </span>
                <p>{observation.summary}</p>
                {observation.evidence.map((evidence) => (
                  <code key={`${evidence.path}-${evidence.line ?? 0}`}>
                    {evidence.path}
                    {evidence.line ? `:${evidence.line}` : ""}
                  </code>
                ))}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
