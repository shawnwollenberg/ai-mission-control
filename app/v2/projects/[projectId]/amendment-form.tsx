"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AmendmentForm({
  projectId,
  issueNumber,
  blockedRevision,
  acceptanceCriteria,
}: {
  projectId: string;
  issueNumber: number;
  blockedRevision: number;
  acceptanceCriteria: string[];
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [criteria, setCriteria] = useState(acceptanceCriteria.join("\n"));
  const [evidenceRef, setEvidenceRef] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const replacements = criteria
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);

  async function amend() {
    if (submitting || !reason.trim() || !evidenceRef.trim() || !replacements.length) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/v2/projects/${projectId}/missions/${issueNumber}/amend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blockedRevision,
          reason,
          replacementAcceptanceCriteria: replacements,
          evidence: [{ kind: "owner-mission-amendment", ref: evidenceRef }],
        }),
      });
      if (response.ok) {
        setMessage("Mission criteria amended at a new revision. Architect reassessment is queued.");
        router.refresh();
      } else {
        setMessage(`Amendment failed: ${(await response.json()).error?.message ?? response.status}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <label>
        Why the existing acceptance criteria are obsolete
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
      </label>
      <label>
        Complete replacement acceptance criteria (one per line)
        <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={8} />
      </label>
      <label>
        Evidence reference
        <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} />
      </label>
      <button disabled={submitting || !reason.trim() || !evidenceRef.trim() || !replacements.length} onClick={amend}>
        Amend criteria and reassess
      </button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
