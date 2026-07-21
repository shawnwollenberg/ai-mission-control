import AgentConnectWizard from "../agent-connect-wizard";
import { PublicShell } from "../public-site";
export default function QuickStart() {
  return (
    <PublicShell>
      <section className="docs-hero compact">
        <p className="mono-kicker">10 minute quick start</p>
        <h1>
          Connect one agent.
          <br />
          Launch one mission.
        </h1>
        <p>Keep the first loop small enough to understand completely.</p>
      </section>
      <section className="quick-grid">
        <div className="quick-steps">
          {[
            ["01", "Open your control plane", "Launch the app and sign in as the production owner."],
            ["02", "Create an agent invite", "Choose an adapter, capabilities, resources, and execution limits."],
            [
              "03",
              "Register your first repository",
              "Run the one-time command inside a Git repository, or pass --repository /absolute/path.",
            ],
            ["04", "Verify readiness", "Confirm heartbeat, pull readiness, and at least one registered repository."],
            [
              "05",
              "Launch a bounded mission",
              "Give it one objective, explicit constraints, and an expected artifact.",
            ],
          ].map(([n, t, d]) => (
            <article key={n}>
              <b>{n}</b>
              <div>
                <h2>{t}</h2>
                <p>{d}</p>
              </div>
            </article>
          ))}
        </div>
        <p>
          One Mission Agent represents this computer and can manage multiple repositories. Add another later with{" "}
          <code>mission-agent repository add /path/to/repository</code>.
        </p>
        <AgentConnectWizard />
      </section>
    </PublicShell>
  );
}
