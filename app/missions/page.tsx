import { requirePageIdentity } from "@/lib/page-auth";
import Link from "next/link";
import { searchMissions } from "@/application/mission-search";
import { AppNavigation } from "@/app/app-navigation";

export const dynamic = "force-dynamic";

export default async function MissionListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requirePageIdentity("/missions");
  const query = await searchParams;
  const activeFilterCount = [query.status, query.origin, query.unknownCost].filter(Boolean).length;
  const missions = await searchMissions(identity.workspaceId, {
    query: query.q,
    status: query.status,
    domain: query.domain,
    templateId: query.template,
    scheduleId: query.schedule,
    origin: query.origin as "manual" | "scheduled" | undefined,
    agentId: query.agent,
    runtime: query.runtime,
    repository: query.repository,
    approvalState: query.approval,
    failed: query.failed === "true",
    blocked: query.blocked === "true",
    hasOpenPr: query.openPr === "true",
    hasUnknownCost: query.unknownCost === "true",
  });
  return (
    <main className="archive-shell">
      <AppNavigation subtitle="Durable mission archive" />
      <header className="archive-header">
        <div>
          <p className="section-label">Mission archive</p>
          <h1>Recorded outcomes and active work.</h1>
        </div>
        <Link className="primary-link" href="/">
          Launch mission →
        </Link>
      </header>
      <form className="mission-search-form" method="get">
        <label className="mission-search-field">
          Safe mission search
          <input name="q" defaultValue={query.q} placeholder="ID, name, or objective" />
        </label>
        <details className="mission-filter-disclosure" open={activeFilterCount > 0}>
          <summary>
            <span>Filters</span>
            <small>{activeFilterCount ? `${activeFilterCount} active` : "Status, origin, and cost"}</small>
          </summary>
          <div className="mission-filter-row">
            <label>
              Status
              <select name="status" defaultValue={query.status ?? ""}>
                <option value="">Any</option>
                {["draft", "planned", "running", "paused", "completed", "failed", "cancelled"].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            <label>
              Origin
              <select name="origin" defaultValue={query.origin ?? ""}>
                <option value="">Any</option>
                <option value="manual">Manual</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </label>
            <label>
              Cost
              <select name="unknownCost" defaultValue={query.unknownCost ?? ""}>
                <option value="">Any</option>
                <option value="true">Unknown cost</option>
              </select>
            </label>
            <button type="submit">Apply filters</button>
          </div>
        </details>
      </form>
      {missions.length ? (
        <section className="mission-table">
          {missions.map((mission) => (
            <Link className="mission-row" href={`/missions/${mission.mission_id}`} key={mission.mission_id}>
              <div>
                <strong>{mission.name}</strong>
                <span>{mission.domain.replaceAll("_", " ")}</span>
              </div>
              <span>{mission.status}</span>
              <span>{mission.priority}</span>
              <span>{mission.risk_level} risk</span>
              <time>{new Date(mission.updated_at).toLocaleString()}</time>
            </Link>
          ))}
        </section>
      ) : (
        <section className="empty-state">
          <h2>No missions recorded.</h2>
          <p>Launch the first durable mission for this workspace.</p>
          <Link className="primary-link" href="/">
            Create mission →
          </Link>
        </section>
      )}
    </main>
  );
}
