"use client";

import { FormEvent, useState } from "react";
import { BrandSprite } from "./brand-assets";

type LaunchInput = {
  objective: string;
  deadline: string;
  priority: "High" | "Normal" | "Low";
};

const DEFAULT_MISSION: LaunchInput = {
  objective: "Launch Stripe Billing for ServicePilot",
  deadline: "Today",
  priority: "High",
};

export default function LaunchPage() {
  const [mission, setMission] = useState(DEFAULT_MISSION);
  const [launching, setLaunching] = useState(false);

  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (launching || !mission.objective.trim()) return;

    setLaunching(true);
    const response = await fetch("/api/missions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mission),
    });

    if (!response.ok) {
      setLaunching(false);
      return;
    }

    const created = (await response.json()) as { missionId: string };
    window.location.assign(`/missions/${created.missionId}`);
  }

  return (
    <main className="launch-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Executive operations for AI teams</p>
        </div>
        <div className="system-status"><span /> Systems nominal</div>
      </nav>

      <section className="launch-grid">
        <div className="launch-copy">
          <BrandSprite asset="mark-primary" className="launch-brand-art" />
          <p className="section-label">New mission</p>
          <h1>Give your organization an outcome.</h1>
          <p className="lede">Mission Control coordinates the work and returns when human judgment is required.</p>
          <div className="principle">Humans manage outcomes, not AI.</div>
        </div>

        <form className="launch-card" onSubmit={launch}>
          <div className="card-heading">
            <span>Mission directive</span>
            <span className="secure">Command channel ready</span>
          </div>

          <label>
            Objective
            <textarea
              autoFocus
              value={mission.objective}
              onChange={(event) => setMission({ ...mission, objective: event.target.value })}
              rows={3}
            />
          </label>

          <div className="field-row">
            <label>
              Deadline
              <input
                value={mission.deadline}
                onChange={(event) => setMission({ ...mission, deadline: event.target.value })}
              />
            </label>
            <label>
              Priority
              <select
                value={mission.priority}
                onChange={(event) => setMission({ ...mission, priority: event.target.value as LaunchInput["priority"] })}
              >
                <option>High</option>
                <option>Normal</option>
                <option>Low</option>
              </select>
            </label>
          </div>

          <button className="launch-button" disabled={launching} type="submit">
            {launching ? "Establishing mission…" : "Launch mission"}
            <span aria-hidden>→</span>
          </button>
        </form>
      </section>
    </main>
  );
}
