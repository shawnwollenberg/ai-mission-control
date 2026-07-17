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
  const organizationReconfigured = events.some((event) => event.type === "organization.reconfigured");

  useEffect(() => {
    if (visibleCount >= OPENING_EVENTS.length || approved) return;
    const delay = visibleCount === 7 ? 3800 : visibleCount >= 8 ? 1650 : 1050;
    const timer = window.setTimeout(() => setVisibleCount((count) => count + 1), delay);
    return () => window.clearTimeout(timer);
  }, [approved, visibleCount]);

  useEffect(() => {
    if (!approved || completionCount >= APPROVAL_EVENTS.length) return;
    const currentEvent = APPROVAL_EVENTS[completionCount - 1];
    const delay = currentEvent?.type === "organization.reconfigured" ? 2800 : currentEvent?.type === "recommendation.approved" ? 1200 : 950;
    const timer = window.setTimeout(() => setCompletionCount((count) => count + 1), delay);
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
          <p className="section-label">Mission debrief</p>
          <h2>Here are the outcomes your AI organization produced.</h2>
          <div className="completion-metrics">
            <Metric label="Objective" value="Completed" />
            <Metric label="Duration" value="14m 52s" />
            <Metric label="Estimated savings" value="7m" />
            <Metric label="Human decisions" value="1" />
          </div>
          <div className="deliverables">
            <div><p className="section-label">Deliverables</p><strong>Validated build</strong><span>3 checks passed</span></div>
            <div><strong>Interactive preview</strong><span>Controlled local environment</span></div>
            <a href="/preview/servicepilot" target="_blank" rel="noreferrer">View Evidence <span>↗</span></a>
          </div>
          <p className="completion-note">1 organization change · Replay available · Organization idle</p>
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

          {projection.approved && (
            <section className="reorganization-card" aria-live="polite">
              <div className="reorganization-heading">
                <div className="reorganization-signal"><span /><span /><span /></div>
                <div>
                <p className="section-label">Reorganization approved</p>
                  <h2>{organizationReconfigured ? "Mission Control changed the critical path." : "Mission Control is applying the new organization."}</h2>
                </div>
              </div>
              <div className="organization-change">
                <div className="organization-before"><span>Before · serial</span><strong>Research <b>→</b> Implementation <b>→</b> Validation</strong><small>Coding waited for research to finish</small></div>
                <div className="organization-now"><span>Now · parallel</span><strong>Research <b>→</b> Implementation <i>+</i> Validation</strong><small>Three resources advance together</small></div>
              </div>
              <div className="reorganization-impact"><span>Projected completion</span><strong>22m <b>→</b> {organizationReconfigured ? "15m" : "—"}</strong><small>{organizationReconfigured ? "7 minutes recovered" : "Recalculating critical path"}</small></div>
            </section>
          )}

          {projection.approved && (
            <section className="verification-card" aria-live="polite">
              <div><p className="section-label">Outcome verification</p><h2>{projection.previewReady ? "Preview deployment ready" : "Validation in progress"}</h2></div>
              <div className="verification-checks">
                {["Projection tests passed", "Production build passed", "Preview interaction passed"].map((check) => <span className={projection.checks.includes(check) ? "verified" : "pending"} key={check}>{projection.checks.includes(check) ? "✓" : "○"} {check}</span>)}
              </div>
              <span className={`preview-state ${projection.previewReady ? "verified" : "pending"}`}>{projection.previewReady ? "✓ Preview ready" : "○ Preview pending"}</span>
            </section>
          )}

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
