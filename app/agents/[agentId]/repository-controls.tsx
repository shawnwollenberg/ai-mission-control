"use client";

import { useState } from "react";

export default function RepositoryControls({
  repositoryId,
  agentId,
  disabled,
}: {
  repositoryId: string;
  agentId: string;
  disabled: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText("mission-agent repository add /path/to/repository");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  async function setEnabled(enabled: boolean) {
    const response = await fetch(`/api/agents/${agentId}/repositories/${repositoryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (response.ok) window.location.reload();
  }
  async function remove() {
    if (!window.confirm("Remove this repository association from the agent?")) return;
    const response = await fetch(`/api/agents/${agentId}/repositories/${repositoryId}`, { method: "DELETE" });
    if (response.ok) window.location.reload();
  }
  return (
    <div className="button-row">
      <button className="secondary-button" onClick={copy}>
        {copied ? "Copied ✓" : "Copy repository add command"}
      </button>
      <a className="secondary-button" href={`/repositories/${repositoryId}`}>
        View repository
      </a>
      <button className="secondary-button" onClick={() => setEnabled(disabled)}>
        {disabled ? "Enable repository" : "Disable repository"}
      </button>
      <button className="secondary-button" onClick={remove}>
        Remove association
      </button>
    </div>
  );
}
