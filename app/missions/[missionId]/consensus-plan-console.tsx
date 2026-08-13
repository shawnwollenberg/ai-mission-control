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
  ["Context prepared", "project_brain_context_pack"],
  ["Independent proposals", "consensus_proposal"],
  ["Cross-critiques", "consensus_critique"],
  ["Revisions", "consensus_revision"],
  ["Canonical plan", "canonical_implementation_plan"],
  ["Final verdicts", "canonical_plan_verdict"],
] as const;

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
    link.download = `canonical-plan-${String(state.canonical_plan_hash).slice(0, 12)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="durable-mission-shell">
      <AppNavigation subtitle="Consensus Plan · Read only" />
      <header className="mission-header">
        <div>
          <p className="section-label">Server-authoritative planning mission</p>
          <h1>{mission.name}</h1>
          <p>{mission.objective}</p>
        </div>
        <div className="status-stack">
          <span className="secure">{String(state.status).replaceAll("_", " ")}</span>
          <code>{String(state.repository_base_commit).slice(0, 12)}</code>
        </div>
      </header>
      <section className="principle">
        Consensus is evidence, not proof of correctness. Planning is read-only, the canonical plan is immutable and
        hash-bound, and the one human action binds the executor, isolated write, validation, and local commit.
      </section>
      <section className="durable-grid">
        <section className="command-panel">
          <h2>Planning timeline</h2>
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
                      {artifacts.length} of {expected} immutable artifact{expected === 1 ? "" : "s"}
                    </p>
                    {artifacts.map((artifact) => (
                      <Link href={`/artifacts/${artifact.artifact_id}`} key={String(artifact.artifact_id)}>
                        {String(artifact.artifact_kind).replaceAll("_", " ")} ·{" "}
                        {String(artifact.checksum_sha256).slice(0, 12)}
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="log-item">
              <span className="log-sequence">{state.human_approval_id ? "✓" : "·"}</span>
              <div>
                <strong>Human approval</strong>
                <p>{state.human_approval_id ? String(state.status).replaceAll("_", " ") : "Not requested"}</p>
              </div>
            </div>
            <div className="log-item">
              <span className="log-sequence">{history.learningCandidate ? "✓" : "·"}</span>
              <div>
                <strong>Project Brain learning candidate</strong>
                {history.learningCandidate ? (
                  <Link href={`/artifacts/${history.learningCandidate.artifact_id}`}>
                    Open proposed evidence · human review required →
                  </Link>
                ) : (
                  <p>Proposed only after the implementation mission completes</p>
                )}
              </div>
            </div>
            <div className="log-item">
              <span className="log-sequence">{state.implementation_mission_id ? "✓" : "·"}</span>
              <div>
                <strong>Implementation mission</strong>
                {state.implementation_mission_id ? (
                  <Link href={`/missions/${state.implementation_mission_id}`}>Open governed child mission →</Link>
                ) : (
                  <p>Not created</p>
                )}
              </div>
            </div>
          </div>
        </section>
        <section className="command-panel">
          <h2>Participants and accounting</h2>
          {history.participants.map((participant) => (
            <div className="log-item" key={String(participant.participant_assignment_id)}>
              <span className="log-sequence">
                {String(participant.role).replaceAll("implementation_", "I·").replaceAll("planner_", "P·").slice(0, 3)}
              </span>
              <div>
                <strong>{String(participant.agent_name)}</strong>
                <p>
                  {String(participant.provider_id)} · {String(participant.model_id)} · {String(participant.role)}
                </p>
                <small>
                  capability {String(participant.capability_attestation_hash).slice(0, 12)} · assignment v
                  {String(participant.assignment_version)}
                </small>
                <p>
                  {history.usage
                    .filter((item) => item.participant_assignment_id === participant.participant_assignment_id)
                    .map(
                      (item) =>
                        `${String(item.metric_type)} ${String(item.quantity ?? item.cost_amount ?? "unreported")} ${String(item.unit ?? item.currency ?? "")}`,
                    )
                    .join(" · ") || "No usage reported for this role"}
                </p>
              </div>
            </div>
          ))}
          <dl className="summary-grid">
            <div>
              <dt>Planning cost</dt>
              <dd>{actualCost ? `${actualCost.toFixed(4)} ${String(state.cost_currency)}` : "No reported cost"}</dd>
            </div>
            <div>
              <dt>Context hash</dt>
              <dd>
                <code>{state.context_pack_hash ? String(state.context_pack_hash).slice(0, 16) : "pending"}</code>
              </dd>
            </div>
            <div>
              <dt>Plan hash</dt>
              <dd>
                <code>{state.canonical_plan_hash ? String(state.canonical_plan_hash).slice(0, 16) : "pending"}</code>
              </dd>
            </div>
          </dl>
        </section>
      </section>
      <section className="durable-grid">
        <section className="command-panel">
          <h2>Disagreements</h2>
          {!history.objections.length && <p>No blocking objections have been recorded yet.</p>}
          {history.objections.map((objection) => (
            <article
              className={`truth-banner ${objection.status === "resolved" ? "live" : "warning"}`}
              key={String(objection.objection_id)}
            >
              <strong>
                {String(objection.category)} · {String(objection.status)}
              </strong>
              <p>{String(objection.description)}</p>
              <small>Required change: {String(objection.required_change)}</small>
              <small>
                Provider label: {String(objection.raw_provider_objection_id)} · Mission Control ID:{" "}
                <code>{String(objection.objection_id)}</code> · Source: {String(objection.source_artifact_id)}
              </small>
            </article>
          ))}
        </section>
        <section className="command-panel">
          <h2>Canonical plan control</h2>
          {canonical ? (
            <>
              <code>{String(state.canonical_plan_hash)}</code>
              <div className="mission-actions">
                <button onClick={copyPlan}>Copy plan</button>
                <button onClick={downloadPlan}>Download JSON</button>
              </div>
            </>
          ) : (
            <p>The canonical plan is not available yet.</p>
          )}
          {state.status === "awaiting_human_approval" &&
            (owner ? (
              <div className="mission-actions">
                <button disabled={pending} onClick={() => decide("grant")}>
                  Approve plan + bounded local implementation
                </button>
                <button disabled={pending} onClick={() => decide("deny")}>
                  Reject plan
                </button>
              </div>
            ) : (
              <p>A workspace owner must decide this approval.</p>
            ))}
          {state.status === "approved" && !state.implementation_mission_id && (
            <>
              <dl className="summary-grid">
                <div>
                  <dt>Approved executor</dt>
                  <dd>
                    {selectedExecutor ? `${selectedExecutor.name} · ${selectedExecutor.provider_id}` : executorId}
                  </dd>
                </div>
                <div>
                  <dt>Approved model</dt>
                  <dd>{modelId}</dd>
                </div>
              </dl>
              <p>
                Approved execution budget:{" "}
                {String(
                  (state.execution_budget as { maximumDurationSeconds?: number } | undefined)?.maximumDurationSeconds ??
                    0,
                )}{" "}
                seconds ·{" "}
                {String((state.execution_budget as { maximumAttempts?: number } | undefined)?.maximumAttempts ?? 0)}{" "}
                attempts
              </p>
              <button
                className="launch-button"
                disabled={pending || !executorId || !modelId}
                onClick={createImplementation}
              >
                Create separate implementation mission →
              </button>
            </>
          )}
          <p>
            <Link href="/">Request a new consensus mission</Link>
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
