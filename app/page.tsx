import { requirePageIdentity } from "@/lib/page-auth";
import { headers } from "next/headers";
import AgentConnectWizard from "./agent-connect-wizard";
import { PublicShell } from "./public-site";
import FirstMissionForm from "./first-mission-form";
import { getDatabasePool } from "@/lib/database";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"))?.split(":")[0];
  if (host?.startsWith("app.")) {
    const identity = await requirePageIdentity("/");
    const state = (
      await getDatabasePool().query(
        `SELECT w.name,
          (SELECT count(*)::int FROM agents a WHERE a.workspace_id=w.id AND a.delivery_mode='pull' AND a.status='active') configured_agents,
          (SELECT count(*)::int FROM agents a WHERE a.workspace_id=w.id AND a.delivery_mode='pull' AND a.status='active' AND a.last_heartbeat_at>now()-interval '5 minutes' AND a.pull_ready_at>now()-interval '5 minutes') ready_agents,
          (SELECT count(*)::int FROM repositories r WHERE r.workspace_id=w.id AND r.location_mode='mission_agent' AND r.disabled_at IS NULL) repositories
         FROM workspaces w WHERE w.id=$1`,
        [identity.workspaceId],
      )
    ).rows[0];
    if (!state.ready_agents)
      return state.configured_agents ? (
        <ReconnectAgentHome workspaceName={state.name} />
      ) : (
        <FirstRunHome workspaceName={state.name} />
      );
    const repositories = (
      await getDatabasePool().query(
        `SELECT r.repository_id,r.name,r.default_branch,a.agent_id,a.name agent_name FROM repositories r
         JOIN agents a ON a.workspace_id=r.workspace_id AND r.allowed_agent_ids ? a.agent_id::text
         WHERE r.workspace_id=$1 AND r.location_mode='mission_agent' AND r.disabled_at IS NULL AND a.status='active'
           AND a.last_heartbeat_at>now()-interval '5 minutes' AND a.pull_ready_at>now()-interval '5 minutes'
         ORDER BY r.updated_at DESC`,
        [identity.workspaceId],
      )
    ).rows;
    if (!repositories.length) return <RepositoryRequiredHome workspaceName={state.name} />;
    return <FirstMissionForm repositories={repositories} />;
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

function FirstRunHome({ workspaceName }: { workspaceName: string }) {
  const firstName = workspaceName.replace(/['’]s Workspace$/, "");
  return (
    <main className="onboarding-shell">
      <section className="onboarding-intro">
        <p className="section-label">Your workspace is ready</p>
        <h1>Welcome, {firstName}.</h1>
        <p>Connect your first agent to launch a mission.</p>
      </section>
      <section className="onboarding-panel">
        <h2>Connect your first agent</h2>
        <div className="agent-choice-grid">
          {[
            ["Codex", "codex"],
            ["Hermes", "hermes"],
            ["Claude Code", "claude_code"],
            ["Generic Agent", "generic_remote"],
          ].map(([label, id]) => (
            <Link className="first-run-agent" href={`/onboarding?agent=${id}`} key={id}>
              {label}
              <span>→</span>
            </Link>
          ))}
        </div>
        <div className="troubleshooting-actions">
          <Link href="/docs/what-is-mission-control">What is Mission Control?</Link>
          <Link href="/quick-start">View Quick Start</Link>
          <a href="/logout">Log out</a>
        </div>
      </section>
    </main>
  );
}

function ReconnectAgentHome({ workspaceName }: { workspaceName: string }) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-intro">
        <p className="section-label">{workspaceName}</p>
        <h1>Reconnect your Mission Agent.</h1>
        <p>Your agent and repositories are still registered, but its recent heartbeat has expired.</p>
      </section>
      <section className="onboarding-panel">
        <code>mission-agent status</code>
        <code>mission-agent service install</code>
        <p>Once a fresh heartbeat arrives, the live repository mission will unlock automatically.</p>
        <Link className="launch-button onboarding-action" href="/onboarding">
          View connection status →
        </Link>
      </section>
    </main>
  );
}

function RepositoryRequiredHome({ workspaceName }: { workspaceName: string }) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding-intro">
        <p className="section-label">{workspaceName}</p>
        <h1>Register your first repository.</h1>
        <p>Your agent is connected, but it needs a repository before it can receive work.</p>
      </section>
      <section className="onboarding-panel">
        <code>mission-agent repository add /path/to/repository</code>
        <p>The page will unlock live repository missions after the repository is registered.</p>
        <Link className="launch-button" href="/onboarding">
          View connection status →
        </Link>
      </section>
    </main>
  );
}
