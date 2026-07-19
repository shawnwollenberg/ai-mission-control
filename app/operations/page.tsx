import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { operationsDashboard } from "@/application/operations-dashboard";
export const dynamic = "force-dynamic";
export default async function OperationsPage() {
  const identity = await requirePageIdentity("/operations");
  const dashboard = await operationsDashboard(identity.workspaceId);
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Operations</p>
        </div>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
        <Link className="nav-link" href="/schedules">
          Schedules
        </Link>
        <Link className="nav-link" href="/notifications">
          Notifications
        </Link>
        <Link className="nav-link" href="/operations/dead-letters">
          Dead letters
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Attention queue</p>
          <h1>What needs my attention right now?</h1>
        </div>
      </header>
      <section className="metric-grid">
        {Object.entries(dashboard.attention).map(([label, value]) => (
          <article className="metric-card" key={label}>
            <span>{label.replaceAll("_", " ")}</span>
            <strong>{String(value)}</strong>
          </article>
        ))}
      </section>
      <header className="archive-header">
        <div>
          <p className="section-label">Current activity</p>
          <h2>{dashboard.activity.length} active missions</h2>
        </div>
      </header>
      <section className="mission-table">
        {dashboard.activity.map((mission) => (
          <Link className="mission-row" href={`/missions/${mission.mission_id}`} key={mission.mission_id}>
            <strong>{mission.name}</strong>
            <span>{mission.status}</span>
            <span>{mission.domain}</span>
            <time>{new Date(mission.updated_at).toLocaleString()}</time>
          </Link>
        ))}
      </section>
      <header className="archive-header">
        <div>
          <p className="section-label">Workers</p>
          <h2>{dashboard.unhealthyWorkers.length} unhealthy</h2>
        </div>
      </header>
      <section className="mission-table">
        {dashboard.workers.map((worker) => (
          <div className="mission-row" key={worker.worker_id}>
            <strong>{worker.worker_type}</strong>
            <span>{worker.calculated_status}</span>
            <span>{worker.ready ? "ready" : "not ready"}</span>
            <time>{new Date(worker.last_heartbeat).toLocaleString()}</time>
          </div>
        ))}
      </section>
      <header className="archive-header">
        <div>
          <p className="section-label">Upcoming work</p>
          <h2>Next scheduled runs</h2>
        </div>
      </header>
      <section className="mission-table">
        {dashboard.upcoming.map((schedule) => (
          <div className="mission-row" key={schedule.schedule_id}>
            <strong>{schedule.name}</strong>
            <span>{schedule.last_run_status ?? "not run"}</span>
            <time>{schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "none"}</time>
          </div>
        ))}
      </section>
      <header className="archive-header">
        <div>
          <p className="section-label">Usage</p>
          <h2>Known cost is incomplete when unknown executions exist.</h2>
        </div>
      </header>
      <section className="metric-grid">
        {Object.entries(dashboard.usage).map(([label, value]) => (
          <article className="metric-card" key={label}>
            <span>{label.replaceAll("_", " ")}</span>
            <strong>{String(value)}</strong>
          </article>
        ))}
      </section>
    </main>
  );
}
