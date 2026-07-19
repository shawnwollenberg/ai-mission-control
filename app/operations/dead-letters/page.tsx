import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
import { deadLetterAction } from "./actions";
export const dynamic = "force-dynamic";
export default async function DeadLettersPage() {
  const identity = await requirePageIdentity("/operations/dead-letters");
  const rows = (
    await getDatabasePool().query(
      `SELECT d.*,j.max_attempts,j.last_error,j.correlation_id FROM dead_letters d JOIN jobs j ON j.job_id=d.job_id WHERE d.workspace_id=$1 ORDER BY d.created_at DESC`,
      [identity.workspaceId],
    )
  ).rows;
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <Link className="nav-link" href="/operations">
          Operations
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Safe recovery</p>
          <h1>Dead-letter jobs</h1>
        </div>
      </header>
      <section className="mission-table">
        {rows.map((row) => (
          <div className="mission-row" key={row.job_id}>
            <div>
              <strong>{row.job_type}</strong>
              <span>
                {row.job_id} · {row.attempt_count}/{row.max_attempts} attempts
              </span>
              <span>{row.last_error?.message ?? row.error?.message ?? "No safe error summary"}</span>
            </div>
            <span>{row.reviewed_at ? "reviewed" : row.cancelled_at ? "cancelled" : "recoverable"}</span>
            <form action={deadLetterAction}>
              <input type="hidden" name="jobId" value={row.job_id} />
              <input type="hidden" name="commandId" value={randomUUID()} />
              <button name="action" value="retry">
                Retry
              </button>
              <button name="action" value="cancel">
                Cancel
              </button>
              <button name="action" value="review">
                Mark reviewed
              </button>
            </form>
          </div>
        ))}
      </section>
    </main>
  );
}
