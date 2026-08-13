import Link from "next/link";
import { AppNavigation } from "@/app/app-navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
import { randomUUID } from "node:crypto";
import { scheduleControl } from "./actions";
export const dynamic = "force-dynamic";
export default async function SchedulesPage() {
  const identity = await requirePageIdentity("/schedules");
  const rows = (
    await getDatabasePool().query(
      `SELECT s.*,t.name template_name FROM schedule_projections s JOIN mission_template_projections t ON t.workspace_id=s.workspace_id AND t.template_id=s.template_id AND t.version=s.template_version WHERE s.workspace_id=$1 AND s.deleted_at IS NULL ORDER BY s.next_run_at NULLS LAST`,
      [identity.workspaceId],
    )
  ).rows;
  const runs = (
    await getDatabasePool().query(
      `SELECT r.*,s.name schedule_name FROM schedule_run_projections r JOIN schedule_projections s ON s.workspace_id=r.workspace_id AND s.schedule_id=r.schedule_id WHERE r.workspace_id=$1 ORDER BY r.intended_run_at DESC LIMIT 100`,
      [identity.workspaceId],
    )
  ).rows;
  return (
    <main className="archive-shell">
      <AppNavigation subtitle="Schedules" />
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
            <form action={scheduleControl}>
              <input type="hidden" name="scheduleId" value={row.schedule_id} />
              <input type="hidden" name="commandId" value={randomUUID()} />
              <button name="action" value="run_now" disabled={!row.enabled}>
                Run now
              </button>
              <button name="action" value={row.paused ? "resume" : "pause"}>
                {row.paused ? "Resume" : "Pause"}
              </button>
              <button name="action" value={row.enabled ? "disable" : "enable"}>
                {row.enabled ? "Disable" : "Enable"}
              </button>
              <button name="action" value="delete">
                Delete future schedule
              </button>
              <input name="name" defaultValue={row.name} aria-label="Schedule name" />
              <input
                name="templateVersion"
                type="number"
                min="1"
                defaultValue={row.template_version}
                aria-label="Future template version"
              />
              <button name="action" value="update">
                Update future configuration
              </button>
            </form>
          </div>
        ))}
      </section>
      <header className="archive-header">
        <div>
          <p className="section-label">Durable history</p>
          <h2>Schedule runs</h2>
        </div>
      </header>
      <section className="mission-table">
        {runs.map((run) => (
          <div className="mission-row" key={run.schedule_run_id}>
            <div>
              <strong>{run.schedule_name}</strong>
              <span>
                {run.trigger_type} · template v{run.template_version}
              </span>
            </div>
            <span>{run.status}</span>
            <span>{run.concurrency_decision ?? "—"}</span>
            <span>{run.reason ?? run.missed_run_decision ?? "—"}</span>
            {run.mission_id ? (
              <Link href={`/missions/${run.mission_id}`}>{String(run.mission_id).slice(0, 8)}</Link>
            ) : (
              <span>no mission</span>
            )}
            <time>{new Date(run.intended_run_at).toLocaleString()}</time>
          </div>
        ))}
      </section>
    </main>
  );
}
