import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { listGovernanceAudit } from "@/application/governance-queries";
export const dynamic = "force-dynamic";
export default async function AuditPage() {
  const identity = await requirePageIdentity("/audit");
  const events = await listGovernanceAudit(identity.workspaceId);
  return (
    <main className="durable-mission-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Governance audit</p>
        </div>
        <Link className="nav-link" href="/approvals">
          Approvals
        </Link>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
      </nav>
      <header className="mission-header compact">
        <div>
          <p className="section-label">Durable history</p>
          <h1>Sensitive-action audit</h1>
          <p>Canonical policy, approval, and action facts.</p>
        </div>
      </header>
      <section className="log-list">
        {events.map((event) => (
          <article className="log-item" key={event.event_id}>
            <span className="log-sequence">{event.position}</span>
            <div>
              <strong>{event.event_type}</strong>
              <small>
                {event.actor_type}:{event.actor_id} · {new Date(event.occurred_at).toLocaleString()}
              </small>
              <p>
                Resource {event.aggregate_id} · correlation {event.correlation_id}
              </p>
              <details>
                <summary>Sanitized evidence</summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
              {event.mission_id && <Link href={`/missions/${event.mission_id}`}>View mission</Link>}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
