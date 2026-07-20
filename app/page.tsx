import { requirePageIdentity } from "@/lib/page-auth";
import LaunchForm from "./launch-form";
import { headers } from "next/headers";
import AgentConnectWizard from "./agent-connect-wizard";
import { PublicShell } from "./public-site";
import FirstMissionForm from "./first-mission-form";
import { getDatabasePool } from "@/lib/database";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LaunchPage({ searchParams }: { searchParams: Promise<{ firstMission?: string }> }) {
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"))?.split(":")[0];
  if (host?.startsWith("app.")) {
    const identity = await requirePageIdentity("/");
    const query = await searchParams;
    const connectedAgents = await getDatabasePool().query(
      `SELECT 1 FROM agents WHERE workspace_id=$1 AND delivery_mode='pull' AND status='active'
       AND last_heartbeat_at IS NOT NULL AND pull_ready_at IS NOT NULL LIMIT 1`,
      [identity.workspaceId],
    );
    if (!connectedAgents.rowCount) redirect("/onboarding");
    if (query.firstMission === "1") {
      const repositories = (
        await getDatabasePool().query(
          `SELECT r.repository_id,r.name,r.default_branch,a.agent_id,a.name agent_name FROM repositories r
           JOIN agents a ON a.workspace_id=r.workspace_id AND r.allowed_agent_ids ? (a.agent_id::text)
           WHERE r.workspace_id=$1 AND r.location_mode='mission_agent' AND r.disabled_at IS NULL
             AND a.delivery_mode='pull' AND a.status='active' AND a.pull_ready_at>now()-interval '5 minutes'
           ORDER BY r.updated_at DESC`,
          [identity.workspaceId],
        )
      ).rows;
      return <FirstMissionForm repositories={repositories} />;
    }
    return <LaunchForm />;
  }
  return (
    <PublicShell>
      <section className="public-hero">
        <div className="hero-copy">
          <p className="mono-kicker">Command your AI organization</p>
          <h1>
            One place to direct
            <br />
            <em>every agent.</em>
          </h1>
          <p className="hero-lede">
            Plan missions, delegate work, watch execution, approve sensitive actions, and keep the evidence—without
            living in terminals and chat threads.
          </p>
          <div className="hero-actions">
            <a href="#connect">
              Connect an agent <span>↓</span>
            </a>
            <a href="/quick-start">Read the quick start</a>
          </div>
          <div className="free-callout">
            <span>Free</span>
            <p>
              <strong>Mission Control is free while it’s evolving.</strong>
              <br />
              I’m using it every day to manage my own AI organization. If you’re doing the same thing, I’d love for you
              to use it and give feedback.
            </p>
          </div>
        </div>
        <div id="connect">
          <AgentConnectWizard />
        </div>
      </section>
      <section className="signal-strip">
        <span>MISSION</span>
        <i>→</i>
        <span>AGENTS</span>
        <i>→</i>
        <span>EVIDENCE</span>
        <i>→</i>
        <span>APPROVAL</span>
        <i>→</i>
        <span>OUTCOME</span>
      </section>
      <section className="public-section">
        <div>
          <p className="mono-kicker">Why Mission Control</p>
          <h2>
            Agents are powerful.
            <br />
            Coordination is the hard part.
          </h2>
        </div>
        <div className="feature-grid">
          <article>
            <b>01</b>
            <h3>See the work</h3>
            <p>Every mission, task, execution, tool call, artifact, and failure in one durable timeline.</p>
          </article>
          <article>
            <b>02</b>
            <h3>Keep authority human</h3>
            <p>Pushes, pull requests, and sensitive actions stop at exact, evidence-bound approval gates.</p>
          </article>
          <article>
            <b>03</b>
            <h3>Run the organization</h3>
            <p>Coordinate Codex, Hermes, Claude Code, and remote agents through one control plane.</p>
          </article>
          <article>
            <b>04</b>
            <h3>Recover cleanly</h3>
            <p>Durable events, leases, heartbeats, budgets, emergency controls, and replayable projections.</p>
          </article>
        </div>
      </section>
      <section className="public-cta">
        <p className="mono-kicker">Your agents are waiting</p>
        <h2>
          Give the work
          <br />a control plane.
        </h2>
        <a href="https://app.missioncontrol.wallyweb.com">
          Launch Mission Control <span>↗</span>
        </a>
      </section>
    </PublicShell>
  );
}
