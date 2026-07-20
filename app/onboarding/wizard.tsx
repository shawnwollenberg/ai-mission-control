"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandSprite } from "@/app/brand-assets";
import { connectionProgress } from "./connection-progress";

type AgentType = "codex" | "hermes" | "claude_code" | "generic_remote";
type Agent = {
  agent_id: string;
  name: string;
  last_heartbeat_at?: string;
  pull_ready_at?: string;
  mission_agent_version?: string;
  mission_agent_adapter?: string;
  repository_count?: number;
};
type Connection = {
  agentId: string;
  agentName: string;
  command: string;
  endpoint: string;
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
  const [copied, setCopied] = useState<"default" | "advanced" | "doctor">();
  const [error, setError] = useState("");
  const [waitingLonger, setWaitingLonger] = useState(false);
  const currentAgent =
    agents.find((agent) => agent.agent_id === connection?.agentId) ??
    (!connection
      ? agents.find((agent) => agent.last_heartbeat_at && agent.pull_ready_at && (agent.repository_count ?? 0) > 0)
      : undefined);
  const progress = connectionProgress(Boolean(connection), currentAgent);
  const connected = progress.heartbeat && progress.pullReady && progress.repository ? currentAgent : undefined;
  const stage = connected ? 3 : 2;
  const environmentName = connection?.agentName.split(" – ")[0] ?? "your computer";
  const adapterName = choices.find((item) => item.id === choice)?.label ?? "Agent";
  const commandPreview = connection?.command.replace(/ connect '[^']+'/g, " connect '[protected credential hidden]'");

  useEffect(() => {
    if (!connection || connected) return;
    const poll = window.setInterval(async () => {
      const response = await fetch("/api/agents", { cache: "no-store" });
      if (!response.ok) return;
      setAgents(((await response.json()) as { agents: Agent[] }).agents);
    }, 2500);
    return () => window.clearInterval(poll);
  }, [connection, connected]);

  useEffect(() => {
    if (!connection || connected) return;
    const timer = window.setTimeout(() => setWaitingLonger(true), 25_000);
    return () => window.clearTimeout(timer);
  }, [connection, connected]);

  async function createConnection() {
    setCreating(true);
    setError("");
    setWaitingLonger(false);
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

  async function copyCommand(mode: "default" | "advanced" = "default") {
    if (!connection) return;
    const command =
      mode === "advanced" ? `${connection.command} --repository /absolute/path/to/repository` : connection.command;
    try {
      await navigator.clipboard.writeText(command);
      await fetch("/api/onboarding/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "onboarding.connection_command_copied", agentId: connection.agentId }),
      }).catch(() => undefined);
      setCopied(mode);
      window.setTimeout(() => setCopied(undefined), 1800);
    } catch {
      setError("The command could not be copied. Check your browser’s clipboard permission and try again.");
    }
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText("mission-agent doctor");
      setCopied("doctor");
      window.setTimeout(() => setCopied(undefined), 1800);
    } catch {
      setError("The diagnostics command could not be copied. Check your browser’s clipboard permission and try again.");
    }
  }

  const statusItems = [
    [progress.installed, "Mission Agent installed"],
    [progress.heartbeat, "Signed heartbeat received"],
    [progress.pullReady, "Assignment channel ready"],
    [progress.repository, "Repository registered"],
  ] as const;

  return (
    <main className="onboarding-shell">
      <header className="onboarding-brand">
        <BrandSprite asset="mark-compact" />
        <span>MISSION CONTROL</span>
      </header>
      {!connection && (
        <section className="onboarding-intro">
          <p className="section-label">Welcome to {workspaceName}</p>
          <h1>Let’s connect your first agent.</h1>
          <p>One command. No documentation required.</p>
        </section>
      )}
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
            <p className="section-label">{adapterName} · Mission Agent</p>
            <h1 className="onboarding-heading">Connect {environmentName}</h1>
            <p className="onboarding-lede">
              Open a terminal inside the first Git repository you want Mission Control to manage.
            </p>
            <p>This installs one Mission Agent for this computer. The same agent can manage multiple repositories.</p>
            <div className="connection-instruction">
              <b>1</b>
              <div>
                <strong>Open Terminal and change into your repository.</strong>
                <code>cd ~/Developer/my-project</code>
              </div>
            </div>
            <div className="connection-instruction">
              <b>2</b>
              <div>
                <strong>Copy and run the command below.</strong>
                <div className="command-copy">
                  <code aria-label="Connection command with protected credential hidden">{commandPreview}</code>
                  <button aria-label="Copy complete connection command" onClick={() => copyCommand()}>
                    {copied === "default" ? "Copied" : "Copy connection command"}
                  </button>
                </div>
                <small>
                  The copied command includes a secure connection credential. It is not displayed on this page and is
                  stored locally by Mission Agent during setup.
                </small>
              </div>
            </div>
            <div className="connection-instruction">
              <b>3</b>
              <div className="connection-status">
                <strong>Connection status</strong>
                <ul aria-live="polite">
                  {statusItems.map(([complete, label]) => (
                    <li className={complete ? "complete" : ""} key={label}>
                      <span aria-hidden="true">{complete ? "✓" : "○"}</span>
                      {label}
                    </li>
                  ))}
                </ul>
                <small>
                  This page will advance automatically once Mission Agent is connected and ready to receive work.
                </small>
              </div>
            </div>
            <details className="connection-details">
              <summary>Advanced: connect a repository by absolute path</summary>
              <p>Use this when you do not want to change directories before connecting.</p>
              <div className="command-copy">
                <code>{commandPreview} --repository /absolute/path/to/repository</code>
                <button
                  aria-label="Copy complete connection command with repository path"
                  onClick={() => copyCommand("advanced")}
                >
                  {copied === "advanced" ? "Copied" : "Copy advanced command"}
                </button>
              </div>
            </details>
            {waitingLonger && (
              <details className="connection-details">
                <summary>Still waiting?</summary>
                <p>Make sure:</p>
                <ul>
                  <li>You ran the command inside a Git repository.</li>
                  <li>Node.js and Git are installed.</li>
                  <li>Your computer can reach app.missioncontrol.wallyweb.com.</li>
                </ul>
                <div className="troubleshooting-actions">
                  <button onClick={() => copyCommand()}>Copy command again</button>
                  {progress.installed && (
                    <button aria-label="Copy Mission Agent diagnostics command" onClick={copyDiagnostics}>
                      {copied === "doctor" ? "Diagnostics command copied" : "Run connection diagnostics"}
                    </button>
                  )}
                  <Link href="/docs/mission-agent">Open troubleshooting</Link>
                  <button onClick={createConnection}>Regenerate connection command</button>
                </div>
              </details>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        {connected && (
          <div className="connected-stage" aria-live="polite">
            <div className="connected-check">✓</div>
            <p className="section-label">Mission Agent connected</p>
            <h2>Ready to launch.</h2>
            <p>
              ✓ Mission Agent connected
              <br />✓ {connected.repository_count} {connected.repository_count === 1 ? "repository" : "repositories"}{" "}
              registered
              <br />✓ Ready to launch your first mission
            </p>
            <p>Your Mission Agent can manage multiple repositories from this computer.</p>
            <details className="connection-details">
              <summary>Useful Mission Agent commands</summary>
              <code>mission-agent status</code>
              <code>mission-agent repository add /path/to/another/repository</code>
              <code>mission-agent doctor</code>
            </details>
            <div className="first-mission-card">
              <div>
                <p className="section-label">Next</p>
                <h3>Analyze this repository</h3>
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
