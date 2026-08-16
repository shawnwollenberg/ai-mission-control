"use client";
import { useState } from "react";

export default function RecommendationActions({
  recommendationId,
  status: currentStatus,
  linkedMissionStatus,
  title,
  description,
  acceptanceCriteria,
  suggestedValidation,
}: {
  recommendationId: string;
  status: string;
  linkedMissionStatus?: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  suggestedValidation: string[];
}) {
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [objective, setObjective] = useState(`${title}: ${description}`);
  const [acceptance, setAcceptance] = useState(acceptanceCriteria.join("\n"));
  const [validation, setValidation] = useState(suggestedValidation.join("\n"));

  const launchLabel =
    currentStatus === "completed"
      ? "Create Follow-up Change Mission"
      : currentStatus === "in_progress"
        ? "Retry Change Mission"
        : "Create Change Mission";

  async function launch() {
    setPending(true);
    setError("");
    const response = await fetch(`/api/recommendations/${recommendationId}/change-mission`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        objective,
        acceptanceCriteria: acceptance,
        validationInstructions: validation,
      }),
    });
    const body = await response.json();
    if (response.ok && body.missionId) window.location.assign(`/missions/${body.missionId}`);
    else {
      setError(body.error?.message ?? "Change mission could not be created");
      setPending(false);
    }
  }
  async function status(value: "accepted" | "completed" | "stale" | "dismissed") {
    setPending(true);
    const response = await fetch(`/api/recommendations/${recommendationId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ status: value }),
    });
    if (response.ok) window.location.reload();
    else {
      const body = await response.json();
      setError(body.error?.message ?? "Recommendation could not be updated");
      setPending(false);
    }
  }
  const canLaunch =
    ["open", "accepted"].includes(currentStatus) ||
    (currentStatus === "in_progress" && ["failed", "cancelled"].includes(linkedMissionStatus ?? "")) ||
    (currentStatus === "completed" && linkedMissionStatus === "completed");
  return (
    <div className="mission-actions recommendation-actions">
      {canLaunch && !reviewing && (
        <button disabled={pending} onClick={() => setReviewing(true)} type="button">
          {launchLabel}
        </button>
      )}
      {canLaunch && reviewing && (
        <section className="recommendation-confirm" aria-label="Review the change before launch">
          <p className="section-label">Review the change before launch</p>
          <h2>{launchLabel}</h2>
          <label>
            Objective
            <textarea
              maxLength={1000}
              onChange={(event) => setObjective(event.target.value)}
              rows={3}
              value={objective}
            />
          </label>
          <label>
            Acceptance criteria <small>Optional · one item per line</small>
            <textarea
              maxLength={3000}
              onChange={(event) => setAcceptance(event.target.value)}
              rows={3}
              value={acceptance}
            />
          </label>
          <label>
            Validation commands <small>Optional · one approved repository-local command per line</small>
            <textarea
              maxLength={2000}
              onChange={(event) => setValidation(event.target.value)}
              rows={3}
              value={validation}
            />
          </label>
          <div className="mission-actions">
            <button disabled={pending || !objective.trim()} onClick={launch} type="button">
              {pending ? "Creating mission…" : "Launch change mission"}
            </button>
            <button className="button-secondary" disabled={pending} onClick={() => setReviewing(false)} type="button">
              Cancel
            </button>
          </div>
        </section>
      )}
      {currentStatus === "open" && (
        <button disabled={pending} onClick={() => status("accepted")}>
          Accept
        </button>
      )}
      {currentStatus === "in_progress" && (
        <button disabled={pending} onClick={() => status("completed")}>
          Mark completed
        </button>
      )}
      {["open", "accepted", "in_progress"].includes(currentStatus) && (
        <button disabled={pending} onClick={() => status("stale")}>
          Mark stale
        </button>
      )}
      {["open", "accepted", "in_progress"].includes(currentStatus) && (
        <button disabled={pending} onClick={() => status("dismissed")}>
          Dismiss
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
