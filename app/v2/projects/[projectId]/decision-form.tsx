"use client";
import { useRouter } from "next/navigation";
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
  const [discussion, setDiscussion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  async function decide(decision: "APPROVED" | "REJECTED" | "DISCUSS") {
    if (submitting || (decision === "DISCUSS" && !discussion.trim())) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/v2/projects/${projectId}/missions/${issueNumber}/cto-decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          requestRevision,
          ...(decision === "DISCUSS" ? { comment: discussion.trim() } : {}),
        }),
      });
      if (response.ok) router.refresh();
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
      <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        Discussion note for the Architect
        <textarea
          value={discussion}
          onChange={(event) => setDiscussion(event.target.value)}
          rows={3}
          placeholder="What should the Architect reconsider or clarify?"
        />
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button disabled={submitting} style={{ minHeight: 44 }} onClick={() => decide("APPROVED")}>
          Approve exact request
        </button>
        <button disabled={submitting} style={{ minHeight: 44 }} onClick={() => decide("REJECTED")}>
          Reject
        </button>
        <button disabled={submitting || !discussion.trim()} style={{ minHeight: 44 }} onClick={() => decide("DISCUSS")}>
          Discuss in Architect context
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
