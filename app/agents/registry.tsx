"use client";
import { useState } from "react";
import Link from "next/link";
type Agent = {
  agent_id: string;
  name: string;
  description?: string;
  adapter_type: string;
  status: string;
  capabilities: string[];
  last_heartbeat_at?: string;
  concurrency_limit: number;
  current_execution_count: number;
  effective_status?: string;
  credential_status?: string;
  supported_domains?: string[];
};
export default function AgentRegistry({ initialAgents }: { initialAgents: Agent[] }) {
  const [agents, setAgents] = useState(initialAgents),
    [name, setName] = useState("Codex Worker"),
    [adapterType, setAdapterType] = useState<"codex" | "remote_http">("codex"),
    [endpoint, setEndpoint] = useState("http://127.0.0.1:4100/executions"),
    [credential, setCredential] = useState<{ credentialId: string; secret: string }>(),
    [error, setError] = useState("");
  async function register() {
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        adapterType,
        endpoint: adapterType === "remote_http" ? endpoint : undefined,
        capabilities:
          adapterType === "remote_http"
            ? ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"]
            : undefined,
        supportedDomains: adapterType === "remote_http" ? ["systems_monitoring"] : undefined,
      }),
    });
    if (!response.ok) {
      setError("Agent registration failed");
      return;
    }
    const created = await response.json();
    if (created.credential) setCredential(created.credential);
    const refreshed = await fetch("/api/agents");
    setAgents((await refreshed.json()).agents);
  }
  async function toggle(agent: Agent) {
    await fetch(`/api/agents/${agent.agent_id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: agent.status === "disabled" }),
    });
    const refreshed = await fetch("/api/agents");
    setAgents((await refreshed.json()).agents);
  }
  return (
    <>
      <header className="mission-header compact">
        <div>
          <p className="section-label">Execution plane</p>
          <h1>Agent registry</h1>
          <p>Owner-managed connected and simulated execution capacity.</p>
        </div>
      </header>
      <section className="durable-grid">
        <section className="command-panel">
          <h2>Register agent</h2>
          <select value={adapterType} onChange={(event) => setAdapterType(event.target.value as typeof adapterType)}>
            <option value="codex">Codex worker</option>
            <option value="remote_http">Remote HTTP / Hermes</option>
          </select>
          <input value={name} onChange={(event) => setName(event.target.value)} />
          {adapterType === "remote_http" && (
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
          )}
          <div className="mission-actions">
            <button onClick={register}>Register connected worker</button>
          </div>
          {error && <p className="form-error">{error}</p>}
          {credential && (
            <div className="truth-banner live">
              <strong>Copy this credential now. It will not be shown again.</strong>
              <code>{credential.credentialId}</code>
              <code>{credential.secret}</code>
              <button onClick={() => setCredential(undefined)}>I stored it securely</button>
            </div>
          )}
        </section>
        <section className="command-panel">
          <h2>Registered agents</h2>
          <div className="log-list">
            {agents.map((agent) => (
              <div className="log-item" key={agent.agent_id}>
                <span className="log-sequence">
                  {agent.adapter_type === "codex" ? "CX" : agent.adapter_type === "remote_http" ? "HE" : "MO"}
                </span>
                <div>
                  <strong>
                    <Link href={`/agents/${agent.agent_id}`}>{agent.name}</Link>
                  </strong>
                  <small>
                    {agent.adapter_type === "codex"
                      ? "Live Codex agent"
                      : agent.adapter_type === "remote_http"
                        ? "Live Hermes agent"
                        : "Simulated agent"}{" "}
                    · {agent.effective_status ?? agent.status} · {agent.current_execution_count}/
                    {agent.concurrency_limit} active
                  </small>
                  <p>{agent.capabilities.join(" · ")}</p>
                  <p>
                    Domains: {(agent.supported_domains ?? []).join(" · ") || "None"} · Credential:{" "}
                    {agent.credential_status ?? "n/a"}
                  </p>
                  <p>
                    Last heartbeat:{" "}
                    {agent.last_heartbeat_at ? new Date(agent.last_heartbeat_at).toLocaleString() : "Never"}
                  </p>
                  <button onClick={() => toggle(agent)}>{agent.status === "disabled" ? "Enable" : "Disable"}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>
    </>
  );
}
