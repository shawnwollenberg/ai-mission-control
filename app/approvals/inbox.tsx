"use client";
import Link from "next/link";
import { useState } from "react";
type Approval = {
  approval_id: string;
  approval_type: string;
  risk_level: string;
  mission_name: string;
  risk_explanation: string;
  status: string;
  requested_action?: { actionType?: string };
  agent_name?: string;
  expires_at?: string;
  policy_reasons?: Array<{ code: string; message: string }>;
  parameters_summary?: Record<string, unknown>;
  mission_id: string;
};
export default function ApprovalInbox({ approvals }: { approvals: Approval[] }) {
  const [reason, setReason] = useState<Record<string, string>>({}),
    [pending, setPending] = useState("");
  async function decide(id: string, decision: "grant" | "deny") {
    setPending(id);
    const response = await fetch(`/api/approvals/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reason: reason[id] || `${decision} recorded by owner` }),
    });
    setPending("");
    if (response.ok) location.reload();
  }
  return (
    <section className="log-list">
      {approvals.length === 0 ? (
        <div className="empty-state">
          <h2>No matching approvals</h2>
          <p>Pending publication requests will appear here.</p>
        </div>
      ) : (
        approvals.map((approval) => (
          <article className="approval-card" key={approval.approval_id}>
            <p className="section-label">
              {approval.approval_type} · {approval.risk_level} risk
            </p>
            <h2>{approval.mission_name}</h2>
            <p>{approval.risk_explanation}</p>
            <p>
              <strong>Status:</strong> {approval.status} · <strong>Action:</strong>{" "}
              {approval.requested_action?.actionType}
            </p>
            <p>
              <strong>Agent:</strong> {approval.agent_name} · <strong>Expires:</strong>{" "}
              {approval.expires_at ? new Date(approval.expires_at).toLocaleString() : "No expiration"}
            </p>
            <ul>
              {(approval.policy_reasons ?? []).map((item) => (
                <li key={item.code}>
                  {item.message} <code>{item.code}</code>
                </li>
              ))}
            </ul>
            <details>
              <summary>Bound evidence</summary>
              <pre>{JSON.stringify(approval.parameters_summary, null, 2)}</pre>
            </details>
            <div className="mission-actions">
              <Link href={`/missions/${approval.mission_id}`}>View mission</Link>
              {approval.status === "pending" && (
                <>
                  <input
                    aria-label="Decision reason"
                    placeholder="Decision reason"
                    value={reason[approval.approval_id] ?? ""}
                    onChange={(event) => setReason({ ...reason, [approval.approval_id]: event.target.value })}
                  />
                  <button
                    disabled={pending === approval.approval_id}
                    onClick={() => decide(approval.approval_id, "grant")}
                  >
                    Approve
                  </button>
                  <button
                    disabled={pending === approval.approval_id}
                    onClick={() => decide(approval.approval_id, "deny")}
                  >
                    Deny
                  </button>
                </>
              )}
            </div>
          </article>
        ))
      )}
    </section>
  );
}
