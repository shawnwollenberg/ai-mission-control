import Link from "next/link";
import { AppNavigation } from "@/app/app-navigation";
import { repositoryHealthDimensions } from "@/domain/repository-health";
import { getDatabasePool } from "@/lib/database";
import { requirePageIdentity } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

const dimensionLabels: Record<string, string> = {
  architecture: "Architecture",
  tests: "Tests",
  security: "Security",
  technical_debt: "Technical debt",
  documentation: "Documentation",
  dependencies: "Dependencies",
  ci: "CI",
};

type RepositoryRow = {
  repository_id: string;
  name: string;
  default_branch: string;
  observed_commit: string | null;
  observed_remote_url: string | null;
  updated_at: Date;
  score: number | null;
  confidence: number | null;
  scoring_version: string | null;
  dimensions: Record<string, { score: number | null; status: string; observationCount: number }> | null;
  assessed_at: Date | null;
  actionable_recommendations: number;
  mission_count: number;
};

export default async function RepositoriesPage() {
  const identity = await requirePageIdentity("/repositories");
  const repositories = (
    await getDatabasePool().query<RepositoryRow>(
      `SELECT r.repository_id,r.name,r.default_branch,r.observed_commit,r.observed_remote_url,r.updated_at,
        health.score,health.confidence,health.scoring_version,health.dimensions,health.assessed_at,
        (SELECT count(*)::int FROM recommendation_projections recommendation
         WHERE recommendation.workspace_id=r.workspace_id AND recommendation.repository_id=r.repository_id
           AND recommendation.status IN ('open','accepted','in_progress')) actionable_recommendations,
        (SELECT count(DISTINCT execution.mission_id)::int FROM execution_projections execution
         WHERE execution.workspace_id=r.workspace_id AND execution.repository_id=r.repository_id) mission_count
       FROM repositories r
       LEFT JOIN LATERAL (
         SELECT score,confidence,scoring_version,dimensions,assessed_at
         FROM repository_health_assessments assessment
         WHERE assessment.workspace_id=r.workspace_id AND assessment.repository_id=r.repository_id
         ORDER BY assessed_at DESC,assessment_id DESC LIMIT 1
       ) health ON true
       WHERE r.workspace_id=$1 AND r.disabled_at IS NULL
       ORDER BY r.updated_at DESC,r.repository_id`,
      [identity.workspaceId],
    )
  ).rows;

  return (
    <main className="archive-shell repository-index-shell">
      <AppNavigation subtitle="Repositories" />
      <header className="archive-header repository-index-header">
        <div>
          <p className="section-label">Repository overview</p>
          <h1>Health, confidence, and next work.</h1>
          <p>Scores are calculated from evidence-backed observations. Select a repository for its full history.</p>
        </div>
        <details className="repository-add-help repository-index-add">
          <summary>Add repository</summary>
          <div>
            <strong>Run this on the computer hosting Mission Agent</strong>
            <code>mission-agent repository add /absolute/path/to/repository</code>
            <p>
              Mission Agent validates the checkout and registers it only with your authenticated workspace. Git
              credentials remain on that computer.
            </p>
            <p>Refresh this page after the command confirms registration.</p>
          </div>
        </details>
      </header>

      {repositories.length ? (
        <section className="repository-index-grid" aria-label="Registered repositories">
          {repositories.map((repository) => (
            <article className="repository-index-card" key={repository.repository_id}>
              <div className="repository-card-heading">
                <div>
                  <p>{repository.observed_remote_url || "Local repository"}</p>
                  <h2>
                    <Link href={`/repositories/${repository.repository_id}`}>{repository.name}</Link>
                  </h2>
                  <small>
                    {repository.default_branch} ·{" "}
                    {repository.observed_commit ? repository.observed_commit.slice(0, 12) : "commit not observed"}
                  </small>
                </div>
                <details className="repository-score-explanation">
                  <summary
                    aria-label={
                      repository.score == null
                        ? `Explain unavailable confidence score for ${repository.name}`
                        : `Explain ${repository.score} health score for ${repository.name}`
                    }
                  >
                    <strong>{repository.score ?? "—"}</strong>
                    <span>/ 100</span>
                    <small>
                      {repository.confidence == null ? "Not assessed" : `${repository.confidence}% confidence`}
                    </small>
                  </summary>
                  <div>
                    <p className="section-label">Why this score</p>
                    {repository.dimensions ? (
                      <ul>
                        {repositoryHealthDimensions.map((dimension) => {
                          const value = repository.dimensions?.[dimension];
                          return (
                            <li key={dimension}>
                              <span>{dimensionLabels[dimension]}</span>
                              <strong>{value?.score == null ? "Unknown" : `${value.score} / 100`}</strong>
                              <small>{value?.status?.replaceAll("_", " ") || "No evidence"}</small>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p>Run a Repository Analysis to establish evidence and confidence.</p>
                    )}
                    <small>
                      {repository.assessed_at
                        ? `${repository.scoring_version} · assessed ${repository.assessed_at.toLocaleString()}`
                        : "Unknown dimensions lower confidence; they are not treated as failures."}
                    </small>
                    <Link href={`/repositories/${repository.repository_id}#health-evidence`}>
                      View complete evidence →
                    </Link>
                  </div>
                </details>
              </div>
              <div className="repository-card-stats">
                <span>{repository.actionable_recommendations} actionable recommendations</span>
                <span>{repository.mission_count} missions</span>
              </div>
              <div className="repository-card-missions">
                <Link href={`/?type=analysis&repository=${repository.repository_id}`}>Analyze</Link>
                <Link href={`/?type=change&repository=${repository.repository_id}`}>Change</Link>
                <Link href={`/?type=consensus&repository=${repository.repository_id}`}>Consensus</Link>
              </div>
              <Link className="button-primary repository-open-link" href={`/repositories/${repository.repository_id}`}>
                View repository →
              </Link>
            </article>
          ))}
        </section>
      ) : (
        <section className="empty-state">
          <h2>No repositories connected.</h2>
          <p>Use Add repository above to connect a local checkout through Mission Agent.</p>
        </section>
      )}
    </main>
  );
}
