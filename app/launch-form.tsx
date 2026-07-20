"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { BrandSprite } from "./brand-assets";

type LaunchInput = {
  name: string;
  objective: string;
  domain: string;
  priority: "high" | "normal" | "low";
  riskLevel: "unknown" | "low" | "moderate" | "high";
};

const DEFAULT_MISSION: LaunchInput = {
  name: "",
  objective: "",
  domain: "software_delivery",
  priority: "high",
  riskLevel: "unknown",
};

const FIRST_MISSION: LaunchInput = {
  name: "Analyze this repository",
  objective: "Analyze this repository and produce a concise architecture, risk, and next-steps report",
  domain: "software_delivery",
  priority: "normal",
  riskLevel: "low",
};

export default function LaunchForm({ firstMission = false }: { firstMission?: boolean }) {
  const [mission, setMission] = useState(firstMission ? FIRST_MISSION : DEFAULT_MISSION);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());

  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (launching) return;
    setLaunching(true);
    setError("");
    try {
      const response = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify(mission),
      });
      const body = (await response.json()) as { missionId?: string; error?: { message?: string } };
      if (!response.ok || !body.missionId) {
        setError(body.error?.message ?? "Mission Control could not create the mission.");
        return;
      }
      window.location.assign(`/missions/${body.missionId}`);
    } catch {
      setError("Mission Control could not reach the durable command service. You can safely retry.");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <main className="launch-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Executive operations for AI teams</p>
        </div>
        <Link className="nav-link" href="/missions">
          Mission archive
        </Link>
        <Link className="nav-link" href="/onboarding">
          Connect agent
        </Link>
        <a className="nav-link" href="/logout">
          Log out
        </a>
      </nav>

      <section className="launch-grid">
        <div className="launch-copy">
          <p className="section-label">{firstMission ? "Your first mission" : "New mission"}</p>
          <h1>{firstMission ? "Start small. See the whole loop." : "Give your organization an outcome."}</h1>
          <p className="lede">Mission Control coordinates the work and returns when human judgment is required.</p>
          <div className="principle">Humans manage outcomes, not AI.</div>
        </div>

        <form className="launch-card" onSubmit={launch}>
          <div className="card-heading">
            <span>Mission directive</span>
            <span className="secure">Durable command channel</span>
          </div>
          <label>
            Name
            <input
              placeholder="Give this mission a clear name"
              value={mission.name}
              onChange={(event) => setMission({ ...mission, name: event.target.value })}
            />
          </label>
          <label>
            Objective
            <textarea
              autoFocus
              placeholder="What outcome should your AI organization deliver?"
              value={mission.objective}
              onChange={(event) => setMission({ ...mission, objective: event.target.value })}
              rows={3}
            />
          </label>
          <div className="field-row">
            <label>
              Domain
              <select
                value={mission.domain}
                onChange={(event) => setMission({ ...mission, domain: event.target.value })}
              >
                <option value="software_delivery">Software delivery</option>
                <option value="research">Research</option>
                <option value="business_operations">Business operations</option>
              </select>
            </label>
            <label>
              Priority
              <select
                value={mission.priority}
                onChange={(event) =>
                  setMission({ ...mission, priority: event.target.value as LaunchInput["priority"] })
                }
              >
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="launch-button" disabled={launching} type="submit">
            {launching ? "Persisting mission…" : "Launch mission"}
            <span aria-hidden>→</span>
          </button>
        </form>
      </section>
    </main>
  );
}
