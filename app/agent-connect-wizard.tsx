"use client";
import { useState } from "react";
const agents = {
  Codex: "WORKER_ID=codex-1 npm run worker:codex",
  Hermes: "WORKER_ID=hermes-1 HERMES_AGENT_SECRET=<ONE_TIME_SECRET> npm run worker:hermes",
  "Claude Code": "# Adapter preview — packaged connection command coming soon",
  "Generic Remote Agent": "# Implement signed protocol 1.0, then send your first heartbeat",
};
export default function AgentConnectWizard() {
  const [selected, setSelected] = useState<keyof typeof agents>("Codex"),
    [step, setStep] = useState(0);
  return (
    <div className="connect-card">
      <div className="connect-progress">
        <span>01</span>
        <i />
        <span>02</span>
        <i />
        <span>03</span>
      </div>
      {step === 0 && (
        <>
          <p className="mono-kicker">Your first connection</p>
          <h2>
            Welcome.
            <br />
            Let’s connect your first agent.
          </h2>
          <div className="agent-options">
            {Object.keys(agents).map((name) => (
              <button
                className={selected === name ? "selected" : ""}
                onClick={() => setSelected(name as keyof typeof agents)}
                key={name}
              >
                <span />
                {name}
              </button>
            ))}
          </div>
          <button className="connect-next" onClick={() => setStep(1)}>
            Next <span>→</span>
          </button>
        </>
      )}
      {step === 1 && (
        <>
          <p className="mono-kicker">Run on your agent host</p>
          <h2>Paste this command.</h2>
          <p className="connect-note">
            Run this from your Mission Control installation after registering the agent in Launch App. Secret-bearing
            values are displayed there once.
          </p>
          <pre>
            <code>{agents[selected]}</code>
          </pre>
          <button className="connect-next" onClick={() => setStep(2)}>
            I’ve run it <span>→</span>
          </button>
        </>
      )}
      {step === 2 && (
        <div className="heartbeat-success">
          <div className="pulse-ring">
            <span />
          </div>
          <p className="mono-kicker">Heartbeat received</p>
          <h2>Congratulations.</h2>
          <p>Your {selected} agent is ready for its first bounded mission.</p>
          <a className="connect-next" href="https://app.missioncontrol.wallyweb.com/agents">
            Open agent roster <span>↗</span>
          </a>
        </div>
      )}
      {step > 0 && (
        <button className="connect-back" onClick={() => setStep(step - 1)}>
          ← Back
        </button>
      )}
    </div>
  );
}
