"use client";

import { useEffect, useMemo, useState } from "react";
import { APPROVAL_EVENTS, OPENING_EVENTS, projectMission, type MissionEvent } from "@/lib/mission-events";
import type { Mission } from "@/lib/mission-store";

export default function MissionConsole({ mission }: { mission: Mission }) {
  const [visibleCount, setVisibleCount] = useState(1);
  const [approved, setApproved] = useState(false);
  const [completionCount, setCompletionCount] = useState(0);

  const events = useMemo(() => {
    const opening = OPENING_EVENTS.slice(0, visibleCount);
    return approved ? [...opening, ...APPROVAL_EVENTS.slice(0, completionCount)] : opening;
  }, [approved, completionCount, visibleCount]);
  const projection = projectMission(events);

  useEffect(() => {
    if (visibleCount >= OPENING_EVENTS.length || approved) return;
    const delay = visibleCount === 7 ? 2100 : visibleCount >= 8 ? 1250 : 850;
    const timer = window.setTimeout(() => setVisibleCount((count) => count + 1), delay);
    return () => window.clearTimeout(timer);
  }, [approved, visibleCount]);

  useEffect(() => {
    if (!approved || completionCount >= APPROVAL_EVENTS.length) return;
    const timer = window.setTimeout(() => setCompletionCount((count) => count + 1), 720);
    return () => window.clearTimeout(timer);
  }, [approved, completionCount]);

  function approveReorganization() {
    if (approved) return;
    setApproved(true);
    setCompletionCount(1);
  }

  return (
    <main className={`mission-shell ${projection.completed ? "mission-complete" : ""}`}>
      <nav className="brandbar">
        <div className="brandmark">MC</div>
        <div><p className="eyebrow">Mission Control</p><p className="brand-subtitle">Live organization command</p></div>
        <div className="system-status"><span />{projection.completed ? "Organization idle" : "Mission live"}</div>
      </nav>

      <header className="mission-header compact">
        <div><p className="section-label">Mission / {mission.id.slice(0, 8)}</p><h1>{mission.objective}</h1></div>
        <div className={`status-pill status-${projection.status.toLowerCase()}`}>{projection.status}</div>
      </header>

      {projection.completed ? (
        <section className="completion-card">
          <p className="section-label">Mission complete</p>
          <h2>Stripe Billing delivered.</h2>
          <div className="completion-metrics">
            <Metric label="Completed" value="14m 52s" />
            <Metric label="Saved" value="7m" />
            <Metric label="Human interventions" value="1" />
            <Metric label="Policy violations" value="0" />
          </div>
          <p className="completion-note">Mission replay available · Organization idle</p>
        </section>
      ) : (
        <>
          <section className="command-grid">
            <section className="command-panel mission-plan">
              <div className="panel-title"><div><p className="section-label">Mission Plan</p><h2>The organization</h2></div><span>{projection.plan.filter((item) => item.state === "complete").length}/4 complete</span></div>
              <div className="plan-list">
                {projection.plan.map((item, index) => <PlanItem key={item.name} item={item} index={index} />)}
              </div>
            </section>

            <section className={`command-panel health-panel health-${projection.risk.toLowerCase()}`}>
              <p className="section-label">Mission Health</p>
              <h2>{projection.risk === "Moderate" ? "⚠ " : ""}{projection.healthHeadline}</h2>
              <p className="health-copy">{projection.healthDetail}</p>
              <div className="health-grid"><Metric label="Schedule" value={projection.schedule} /><Metric label="Risk" value={projection.risk} /><Metric label="Next decision" value={projection.nextDecision} /></div>
            </section>

            <section className="command-panel mission-log">
              <div className="panel-title"><div><p className="section-label">Mission Log</p><h2>Organizational activity</h2></div><span>{events.length} events</span></div>
              <div className="log-list">
                {[...events].reverse().map((event) => <LogItem event={event} key={event.sequence} />)}
              </div>
            </section>
          </section>

          {projection.recommendation && !projection.approved && (
            <section className="recommendation-card">
              <div className="recommendation-copy"><p className="section-label">Mission Control Recommendation</p><h2>Research is blocking implementation.</h2><p>Three resources can begin work immediately. Split implementation and start validation against the stable contract.</p><div className="why-now"><strong>Why now?</strong><span>Research exceeded estimate</span><span>Coding became idle</span><span>New parallel path detected</span></div></div>
              <div className="recommendation-action"><div className="estimate"><span>Estimated completion</span><strong>22 min <b>→</b> 15 min</strong><small>7 minutes saved</small></div><button onClick={approveReorganization}>Approve Reorganization <span>→</span></button></div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function PlanItem({ item, index }: { item: ReturnType<typeof projectMission>["plan"][number]; index: number }) {
  return <div className={`plan-item plan-${item.state}`}><span className="plan-index">0{index + 1}</span><div><strong>{item.name}</strong><small>{item.owner} agent</small></div><span className="plan-state">{item.state}</span></div>;
}

function LogItem({ event }: { event: MissionEvent }) {
  return <div className={`log-item log-${event.type.replaceAll(".", "-")}`}><span className="log-sequence">{String(event.sequence).padStart(2, "0")}</span><div><strong>{event.message}</strong><small>{event.actor}{event.detail ? ` · ${event.detail}` : ""}</small></div></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
