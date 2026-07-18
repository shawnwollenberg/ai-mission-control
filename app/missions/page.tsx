import { requirePageIdentity } from "@/lib/page-auth";
import Link from "next/link";
import { listMissionsForWorkspace } from "@/lib/mission-queries";
import { BrandSprite } from "@/app/brand-assets";

export const dynamic = "force-dynamic";

export default async function MissionListPage() {
  const identity = await requirePageIdentity("/missions");
  const missions = await listMissionsForWorkspace(identity.workspaceId);
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Durable mission archive</p>
        </div>
        <Link className="nav-link" href="/">
          New mission
        </Link>
        <Link className="nav-link" href="/approvals">
          Approvals
        </Link>
        <a className="nav-link" href="/logout">
          Log out
        </a>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Mission archive</p>
          <h1>Recorded outcomes and active work.</h1>
        </div>
        <Link className="primary-link" href="/">
          Launch mission →
        </Link>
      </header>
      {missions.length ? (
        <section className="mission-table">
          {missions.map((mission) => (
            <Link className="mission-row" href={`/missions/${mission.missionId}`} key={mission.missionId}>
              <div>
                <strong>{mission.name}</strong>
                <span>{mission.domain.replaceAll("_", " ")}</span>
              </div>
              <span>{mission.status}</span>
              <span>{mission.priority}</span>
              <span>{mission.riskLevel} risk</span>
              <time>{new Date(mission.updatedAt).toLocaleString()}</time>
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
