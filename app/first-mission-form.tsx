"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { BrandSprite } from "@/app/brand-assets";

type Repository = {
  repository_id: string;
  name: string;
  default_branch: string;
  agent_id: string;
  agent_name: string;
  health_score: number | null;
  health_confidence: number | null;
  health_assessed_at: string | null;
  actionable_recommendations: number;
};
export default function FirstMissionForm({ repositories }: { repositories: Repository[] }) {
  const [missionType, setMissionType] = useState<"analysis" | "change">("analysis");
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.repository_id ?? "");
  const [objective, setObjective] = useState(
    "Analyze this repository and produce a concise architecture, risk, and next-steps report",
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [validationInstructions, setValidationInstructions] = useState("");
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
      body: JSON.stringify({
        repositoryId,
        agentId: selected.agent_id,
        missionType,
        objective,
        acceptanceCriteria,
        validationInstructions,
      }),
    });
    const body = (await response.json()) as { missionId?: string; error?: { message?: string } };
    if (response.ok && body.missionId) window.location.assign(`/missions/${body.missionId}`);
    else {
      setError(body.error?.message ?? "The mission could not be launched.");
      setPending(false);
    }
  }
  return (
    <main className="launch-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">New Mission · Live Mission Agent</p>
        </div>
        <Link className="nav-link" href="/agents">
          Agent Registry
        </Link>
        <Link className="nav-link" href="/preview/servicepilot">
          Run Demo
        </Link>
      </nav>
      <section className="repository-dashboard">
        <div className="panel-heading">
          <div>
            <p className="section-label">Daily control plane</p>
            <h2>Repositories</h2>
          </div>
          <span>{repositories.length} connected</span>
        </div>
        <div className="repository-card-grid">
          {repositories.map((repository) => (
            <Link href={`/repositories/${repository.repository_id}`} key={repository.repository_id}>
              <span>
                {repository.name} · {repository.default_branch}
              </span>
              <strong>
                {repository.health_score ?? "—"}
                <small>/ 100</small>
              </strong>
              <p>{repository.actionable_recommendations} open recommendations</p>
              <small>
                {repository.health_assessed_at
                  ? `${repository.health_confidence}% confidence · ${new Date(repository.health_assessed_at).toLocaleDateString()}`
                  : "Run an analysis to establish health"}
              </small>
            </Link>
          ))}
        </div>
      </section>
      <section className="launch-grid">
        <div className="launch-copy">
          <p className="section-label">Live repository mission</p>
          <h1>
            {missionType === "change" ? "Prepare a controlled repository change." : "Direct a repository analysis."}
          </h1>
          <p className="lede">
            {missionType === "change"
              ? "Codex will plan first, pause for your approval, then work in an isolated local branch and return diff, validation, and commit evidence."
              : "Your local Codex adapter will pull this assignment over outbound HTTPS and return a genuine Markdown artifact."}
          </p>
          <div className="principle">
            {missionType === "change"
              ? "Local change only. Push, pull request, merge, and deployment remain unavailable."
              : "Read only. No repository changes."}
          </div>
        </div>
        <form className="launch-card" onSubmit={launch}>
          <div className="card-heading">
            <span>{missionType === "change" ? "Repository change" : "Repository analysis"}</span>
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
              This repository has not been registered with your Mission Agent. Add it from that computer with
              <code>mission-agent repository add /path/to/repository</code>.
            </div>
          )}
          <label>
            Mission type
            <select
              value={missionType}
              onChange={(event) => {
                const next = event.target.value as "analysis" | "change";
                setMissionType(next);
                setObjective(
                  next === "change"
                    ? "Implement a focused repository change and prepare it for review"
                    : "Analyze this repository and produce a concise architecture, risk, and next-steps report",
                );
              }}
            >
              <option value="analysis">Analyze Repository</option>
              <option value="change">Change Repository</option>
            </select>
          </label>
          <label>
            {missionType === "change" ? "Change objective" : "Analysis objective"}
            <textarea
              value={objective}
              maxLength={1000}
              onChange={(event) => setObjective(event.target.value)}
              rows={3}
            />
            <small>
              {missionType === "change"
                ? "Codex will propose a plan before requesting permission to modify an isolated worktree."
                : "Analysis missions can investigate and recommend changes, but cannot modify files."}
            </small>
          </label>
          {missionType === "change" && (
            <>
              <label>
                Acceptance criteria <small>Optional · one item per line</small>
                <textarea
                  value={acceptanceCriteria}
                  maxLength={3000}
                  onChange={(event) => setAcceptanceCriteria(event.target.value)}
                  placeholder={"Behavior works as described\nRelevant tests are updated"}
                  rows={3}
                />
              </label>
              <label>
                Validation commands <small>Optional · one approved repository-local command per line</small>
                <textarea
                  value={validationInstructions}
                  maxLength={2000}
                  onChange={(event) => setValidationInstructions(event.target.value)}
                  placeholder={"npm test\nnpm run lint\nnpm run typecheck"}
                  rows={3}
                />
              </label>
            </>
          )}
          <ul>
            {missionType === "change" ? (
              <>
                <li>Plan and request explicit write approval</li>
                <li>Use an isolated mission branch and worktree</li>
                <li>Record validation, diff, and local commit evidence</li>
                <li>No push, pull request, merge, deployment, or secrets</li>
              </>
            ) : (
              <>
                <li>Inspect files and configuration</li>
                <li>Review test setup</li>
                <li>Produce checksummed Markdown</li>
                <li>No edits, installs, commits, pushes, or deployments</li>
              </>
            )}
          </ul>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="launch-button" disabled={!selected || !objective.trim() || pending} type="submit">
            {pending
              ? "Creating durable assignment…"
              : missionType === "change"
                ? "Launch change mission"
                : "Launch analysis mission"}
            <span>→</span>
          </button>
        </form>
      </section>
    </main>
  );
}
