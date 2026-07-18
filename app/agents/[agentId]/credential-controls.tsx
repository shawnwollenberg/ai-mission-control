"use client";
import { useState } from "react";
export default function CredentialControls({ agentId }: { agentId: string }) {
  const [replacement, setReplacement] = useState<{ credentialId: string; secret: string; version: number }>(),
    [message, setMessage] = useState("");
  async function rotate() {
    const response = await fetch(`/api/agents/${agentId}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overlapSeconds: 300 }),
    });
    if (!response.ok) {
      setMessage("Credential rotation failed");
      return;
    }
    setReplacement((await response.json()).credential);
    setMessage("");
  }
  async function revokeAll() {
    const response = await fetch(`/api/agents/${agentId}/credentials/revoke-all`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setMessage(response.ok ? "All credentials revoked. Reload to see current state." : "Emergency revocation failed");
  }
  return (
    <div>
      <div className="mission-actions">
        <button onClick={rotate}>Rotate credential</button>
        <button className="danger" onClick={revokeAll}>
          Emergency revoke all
        </button>
      </div>
      {replacement && (
        <div className="truth-banner live">
          <strong>Replacement credential — shown once</strong>
          <code>
            Version {replacement.version} · {replacement.credentialId}
          </code>
          <code>{replacement.secret}</code>
          <button onClick={() => setReplacement(undefined)}>I stored it securely</button>
        </div>
      )}
      {message && <p>{message}</p>}
    </div>
  );
}
