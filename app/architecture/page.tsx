import { PublicShell } from "../public-site";
export default function Architecture() {
  return (
    <PublicShell>
      <section className="docs-hero">
        <p className="mono-kicker">Architecture</p>
        <h1>
          A durable core.
          <br />
          Specialized edges.
        </h1>
        <p>
          One modular monolith, separate workers, PostgreSQL as the source of truth, and object storage for evidence.
        </p>
      </section>
      <section className="architecture-flow">
        <div>
          <strong>Human</strong>
          <span>objectives · decisions</span>
        </div>
        <i>↓</i>
        <div className="accent">
          <strong>Mission Control</strong>
          <span>events · policy · orchestration</span>
        </div>
        <i>↓</i>
        <div>
          <strong>Durable control plane</strong>
          <span>PostgreSQL events · workers · policies · approvals · artifact storage</span>
        </div>
        <i>↕ outbound HTTPS</i>
        <div className="accent">
          <strong>Mission Agent</strong>
          <span>pull assignments · leases · progress · evidence</span>
        </div>
        <i>↓</i>
        <div className="arch-agents">
          <span>Codex</span>
          <span>Hermes</span>
          <span>Claude Code</span>
          <span>Remote agents</span>
        </div>
      </section>
    </PublicShell>
  );
}
