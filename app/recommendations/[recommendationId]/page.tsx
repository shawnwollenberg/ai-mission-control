import Link from "next/link";
import { notFound } from "next/navigation";
import { getRecommendation } from "@/application/recommendation-queries";
import { requirePageIdentity } from "@/lib/page-auth";
import RecommendationActions from "./recommendation-actions";
export const dynamic = "force-dynamic";
export default async function RecommendationPage({ params }: { params: Promise<{ recommendationId: string }> }) {
  const { recommendationId } = await params;
  const identity = await requirePageIdentity(`/recommendations/${recommendationId}`);
  const r = await getRecommendation(identity.workspaceId, recommendationId);
  if (!r) notFound();
  return (
    <main className="launch-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Repository Recommendation</p>
        </div>
        <Link className="nav-link" href={`/missions/${r.sourceMissionId}`}>
          Source mission
        </Link>
      </nav>
      <section className="command-panel mission-summary">
        <div className="panel-title">
          <div>
            <p className="section-label">
              {r.repositoryName} · {r.status}
            </p>
            <h1>{r.title}</h1>
          </div>
          <span>
            {r.estimatedImpact} impact · {r.estimatedRisk} risk
          </span>
        </div>
        <p>{r.description}</p>
        <h2>Reasoning</h2>
        <p>{r.reasoning}</p>
        <h2>Evidence</h2>
        <ul>
          {r.evidence.map((e, index) => (
            <li key={`${e.path}:${index}`}>
              <code>
                {e.path}
                {e.line ? `:${e.line}` : ""}
              </code>
              {e.description ? ` — ${e.description}` : ""}
            </li>
          ))}
        </ul>
        <h2>Acceptance criteria</h2>
        <ul>
          {r.acceptanceCriteria.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <h2>Suggested validation</h2>
        <ul>
          {r.suggestedValidation.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        <p>
          Estimated effort: <strong>{r.estimatedEffort}</strong>
        </p>
        {r.linkedMissionId && (
          <p>
            Linked change mission: <Link href={`/missions/${r.linkedMissionId}`}>{r.linkedMissionId}</Link>
          </p>
        )}
        <RecommendationActions
          recommendationId={recommendationId}
          status={r.status}
          linkedMissionStatus={r.linkedMissionStatus}
        />
      </section>
    </main>
  );
}
