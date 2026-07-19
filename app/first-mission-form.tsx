"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { BrandSprite } from "@/app/brand-assets";

type Repository = { repository_id: string; name: string; default_branch: string; agent_id: string; agent_name: string };
export default function FirstMissionForm({ repositories }: { repositories: Repository[] }) {
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.repository_id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const commandId = useRef(crypto.randomUUID());
  const selected = repositories.find((repository) => repository.repository_id === repositoryId);
  async function launch(event: FormEvent) {
    event.preventDefault();
    if (!selected || pending) return;
    setPending(true);
    setError("");
    const response = await fetch("/api/onboarding/first-mission", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": commandId.current },
      body: JSON.stringify({ repositoryId, agentId: selected.agent_id }),
    });
    const body = (await response.json()) as { missionId?: string; error?: { message?: string } };
    if (response.ok && body.missionId) window.location.assign(`/missions/${body.missionId}`);
    else {
      setError(body.error?.message ?? "The first mission could not be launched.");
      setPending(false);
    }
  }
  return (
    <main className="launch-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">First Mission · Live Mission Agent</p>
        </div>
        <Link className="nav-link" href="/agents">
          Agent Registry
        </Link>
      </nav>
      <section className="launch-grid">
        <div className="launch-copy">
          <p className="section-label">Your first mission</p>
          <h1>Analyze this repository.</h1>
          <p className="lede">
            Your local Codex adapter will pull this assignment over outbound HTTPS and return a genuine Markdown
            artifact.
          </p>
          <div className="principle">Read only. No repository changes.</div>
        </div>
        <form className="launch-card" onSubmit={launch}>
          <div className="card-heading">
            <span>Repository analysis</span>
            <span className="secure">Live local execution</span>
          </div>
          {repositories.length ? (
            <label>
              Registered repository
              <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
                {repositories.map((repository) => (
                  <option value={repository.repository_id} key={repository.repository_id}>
                    {repository.name} · {repository.default_branch} · {repository.agent_name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="form-error">
              No pull-ready Codex repository is registered. Run the generated Mission Agent connection command from a
              Git repository.
            </div>
          )}
          <label>
            Objective
            <textarea
              value="Analyze this repository and produce a concise architecture, risk, and next-steps report"
              readOnly
              rows={3}
            />
          </label>
          <ul>
            <li>Inspect files and configuration</li>
            <li>Review test setup</li>
            <li>Produce checksummed Markdown</li>
            <li>No edits, installs, commits, pushes, or deployments</li>
          </ul>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="launch-button" disabled={!selected || pending} type="submit">
            {pending ? "Creating durable assignment…" : "Launch first mission"}
            <span>→</span>
          </button>
        </form>
      </section>
    </main>
  );
}
