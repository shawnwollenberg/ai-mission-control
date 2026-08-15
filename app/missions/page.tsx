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
  const activeFilterCount = [
    query.status,
    query.domain,
    query.template,
    query.schedule,
    query.origin,
    query.agent,
    query.runtime,
    query.repository,
    query.approval,
    query.failed,
    query.blocked,
    query.openPr,
    query.unknownCost,
  ].filter(Boolean).length;
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
  const activeMissions = missions.filter((mission) => mission.status === "running");
  const attentionMissions = missions.filter((mission) => ["paused", "failed"].includes(mission.status));
  const completedMissions = missions.filter((mission) => ["completed", "failed", "cancelled"].includes(mission.status));
  return (
    <main className="archive-shell">
      <AppNavigation subtitle="Mission operations" />
      <header className="archive-header">
        <div>
          <p className="section-label">Mission operations</p>
          <h1>Active work, decisions, and outcomes.</h1>
          <p className="archive-lede">Move between live missions without losing the evidence trail.</p>
        </div>
        <Link className="primary-link" href="/">
          New mission →
        </Link>
      </header>
      <section className="mission-overview-grid" aria-label="Mission overview">
        <Link className="mission-overview-card" href="/missions?status=running">
          <span>Active now</span>
          <strong>{activeMissions.length}</strong>
          <small>Running missions in this view</small>
        </Link>
        <Link className="mission-overview-card mission-overview-card-attention" href="/missions?status=paused">
          <span>Needs attention</span>
          <strong>{attentionMissions.length}</strong>
          <small>Paused or failed missions</small>
        </Link>
        <div className="mission-overview-card">
          <span>Recorded outcomes</span>
          <strong>{completedMissions.length}</strong>
          <small>Completed, failed, or cancelled in this view</small>
        </div>
      </section>
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
          <div className="mission-table-heading" aria-hidden="true">
            <span>Mission</span>
            <span>Status</span>
            <span>Priority</span>
            <span>Risk</span>
            <span>Updated</span>
          </div>
          {missions.map((mission) => (
            <Link className="mission-row" href={`/missions/${mission.mission_id}`} key={mission.mission_id}>
              <div>
                <strong>{mission.name}</strong>
                <span>{mission.domain.replaceAll("_", " ")}</span>
              </div>
              <span className={`mission-status mission-status-${mission.status}`} data-label="Status">
                {mission.status}
              </span>
              <span data-label="Priority">{mission.priority}</span>
              <span data-label="Risk">{mission.risk_level} risk</span>
              <time data-label="Updated">{new Date(mission.updated_at).toLocaleString()}</time>
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
