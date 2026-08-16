"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { AppNavigation } from "@/app/app-navigation";

type History = {
  state: Record<string, unknown>;
  participants: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  objections: Record<string, unknown>[];
  usage: Record<string, unknown>[];
  learningCandidate?: Record<string, unknown> | null;
};
type Executor = { agent_id: string; name: string; provider_id: string; supported_models: string[] };

const phases = [
  ["Repository context", "project_brain_context_pack"],
  ["Independent proposals", "consensus_proposal"],
  ["Critiques", "consensus_critique"],
  ["Revisions", "consensus_revision"],
  ["Combined plan", "canonical_implementation_plan"],
  ["Verdicts", "canonical_plan_verdict"],
] as const;
const missionStages = [
  { id: "plan", label: "Plan" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "Waiting on you" },
  { id: "evidence", label: "Evidence ready" },
  { id: "done", label: "Done" },
] as const;
const roleLabels: Record<string, string> = {
  planner: "Planner",
  synthesizer: "Combines plans",
  executor: "Implements",
  implementation_reviewer: "Reviews",
};
const artifactLabels: Record<string, string> = {
  project_brain_context_pack: "Repository context",
  consensus_proposal: "Proposal",
  consensus_critique: "Critique",
  consensus_revision: "Revision",
  canonical_implementation_plan: "Combined plan",
  canonical_plan_verdict: "Verdict",
};
const statusLabels: Record<string, string> = {
  awaiting_human_approval: "Waiting on you",
  approved: "Plan approved",
  rejected: "Plan rejected",
  planning: "Working",
  preparing_context: "Preparing context",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const roleLabel = (role: string) => roleLabels[role] ?? role.replaceAll("_", " ");
const artifactLabel = (kind: string) => artifactLabels[kind] ?? kind.replaceAll("_", " ");
const statusLabel = (status: string) => statusLabels[status] ?? status.replaceAll("_", " ");

export default function ConsensusPlanConsole({
  mission,
  initialHistory,
  executors,
  owner,
}: {
  mission: { missionId: string; name: string; objective: string; status: string };
  initialHistory: History;
  executors: Executor[];
  owner: boolean;
}) {
  const [history, setHistory] = useState(initialHistory);
  const state = history.state;
  const executorId = String(state.preferred_executor_agent_id ?? "");
  const selectedExecutor = executors.find((agent) => agent.agent_id === executorId);
  const modelId = String(state.preferred_executor_model_id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const implementationCommand = useRef(crypto.randomUUID());
  const canonical = history.artifacts.find((artifact) => artifact.artifact_kind === "canonical_implementation_plan");
  const actualCost = useMemo(
    () => history.usage.reduce((sum, item) => sum + Number(item.cost_amount ?? 0), 0),
    [history.usage],
  );

  async function refresh() {
    const response = await fetch(`/api/consensus-plans/${mission.missionId}`, { cache: "no-store" });
    if (response.ok) setHistory((await response.json()) as History);
  }
  async function decide(decision: "grant" | "deny") {
    if (!state.human_approval_id || pending) return;
    setPending(true);
    setError("");
    const response = await fetch(`/api/approvals/${state.human_approval_id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision,
        reason: `${decision === "grant" ? "Approved" : "Rejected"} exact canonical plan and bounded local action`,
      }),
    });
    if (!response.ok)
      setError(((await response.json()) as { error?: { message?: string } }).error?.message ?? "Decision failed");
    await refresh();
    setPending(false);
  }
  async function createImplementation() {
    if (!executorId || pending) return;
    setPending(true);
    setError("");
    const response = await fetch(`/api/consensus-plans/${mission.missionId}/implementation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": implementationCommand.current },
      body: JSON.stringify({
        executorAgentId: executorId,
        executorModelId: modelId,
      }),
    });
    const body = (await response.json()) as { missionId?: string; error?: { message?: string } };
    if (response.ok && body.missionId) window.location.assign(`/missions/${body.missionId}`);
    else {
      setError(body.error?.message ?? "Implementation mission could not be created");
      setPending(false);
    }
  }
  async function copyPlan() {
    if (canonical?.normalized_payload)
      await navigator.clipboard.writeText(JSON.stringify(canonical.normalized_payload, null, 2));
  }
  function downloadPlan() {
    if (!canonical?.normalized_payload) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(canonical.normalized_payload, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `combined-plan-${String(state.canonical_plan_hash).slice(0, 12)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const waiting = state.status === "awaiting_human_approval";
  const stageId = state.implementation_mission_id
    ? "done"
    : ["completed", "failed", "cancelled", "rejected"].includes(String(state.status))
      ? "done"
      : waiting
        ? "waiting"
        : canonical
          ? "evidence"
          : history.artifacts.some((artifact) => artifact.artifact_kind === "consensus_proposal")
            ? "working"
            : "plan";
  const stageIndex = missionStages.findIndex((stage) => stage.id === stageId);

  return (
    <main className="durable-mission-shell">
      <AppNavigation subtitle="Consensus mission" />
      <div className="mission-breadcrumbs">
        <Link href="/missions">Missions</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{mission.name}</span>
        <Link className="mission-switcher-link" href="/missions">
          Switch mission →
        </Link>
      </div>
      <header className="mission-header compact">
        <div>
          <p className="section-label">Consensus plan</p>
          <h1>{mission.name}</h1>
          <p>{mission.objective}</p>
        </div>
        <div
          className={`status-pill status-${mission.status}`}
          role="status"
          aria-label={`Mission status: ${mission.status}`}
        >
          <span>{statusLabel(String(state.status))}</span>
        </div>
      </header>
      <ol className="mission-stage-strip" aria-label="Mission stages">
        {missionStages.map((stage, index) => (
          <li
            className={`${index < stageIndex ? "is-complete" : ""}${index === stageIndex ? " is-current" : ""}`}
            key={stage.id}
          >
            <span>{index + 1}</span>
            {stage.label}
          </li>
        ))}
      </ol>
      <section className="principle">Two agents propose a plan. You approve it before any files change.</section>
      {waiting && (
        <section className="mission-decision-panel needs-attention" id="mission-approvals">
          <div className="panel-title">
            <div>
              <p className="section-label">Needs you</p>
              <h2>Approve this plan</h2>
            </div>
          </div>
          <div className="approval-card mission-decision-card">
            <strong>Approval required</strong>
            <p>
              This plan is read-only until you approve it. Approval lets the chosen agent implement it on an isolated
              branch and stop at a local commit.
            </p>
            {owner ? (
              <div className="mission-actions">
                <button className="button-approve" disabled={pending} onClick={() => decide("grant")} type="button">
                  Approve this plan
                </button>
                <button className="button-danger" disabled={pending} onClick={() => decide("deny")} type="button">
                  Deny
                </button>
              </div>
            ) : (
              <p>A workspace owner must decide this approval.</p>
            )}
          </div>
        </section>
      )}
      <section className="durable-grid">
        <section className="command-panel">
          <div className="panel-title">
            <div>
              <p className="section-label">What happened</p>
              <h2>Activity</h2>
            </div>
          </div>
          <div className="log-list">
            {phases.map(([label, kind]) => {
              const artifacts = history.artifacts.filter((artifact) => artifact.artifact_kind === kind);
              const expected = [
                "consensus_proposal",
                "consensus_critique",
                "consensus_revision",
                "canonical_plan_verdict",
              ].includes(kind)
                ? 2
                : 1;
              return (
                <div className="log-item" key={kind}>
                  <span className="log-sequence">{artifacts.length >= expected ? "✓" : artifacts.length}</span>
                  <div>
                    <strong>{label}</strong>
                    <p>
                      {artifacts.length} of {expected} ready
                    </p>
                    {artifacts.map((artifact) => (
                      <Link href={`/artifacts/${artifact.artifact_id}`} key={String(artifact.artifact_id)}>
                        {artifactLabel(String(artifact.artifact_kind))}
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="log-item">
              <span className="log-sequence">{state.human_approval_id ? "✓" : "·"}</span>
              <div>
                <strong>Your decision</strong>
                <p>{state.human_approval_id ? statusLabel(String(state.status)) : "Not requested yet"}</p>
              </div>
            </div>
            <div className="log-item">
              <span className="log-sequence">{state.implementation_mission_id ? "✓" : "·"}</span>
              <div>
                <strong>Change mission</strong>
                {state.implementation_mission_id ? (
                  <Link href={`/missions/${state.implementation_mission_id}`}>Open the change →</Link>
                ) : (
                  <p>Starts after you approve the plan</p>
                )}
              </div>
            </div>
          </div>
        </section>
        <section className="command-panel">
          <div className="panel-title">
            <div>
              <p className="section-label">Crew</p>
              <h2>Who is working</h2>
            </div>
          </div>
          {history.participants.map((participant) => (
            <div className="log-item" key={String(participant.participant_assignment_id)}>
              <span className="log-sequence">{roleLabel(String(participant.role)).slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{String(participant.agent_name)}</strong>
                <p>{roleLabel(String(participant.role))}</p>
                <small>
                  {String(participant.provider_id)} · {String(participant.model_id)}
                </small>
                <p>
                  {history.usage
                    .filter((item) => item.participant_assignment_id === participant.participant_assignment_id)
                    .map(
                      (item) =>
                        `${String(item.metric_type)} ${String(item.quantity ?? item.cost_amount ?? "unreported")} ${String(item.unit ?? item.currency ?? "")}`,
                    )
                    .join(" · ") || "No usage reported yet"}
                </p>
              </div>
            </div>
          ))}
          <dl className="summary-grid">
            <div>
              <dt>Planning cost</dt>
              <dd>{actualCost ? `${actualCost.toFixed(4)} ${String(state.cost_currency)}` : "No reported cost"}</dd>
            </div>
          </dl>
          <details className="mission-technical-details">
            <summary>Technical details</summary>
            <p>
              Base commit {String(state.repository_base_commit).slice(0, 12)} · context{" "}
              {state.context_pack_hash ? String(state.context_pack_hash).slice(0, 16) : "pending"} · plan{" "}
              {state.canonical_plan_hash ? String(state.canonical_plan_hash).slice(0, 16) : "pending"}
            </p>
          </details>
        </section>
      </section>
      <section className="durable-grid">
        <section className="command-panel">
          <h2>Disagreements</h2>
          {!history.objections.length && <p>No blocking disagreements yet.</p>}
          {history.objections.map((objection) => (
            <article
              className={`truth-banner ${objection.status === "resolved" ? "live" : "warning"}`}
              key={String(objection.objection_id)}
            >
              <strong>
                {String(objection.category)} · {String(objection.status)}
              </strong>
              <p>{String(objection.description)}</p>
              <small>Needed change: {String(objection.required_change)}</small>
              <details className="mission-technical-details">
                <summary>Technical details</summary>
                <small>
                  Provider label: {String(objection.raw_provider_objection_id)} · Mission Control ID:{" "}
                  <code>{String(objection.objection_id)}</code>
                </small>
              </details>
            </article>
          ))}
        </section>
        <section className="command-panel">
          <div className="panel-title">
            <div>
              <p className="section-label">Combined plan</p>
              <h2>Review the result</h2>
            </div>
          </div>
          {canonical ? (
            <>
              <p>The agents agreed on one implementation plan. Download it, or approve it when you are ready.</p>
              <div className="mission-actions">
                <button className="button-secondary" onClick={copyPlan} type="button">
                  Copy plan
                </button>
                <button className="button-secondary" onClick={downloadPlan} type="button">
                  Download plan
                </button>
              </div>
            </>
          ) : (
            <p>The combined plan is not ready yet.</p>
          )}
          {state.status === "approved" && !state.implementation_mission_id && (
            <>
              <dl className="summary-grid">
                <div>
                  <dt>Will implement</dt>
                  <dd>
                    {selectedExecutor ? `${selectedExecutor.name} · ${selectedExecutor.provider_id}` : executorId}
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{modelId}</dd>
                </div>
              </dl>
              <p>
                Time limit:{" "}
                {String(
                  (state.execution_budget as { maximumDurationSeconds?: number } | undefined)?.maximumDurationSeconds ??
                    0,
                )}{" "}
                seconds ·{" "}
                {String((state.execution_budget as { maximumAttempts?: number } | undefined)?.maximumAttempts ?? 0)}{" "}
                attempts
              </p>
              <button
                className="launch-button button-primary"
                disabled={pending || !executorId || !modelId}
                onClick={createImplementation}
                type="button"
              >
                Start the change →
              </button>
            </>
          )}
          {history.learningCandidate ? (
            <p>
              <Link href={`/artifacts/${history.learningCandidate.artifact_id}`}>
                Proposed learning · review required →
              </Link>
            </p>
          ) : null}
          <p>
            <Link href="/">Start another consensus mission</Link>
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
