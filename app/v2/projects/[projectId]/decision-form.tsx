"use client";
import { useState } from "react";

export function DecisionForm({
  projectId,
  issueNumber,
  requestRevision,
}: {
  projectId: string;
  issueNumber: number;
  requestRevision: number;
}) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function decide(decision: "APPROVED" | "REJECTED" | "DISCUSS") {
    if (submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/v2/projects/${projectId}/missions/${issueNumber}/cto-decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, requestRevision }),
      });
      setMessage(
        response.ok
          ? "Decision recorded exactly once. Mission Control will route the next turn."
          : `Decision failed: ${(await response.json()).error?.message ?? response.status}`,
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button disabled={submitting} style={{ minHeight: 44 }} onClick={() => decide("APPROVED")}>
          Approve exact request
        </button>
        <button disabled={submitting} style={{ minHeight: 44 }} onClick={() => decide("REJECTED")}>
          Reject
        </button>
        <button disabled={submitting} style={{ minHeight: 44 }} onClick={() => decide("DISCUSS")}>
          Discuss in Architect context
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
