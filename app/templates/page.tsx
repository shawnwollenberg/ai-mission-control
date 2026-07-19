import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
export const dynamic = "force-dynamic";
export default async function TemplatesPage() {
  const identity = await requirePageIdentity("/templates");
  const templates = (
    await getDatabasePool().query(
      "SELECT template_id,version,name,description,domain,status,published_at FROM mission_template_projections WHERE workspace_id=$1 ORDER BY name,version DESC",
      [identity.workspaceId],
    )
  ).rows;
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Mission templates</p>
        </div>
        <Link className="nav-link" href="/schedules">
          Schedules
        </Link>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Reusable workflows</p>
          <h1>Launch common work without rebuilding every task.</h1>
        </div>
      </header>
      <section className="mission-table">
        {templates.map((row) => (
          <Link
            className="mission-row"
            key={`${row.template_id}:${row.version}`}
            href={`/templates/${row.template_id}?version=${row.version}`}
          >
            <div>
              <strong>{row.name}</strong>
              <span>{row.description}</span>
            </div>
            <span>v{row.version}</span>
            <span>{row.status}</span>
            <span>{row.domain.replaceAll("_", " ")}</span>
            <time>{row.published_at ? new Date(row.published_at).toLocaleString() : "Draft"}</time>
          </Link>
        ))}
      </section>
    </main>
  );
}
