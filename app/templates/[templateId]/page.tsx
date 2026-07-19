import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
export const dynamic = "force-dynamic";
export default async function TemplateDetail({
  params,
  searchParams,
}: {
  params: Promise<{ templateId: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const identity = await requirePageIdentity("/templates"),
    { templateId } = await params,
    { version } = await searchParams;
  const row = (
    await getDatabasePool().query(
      "SELECT * FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND ($3::int IS NULL OR version=$3) ORDER BY version DESC LIMIT 1",
      [identity.workspaceId, templateId, version ? Number(version) : null],
    )
  ).rows[0];
  if (!row) notFound();
  const history = (
    await getDatabasePool().query(
      "SELECT version,status,created_at,published_at,deprecated_at FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 ORDER BY version DESC",
      [identity.workspaceId, templateId],
    )
  ).rows;
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <Link className="nav-link" href="/templates">
          Templates
        </Link>
        <Link className="nav-link" href="/schedules">
          Schedules
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">
            {row.domain.replaceAll("_", " ")} · v{row.version} · {row.status}
          </p>
          <h1>{row.name}</h1>
          <p>{row.description}</p>
        </div>
      </header>
      <section className="panel">
        <h2>Input schema</h2>
        <pre>{JSON.stringify(row.input_schema, null, 2)}</pre>
        <h2>Resolved task definition</h2>
        <pre>{JSON.stringify(row.task_definitions, null, 2)}</pre>
        <h2>Version history</h2>
        <pre>{JSON.stringify(history, null, 2)}</pre>
      </section>
    </main>
  );
}
