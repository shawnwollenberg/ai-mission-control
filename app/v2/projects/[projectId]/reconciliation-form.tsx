"use client";
import { useState } from "react";

export function ReconciliationForm({
  projectId,
  issueNumber,
  blockedRevision,
}: {
  projectId: string;
  issueNumber: number;
  blockedRevision: number;
}) {
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function reconcile() {
    if (submitting || !reason.trim() || !evidenceRef.trim()) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/v2/projects/${projectId}/missions/${issueNumber}/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockedRevision,
          reason,
          evidence: [{ kind: "owner-reconciliation", ref: evidenceRef }],
        }),
      });
      setMessage(
        response.ok
          ? "External block reconciled at a new revision. Architect reassessment is queued."
          : `Reconciliation failed: ${(await response.json()).error?.message ?? response.status}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <label>
        Why the external block changed
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
      </label>
      <label>
        Evidence reference
        <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} />
      </label>
      <button disabled={submitting || !reason.trim() || !evidenceRef.trim()} onClick={reconcile}>
        Reopen for Architect reassessment
      </button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
