import { requirePageIdentity } from "@/lib/page-auth";
import { headers } from "next/headers";
import AgentConnectWizard from "./agent-connect-wizard";
import { PublicShell } from "./public-site";
import FirstMissionForm from "./first-mission-form";
import { getDatabasePool } from "@/lib/database";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LaunchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"))?.split(":")[0];
  if (host?.startsWith("app.")) {
    const identity = await requirePageIdentity("/");
    const query = await searchParams;
    const db = getDatabasePool();
    const state = (
      await db.query(
        `SELECT w.name,
          (SELECT count(*)::int FROM agents a WHERE a.workspace_id=w.id AND a.delivery_mode='pull' AND a.status='active') configured_agents,
          (SELECT count(*)::int FROM agents a WHERE a.workspace_id=w.id AND a.delivery_mode='pull' AND a.status='active' AND a.last_heartbeat_at>now()-interval '5 minutes' AND a.pull_ready_at>now()-interval '5 minutes') ready_agents,
          (SELECT count(*)::int FROM repositories r WHERE r.workspace_id=w.id AND r.location_mode='mission_agent' AND r.disabled_at IS NULL) repositories
         FROM workspaces w WHERE w.id=$1`,
        [identity.workspaceId],
      )
    ).rows[0];
    if (!state.configured_agents) return <FirstRunHome workspaceName={state.name} />;
    const [repositories, planningAgents, pendingApprovals, recentMissions, openRecommendations] = await Promise.all([
      db.query(
        `SELECT r.repository_id,r.name,r.default_branch,a.agent_id,a.name agent_name,
          health.score health_score,health.confidence health_confidence,health.assessed_at health_assessed_at,
          (SELECT count(*)::int FROM recommendation_projections recommendation
           WHERE recommendation.workspace_id=r.workspace_id AND recommendation.repository_id=r.repository_id
             AND recommendation.status IN ('open','accepted','in_progress')) actionable_recommendations,
          (a.last_heartbeat_at>now()-interval '5 minutes' AND a.pull_ready_at>now()-interval '5 minutes') agent_ready
         FROM repositories r
         JOIN agents a ON a.workspace_id=r.workspace_id AND r.allowed_agent_ids ? a.agent_id::text
         LEFT JOIN LATERAL (
           SELECT score,confidence,assessed_at FROM repository_health_assessments assessment
           WHERE assessment.workspace_id=r.workspace_id AND assessment.repository_id=r.repository_id
           ORDER BY assessed_at DESC LIMIT 1
         ) health ON true
         WHERE r.workspace_id=$1 AND r.location_mode='mission_agent' AND r.disabled_at IS NULL AND a.status='active'
         ORDER BY r.updated_at DESC`,
        [identity.workspaceId],
      ),
      db.query(
        `SELECT agent_id,name,provider_id,supported_models,model_capabilities,
           capability_attestation_id,capability_attestation_hash,supported_mission_roles,supported_operations
         FROM agents WHERE workspace_id=$1 AND status='active' AND delivery_mode='pull'
           AND last_heartbeat_at>now()-interval '5 minutes' AND pull_ready_at>now()-interval '5 minutes'
           AND provider_credentials_available=true
           AND mission_agent_checksum_status='verified'
           AND mission_agent_capability_expires_at>now()
           AND capability_attestation_id IS NOT NULL AND capability_attestation_expires_at>now()
           AND jsonb_array_length(model_capabilities)>0
         ORDER BY name,agent_id`,
        [identity.workspaceId],
      ),
      db.query(
        `SELECT ap.approval_id,ap.mission_id,ap.risk_explanation,m.name mission_name
         FROM approval_projections ap
         LEFT JOIN mission_projections m ON m.workspace_id=ap.workspace_id AND m.mission_id=ap.mission_id
         WHERE ap.workspace_id=$1 AND ap.status='pending'
         ORDER BY ap.created_at DESC LIMIT 5`,
        [identity.workspaceId],
      ),
      db.query(
        `SELECT mission_id,name,status,updated_at FROM mission_projections
         WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 5`,
        [identity.workspaceId],
      ),
      db.query(
        `SELECT rec.recommendation_id,rec.title,rec.estimated_risk,r.name repository_name
         FROM recommendation_projections rec
         JOIN repositories r ON r.workspace_id=rec.workspace_id AND r.repository_id=rec.repository_id
         WHERE rec.workspace_id=$1 AND rec.status IN ('open','accepted','in_progress')
         ORDER BY rec.updated_at DESC LIMIT 5`,
        [identity.workspaceId],
      ),
    ]);
    const liveRepositories = repositories.rows.filter((repository) => repository.agent_ready);
    return (
      <FirstMissionForm
        repositories={repositories.rows.map((repository) => ({
          ...repository,
          health_assessed_at: repository.health_assessed_at
            ? new Date(repository.health_assessed_at).toISOString()
            : null,
        }))}
        planningAgents={planningAgents.rows}
        initialMissionType={query.type}
        initialRepositoryId={query.repository}
        liveLaunchAvailable={liveRepositories.length > 0}
        attentionBanner={
          !state.ready_agents ? (
            <ReconnectAgentHome workspaceName={state.name} />
          ) : !repositories.rows.length ? (
            <RepositoryRequiredHome workspaceName={state.name} />
          ) : null
        }
        pendingApprovals={pendingApprovals.rows.map((approval) => ({
          approvalId: approval.approval_id,
          missionId: approval.mission_id,
          missionName: approval.mission_name ?? "Untitled mission",
          riskExplanation: approval.risk_explanation,
        }))}
        recentMissions={recentMissions.rows.map((mission) => ({
          missionId: mission.mission_id,
          name: mission.name,
          status: mission.status,
          updatedAt: new Date(mission.updated_at).toISOString(),
        }))}
        openRecommendations={openRecommendations.rows.map((recommendation) => ({
          recommendationId: recommendation.recommendation_id,
          title: recommendation.title,
          repositoryName: recommendation.repository_name,
          estimatedRisk: recommendation.estimated_risk,
        }))}
      />
    );
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
            ["Codex", "codex", "Runs analysis, change, and consensus missions"],
            ["Hermes", "hermes", "Connect only — cannot run repository missions yet"],
            ["Claude Code", "claude_code", "Consensus planning. Analysis and change still need Codex."],
            ["Generic Agent", "generic_remote", "Connect only — cannot run repository missions yet"],
          ].map(([label, id, capability]) => (
            <Link className="first-run-agent" href={`/onboarding?agent=${id}`} key={id}>
              <span>
                {label}
                <small>{capability}</small>
              </span>
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
    <section className="home-attention-banner" role="status">
      <div>
        <p className="section-label">{workspaceName}</p>
        <h2>Reconnect your Mission Agent.</h2>
        <p>Your agent and repositories are still registered, but its recent heartbeat has expired.</p>
      </div>
      <div>
        <code>mission-agent status</code>
        <code>mission-agent service install</code>
        <p>Once a fresh heartbeat arrives, the live repository mission will unlock automatically.</p>
        <Link className="launch-button onboarding-action" href="/onboarding">
          View connection status →
        </Link>
      </div>
    </section>
  );
}

function RepositoryRequiredHome({ workspaceName }: { workspaceName: string }) {
  return (
    <section className="home-attention-banner" role="status">
      <div>
        <p className="section-label">{workspaceName}</p>
        <h2>Register your first repository.</h2>
        <p>Your agent is connected, but it needs a repository before it can receive work.</p>
      </div>
      <div>
        <code>mission-agent repository add /path/to/repository</code>
        <p>The page will unlock live repository missions after the repository is registered.</p>
        <Link className="launch-button" href="/onboarding">
          View connection status →
        </Link>
      </div>
    </section>
  );
}
