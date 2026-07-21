"use client";
import { useState } from "react";
export default function RecommendationActions({
  recommendationId,
  status: currentStatus,
  linkedMissionStatus,
}: {
  recommendationId: string;
  status: string;
  linkedMissionStatus?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function launch() {
    setPending(true);
    setError("");
    const response = await fetch(`/api/recommendations/${recommendationId}/change-mission`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
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
  return (
    <div className="mission-actions">
      {(["open", "accepted"].includes(currentStatus) ||
        (currentStatus === "in_progress" && ["failed", "cancelled"].includes(linkedMissionStatus ?? ""))) && (
        <button disabled={pending} onClick={launch}>
          {pending
            ? "Creating mission…"
            : currentStatus === "in_progress"
              ? "Retry Change Mission"
              : "Create Change Mission"}
        </button>
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
