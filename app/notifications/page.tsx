import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
export const dynamic = "force-dynamic";
export default async function NotificationsPage() {
  const identity = await requirePageIdentity("/notifications");
  const rows = (
    await getDatabasePool().query(
      "SELECT * FROM notification_projections WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
      [identity.workspaceId],
    )
  ).rows;
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <Link className="nav-link" href="/schedules">
          Schedules
        </Link>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Notification center</p>
          <h1>{rows.filter((row) => !row.read_at).length} items need review.</h1>
        </div>
      </header>
      <section className="mission-table">
        {rows.map((row) => (
          <Link
            className="mission-row"
            key={row.notification_id}
            href={row.mission_id ? `/missions/${row.mission_id}` : "/schedules"}
          >
            <div>
              <strong>{row.title}</strong>
              <span>{row.summary}</span>
            </div>
            <span>{row.severity}</span>
            <span>{row.category}</span>
            <span>{row.read_at ? "read" : "unread"}</span>
            <time>{new Date(row.created_at).toLocaleString()}</time>
          </Link>
        ))}
      </section>
    </main>
  );
}
