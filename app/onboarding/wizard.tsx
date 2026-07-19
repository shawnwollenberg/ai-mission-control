"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandSprite } from "@/app/brand-assets";

type AgentChoice = "Codex" | "Hermes" | "Claude Code" | "Generic Remote Agent";
type Agent = { agent_id: string; name: string; adapter_type: string; status: string; last_heartbeat_at?: string };

const instructions: Record<AgentChoice, string> = {
  Codex: "Register a Codex worker, then run the isolated worker beside an approved repository.",
  Hermes: "Register a Remote HTTP agent and configure the Hermes bridge with its one-time credential.",
  "Claude Code": "Connect Claude Code through the authenticated remote-agent protocol and HTTP hooks.",
  "Generic Remote Agent":
    "Register an HTTPS endpoint, store its one-time credential, and send a signed protocol 1.0 heartbeat.",
};

export default function OnboardingWizard({ workspaceName, agents }: { workspaceName: string; agents: Agent[] }) {
  const [choice, setChoice] = useState<AgentChoice>("Codex");
  const connected = agents.find((agent) => agent.last_heartbeat_at);
  return (
    <main className="onboarding-shell">
      <header className="onboarding-brand">
        <BrandSprite asset="mark-compact" />
        <span>MISSION CONTROL</span>
      </header>
      <section className="onboarding-intro">
        <p className="section-label">Welcome to {workspaceName}</p>
        <h1>Let’s set up your first AI organization.</h1>
        <p>Connect one agent, confirm its heartbeat, then give it a small first mission.</p>
      </section>
      <ol className="onboarding-steps">
        <li className="active">
          <span>1</span>Choose an agent
        </li>
        <li className={agents.length ? "active" : ""}>
          <span>2</span>Connect it
        </li>
        <li className={connected ? "active" : ""}>
          <span>3</span>Heartbeat
        </li>
        <li>
          <span>4</span>First mission
        </li>
      </ol>
      <section className="onboarding-panel">
        <p className="section-label">Step 1 · Choose an agent</p>
        <div className="agent-choice-grid">
          {(["Codex", "Hermes", "Claude Code", "Generic Remote Agent"] as AgentChoice[]).map((agent) => (
            <button className={choice === agent ? "selected" : ""} key={agent} onClick={() => setChoice(agent)}>
              <span className="choice-radio">{choice === agent ? "●" : "○"}</span>
              {agent}
            </button>
          ))}
        </div>
        <div className="onboarding-connect">
          <div>
            <p className="section-label">Step 2 · Connect it</p>
            <h2>{choice}</h2>
            <p>{instructions[choice]}</p>
          </div>
          <Link className="launch-button onboarding-action" href="/agents">
            Open agent registry →
          </Link>
        </div>
        <div className={`heartbeat-card ${connected ? "connected" : ""}`}>
          <div>
            <p className="section-label">Step 3 · Heartbeat</p>
            <h2>{connected ? "✓ Connected" : "Waiting for heartbeat…"}</h2>
          </div>
          <p>
            {connected
              ? `${connected.name} checked in ${new Date(connected.last_heartbeat_at!).toLocaleString()}.`
              : "Return here after the agent sends its first authenticated heartbeat."}
          </p>
        </div>
        <div className="onboarding-connect">
          <div>
            <p className="section-label">Step 4 · Launch first mission</p>
            <h2>Start with something small.</h2>
            <p>Analyze this repository, or generate today’s system report.</p>
          </div>
          {connected ? (
            <Link className="launch-button onboarding-action" href="/templates">
              Choose a Mission Template →
            </Link>
          ) : (
            <span className="onboarding-locked">Available after heartbeat</span>
          )}
        </div>
      </section>
      <footer className="onboarding-footer">
        <Link href="/docs">Quick Start</Link>
        <Link href="/architecture">Architecture</Link>
        <Link href="/examples">Examples</Link>
        <Link href="/docs/creating-agents">Connect Your First Agent</Link>
      </footer>
    </main>
  );
}
