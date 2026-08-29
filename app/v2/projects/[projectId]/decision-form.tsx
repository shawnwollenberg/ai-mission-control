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
  async function decide(decision: "APPROVED" | "REJECTED" | "DISCUSS") {
    const response = await fetch(`/api/v2/projects/${projectId}/missions/${issueNumber}/cto-decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, requestRevision }),
    });
    setMessage(
      response.ok
        ? "Decision recorded. Refresh to view the routed state."
        : `Decision failed: ${(await response.json()).error?.message ?? response.status}`,
    );
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => decide("APPROVED")}>Approve exact request</button>
        <button onClick={() => decide("REJECTED")}>Reject</button>
        <button onClick={() => decide("DISCUSS")}>Discuss in Architect context</button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
