"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BrandSprite } from "@/app/brand-assets";

type AgentType = "codex" | "hermes" | "claude_code" | "generic_remote";
type Agent = { agent_id: string; name: string; adapter_type: string; status: string; last_heartbeat_at?: string };
type Connection = {
  agentId: string;
  agentName: string;
  command: string;
  endpoint: string;
  credentialId: string;
  protocolVersion: string;
};
const choices: { id: AgentType; label: string; description: string }[] = [
  { id: "codex", label: "Codex", description: "Analyze and review a local repository." },
  { id: "hermes", label: "Hermes", description: "Coordinate reports and operational analysis." },
  { id: "claude_code", label: "Claude Code", description: "Connect a repository-aware coding agent." },
  { id: "generic_remote", label: "Generic Remote Agent", description: "Use Mission Control protocol 1.0." },
];

export default function OnboardingWizard({
  workspaceName,
  initialAgentType,
  agents: initialAgents,
}: {
  workspaceName: string;
  initialAgentType?: AgentType;
  agents: Agent[];
}) {
  const [choice, setChoice] = useState<AgentType>(initialAgentType ?? "codex");
  const [agents, setAgents] = useState(initialAgents);
  const [connection, setConnection] = useState<Connection>();
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const connected = useMemo(
    () =>
      agents.find((agent) => agent.agent_id === connection?.agentId && agent.last_heartbeat_at) ??
      agents.find((agent) => agent.last_heartbeat_at),
    [agents, connection],
  );
  const stage = connected ? 3 : 2;

  useEffect(() => {
    if (!connection || connected) return;
    const poll = window.setInterval(async () => {
      const response = await fetch("/api/agents", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { agents: Agent[] };
      setAgents(body.agents);
    }, 2500);
    return () => window.clearInterval(poll);
  }, [connection, connected]);

  async function createConnection() {
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentType: choice }),
      });
      const body = (await response.json()) as Connection & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Mission Control could not create the connection.");
      setConnection(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mission Control could not create the connection.");
    } finally {
      setCreating(false);
    }
  }

  async function copyCommand() {
    if (!connection) return;
    await navigator.clipboard.writeText(connection.command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="onboarding-shell">
      <header className="onboarding-brand">
        <BrandSprite asset="mark-compact" />
        <span>MISSION CONTROL</span>
      </header>
      <section className="onboarding-intro">
        <p className="section-label">Welcome to {workspaceName}</p>
        <h1>Let’s connect your first agent.</h1>
        <p>One command. No documentation required.</p>
      </section>
      <ol className="onboarding-steps onboarding-steps-five">
        {["Create account", "Create workspace", "Connect agent", "Launch first mission", "Watch execution"].map(
          (label, index) => (
            <li className={index < stage ? "complete" : index === stage ? "active" : ""} key={label}>
              <span>{index < stage ? "✓" : "○"}</span>
              {label}
            </li>
          ),
        )}
      </ol>
      <section className="onboarding-panel">
        {!connection && !connected && (
          <>
            <p className="section-label">Connect agent</p>
            <h2 className="onboarding-heading">Choose the agent running on this computer.</h2>
            <div className="agent-choice-grid">
              {choices.map((agent) => (
                <button
                  className={choice === agent.id ? "selected" : ""}
                  key={agent.id}
                  onClick={() => setChoice(agent.id)}
                >
                  <span className="choice-radio">{choice === agent.id ? "●" : "○"}</span>
                  <strong>{agent.label}</strong>
                  <small>{agent.description}</small>
                </button>
              ))}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="launch-button onboarding-primary" disabled={creating} onClick={createConnection}>
              {creating ? "Creating secure connection…" : "Continue →"}
            </button>
          </>
        )}
        {connection && !connected && (
          <div className="command-stage">
            <p className="section-label">Connect {connection.agentName}</p>
            <h2 className="onboarding-heading">Copy and run this command.</h2>
            <p>Run it in the terminal on the computer where {connection.agentName} works.</p>
            <div className="command-copy">
              <code>{connection.command}</code>
              <button onClick={copyCommand}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
            <div className="heartbeat-wait">
              <span className="heartbeat-dot" />
              <div>
                <strong>Waiting for heartbeat…</strong>
                <small>This page will advance automatically.</small>
              </div>
            </div>
            {choice === "generic_remote" && (
              <details className="connection-details">
                <summary>Generic agent configuration</summary>
                <dl>
                  <div>
                    <dt>Endpoint</dt>
                    <dd>{connection.endpoint}</dd>
                  </div>
                  <div>
                    <dt>Credential</dt>
                    <dd>{connection.credentialId}</dd>
                  </div>
                  <div>
                    <dt>Protocol</dt>
                    <dd>{connection.protocolVersion}</dd>
                  </div>
                </dl>
              </details>
            )}
          </div>
        )}
        {connected && (
          <div className="connected-stage">
            <div className="connected-check">✓</div>
            <p className="section-label">Heartbeat received</p>
            <h2>Connected.</h2>
            <p>
              <strong>{connected.name}</strong> is ready in <strong>{workspaceName}</strong>.
            </p>
            <div className="first-mission-card">
              <div>
                <p className="section-label">Next · Launch first mission</p>
                <h3>{connected.name === "Hermes" ? "Review today’s system health" : "Analyze this repository"}</h3>
                <p>Start with a small, read-only mission and watch its execution become an artifact.</p>
              </div>
              <Link className="launch-button onboarding-action" href="/?firstMission=1">
                Launch first mission →
              </Link>
            </div>
          </div>
        )}
      </section>
      <footer className="onboarding-footer">
        <Link href="/quick-start">Quick Start</Link>
        <Link href="/architecture">Architecture</Link>
        <Link href="/examples">Examples</Link>
        <Link href="/agents">Agent Registry</Link>
      </footer>
    </main>
  );
}
