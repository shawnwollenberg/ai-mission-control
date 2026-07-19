import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
export const dynamic = "force-dynamic";
export default async function SchedulesPage() {
  const identity = await requirePageIdentity("/schedules");
  const rows = (
    await getDatabasePool().query(
      `SELECT s.*,t.name template_name FROM schedule_projections s JOIN mission_template_projections t ON t.workspace_id=s.workspace_id AND t.template_id=s.template_id AND t.version=s.template_version WHERE s.workspace_id=$1 AND s.deleted_at IS NULL ORDER BY s.next_run_at NULLS LAST`,
      [identity.workspaceId],
    )
  ).rows;
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Schedules</p>
        </div>
        <Link className="nav-link" href="/templates">
          Templates
        </Link>
        <Link className="nav-link" href="/notifications">
          Notifications
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Unattended operations</p>
          <h1>Upcoming and recent scheduled work.</h1>
        </div>
      </header>
      <section className="mission-table">
        {rows.map((row) => (
          <div className="mission-row" key={row.schedule_id}>
            <div>
              <strong>{row.name}</strong>
              <span>
                {row.template_name} v{row.template_version}
              </span>
            </div>
            <span>{row.enabled ? "enabled" : "paused"}</span>
            <span>{row.concurrency_policy}</span>
            <span>{row.last_run_status ?? "not run"}</span>
            <time>{row.next_run_at ? new Date(row.next_run_at).toLocaleString() : "Complete"}</time>
          </div>
        ))}
      </section>
    </main>
  );
}
