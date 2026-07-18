"use client";

import { useState } from "react";
import Link from "next/link";
import { BrandSprite } from "@/app/brand-assets";
import type { MissionReadModel } from "@/lib/mission-projection-store";
import type { MissionTimelineEntry } from "@/lib/mission-queries";

const availableCommands: Record<string, Array<{ command: string; label: string }>> = {
  draft: [
    { command: "plan", label: "Plan mission" },
    { command: "cancel", label: "Cancel" },
  ],
  planned: [
    { command: "start", label: "Start simulated execution" },
    { command: "cancel", label: "Cancel" },
  ],
  running: [
    { command: "pause", label: "Pause" },
    { command: "complete", label: "Complete" },
    { command: "fail", label: "Fail" },
    { command: "cancel", label: "Cancel" },
  ],
  paused: [
    { command: "resume", label: "Resume simulated execution" },
    { command: "cancel", label: "Cancel" },
  ],
};

export default function DurableMissionConsole({
  initialMission,
  initialTimeline,
}: {
  initialMission: MissionReadModel;
  initialTimeline: MissionTimelineEntry[];
}) {
  const [mission, setMission] = useState(initialMission);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function command(name: string) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/missions/${mission.missionId}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: mission.aggregateVersion }),
      });
      const body = (await response.json()) as {
        projection?: MissionReadModel;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.projection) {
        if (body.error?.code === "concurrency_conflict") {
          setError("This mission changed in another process. Refreshing the durable state…");
          window.setTimeout(() => window.location.reload(), 900);
        } else setError(body.error?.message ?? "The command could not be applied.");
        return;
      }
      setMission(body.projection);
      const timelineResponse = await fetch(`/api/missions/${mission.missionId}/events`, { cache: "no-store" });
      if (timelineResponse.ok)
        setTimeline(((await timelineResponse.json()) as { timeline: MissionTimelineEntry[] }).timeline);
    } catch {
      setError("Mission Control could not reach the durable command service.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="durable-mission-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Durable mission command</p>
        </div>
        <Link className="nav-link" href="/missions">
          Mission archive
        </Link>
        <a className="nav-link" href="/logout">
          Log out
        </a>
      </nav>
      <header className="mission-header compact">
        <div>
          <p className="section-label">Mission / {mission.missionId.slice(0, 8)}</p>
          <h1>{mission.name}</h1>
          <p>{mission.objective}</p>
        </div>
        <div className={`status-pill status-${mission.status}`}>{mission.status}</div>
      </header>
      <section className="execution-mode">
        <span>Execution mode</span>
        <strong>Simulated execution</strong>
        <small>No connected agent is running.</small>
      </section>
      <section className="durable-grid">
        <section className="command-panel mission-summary">
          <p className="section-label">Mission directive</p>
          <dl>
            <div>
              <dt>Domain</dt>
              <dd>{mission.domain.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{mission.priority}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{mission.riskLevel}</dd>
            </div>
            <div>
              <dt>Aggregate version</dt>
              <dd>{mission.aggregateVersion}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(mission.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{new Date(mission.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {mission.description && <p>{mission.description}</p>}
          {mission.successCriteria.length > 0 && (
            <div>
              <h3>Success criteria</h3>
              <ul>
                {mission.successCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </div>
          )}
          {mission.constraints.length > 0 && (
            <div>
              <h3>Constraints</h3>
              <ul>
                {mission.constraints.map((constraint) => (
                  <li key={constraint}>{constraint}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mission-actions">
            {(availableCommands[mission.status] ?? []).map((item) => (
              <button disabled={pending} key={item.command} onClick={() => command(item.command)}>
                {item.label}
              </button>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
        <section className="command-panel mission-log">
          <div className="panel-title">
            <div>
              <p className="section-label">Mission timeline</p>
              <h2>Canonical history</h2>
            </div>
            <span>{timeline.length} events</span>
          </div>
          <div className="log-list">
            {[...timeline].reverse().map((entry) => (
              <div className="log-item log-milestone" key={entry.eventId}>
                <span className="log-sequence">{String(entry.sequence).padStart(2, "0")}</span>
                <div>
                  <strong>{entry.label}</strong>
                  <small>
                    {entry.actor} · {new Date(entry.timestamp).toLocaleString()}
                  </small>
                  <p>{entry.summary}</p>
                  {entry.imported && <em>Imported legacy event</em>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
