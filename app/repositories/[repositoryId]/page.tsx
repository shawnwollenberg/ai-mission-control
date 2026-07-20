import Link from "next/link";
import { notFound } from "next/navigation";
import { listRepositoryRecommendations } from "@/application/recommendation-queries";
import { getDatabasePool } from "@/lib/database";
import { requirePageIdentity } from "@/lib/page-auth";
export const dynamic = "force-dynamic";
export default async function RepositoryPage({ params }: { params: Promise<{ repositoryId: string }> }) {
  const { repositoryId } = await params;
  const identity = await requirePageIdentity(`/repositories/${repositoryId}`);
  const repository = (
    await getDatabasePool().query(
      "SELECT repository_id,name,default_branch,observed_commit,observed_remote_url,created_at FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL",
      [identity.workspaceId, repositoryId],
    )
  ).rows[0];
  if (!repository) notFound();
  const recommendations = await listRepositoryRecommendations(identity.workspaceId, repositoryId);
  const counts = Object.fromEntries(
    ["open", "accepted", "in_progress", "completed", "stale", "dismissed"].map((status) => [
      status,
      recommendations.filter((r) => r.status === status).length,
    ]),
  );
  return (
    <main className="durable-mission-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Repository Health</p>
        </div>
        <Link className="nav-link" href="/">
          New Mission
        </Link>
      </nav>
      <header className="mission-header compact">
        <div>
          <p className="section-label">{repository.observed_remote_url || "Local repository"}</p>
          <h1>{repository.name}</h1>
          <p>
            {repository.default_branch} · commit {repository.observed_commit?.slice(0, 12) || "not observed"}
          </p>
        </div>
        <div className="status-badge">{counts.open + counts.accepted + counts.in_progress} actionable</div>
      </header>
      <section className="durable-grid">
        <section className="command-panel">
          <h2>Repository Health</h2>
          <p>
            Open recommendations: <strong>{counts.open}</strong>
          </p>
          <p>
            Accepted: <strong>{counts.accepted}</strong>
          </p>
          <p>
            In progress: <strong>{counts.in_progress}</strong>
          </p>
          <p>
            Completed: <strong>{counts.completed}</strong>
          </p>
          <p>
            Stale or dismissed: <strong>{counts.stale + counts.dismissed}</strong>
          </p>
          <small>
            A scored health model will follow; these counts are direct recommendation evidence, not a synthetic score.
          </small>
        </section>
        <section className="command-panel">
          <h2>Recommendations</h2>
          <div className="log-list">
            {recommendations.length ? (
              recommendations.map((r) => (
                <Link className="log-item" href={`/recommendations/${r.recommendationId}`} key={r.recommendationId}>
                  <span className="log-sequence">{r.estimatedImpact.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{r.title}</strong>
                    <small>
                      {r.status} · {r.estimatedRisk} risk · {r.estimatedEffort}
                    </small>
                    <p>{r.description}</p>
                  </div>
                </Link>
              ))
            ) : (
              <p>No structured recommendations yet. Run a Repository Analysis with Mission Agent 0.4.0.</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
