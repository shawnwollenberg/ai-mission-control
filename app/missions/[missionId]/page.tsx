import { notFound } from "next/navigation";
import { getMission } from "@/lib/mission-store";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const mission = getMission(missionId);
  if (!mission) notFound();

  return (
    <main className="mission-shell">
      <nav className="brandbar">
        <div className="brandmark">MC</div>
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Live organization command</p>
        </div>
        <div className="system-status"><span /> Live</div>
      </nav>

      <header className="mission-header">
        <div>
          <p className="section-label">Mission / {mission.id.slice(0, 8)}</p>
          <h1>{mission.objective}</h1>
        </div>
        <div className="mission-facts">
          <div><span>Status</span><strong>Planning</strong></div>
          <div><span>Deadline</span><strong>{mission.deadline}</strong></div>
          <div><span>Priority</span><strong>{mission.priority}</strong></div>
          <div><span>Coordinator</span><strong>{mission.commander}</strong></div>
        </div>
      </header>

      <section className="planning-panel">
        <div className="orbital-loader" aria-hidden><span /></div>
        <p className="section-label">Organization forming</p>
        <h2>Hermes is identifying objectives.</h2>
        <p>Analyzing desired outcome, constraints, capabilities, and available resources.</p>
        <div className="scan-line" />
      </section>
    </main>
  );
}
