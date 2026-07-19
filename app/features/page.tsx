import { PublicShell } from "../public-site";
export default function Features() {
  return (
    <PublicShell>
      <section className="docs-hero">
        <p className="mono-kicker">Features</p>
        <h1>
          Operate agents.
          <br />
          Don’t just prompt them.
        </h1>
      </section>
      <section className="feature-list">
        {[
          ["Orchestration", "Missions, dependency-aware tasks, templates, schedules, and mixed-agent handoffs."],
          ["Observability", "Live roster, heartbeats, structured events, artifacts, usage, budgets, and outcomes."],
          ["Governance", "Deterministic policy, parameter-bound approvals, permanent denials, and full audit history."],
          [
            "Execution",
            "Isolated Codex worktrees, signed remote agents, retries, cancellation, and graceful recovery.",
          ],
          ["Operations", "Notifications, dead letters, anomaly detection, backup validation, and emergency controls."],
        ].map(([t, d], i) => (
          <article key={t}>
            <b>0{i + 1}</b>
            <h2>{t}</h2>
            <p>{d}</p>
          </article>
        ))}
      </section>
    </PublicShell>
  );
}
