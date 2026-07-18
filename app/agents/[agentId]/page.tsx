import Link from "next/link";
import { getAgentDetail } from "@/application/registry";
import { requirePageIdentity } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const identity = await requirePageIdentity("/agents");
  const { agent, executions } = await getAgentDetail(identity.workspaceId, (await params).agentId);
  return (
    <main className="durable-mission-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Agent detail</p>
        </div>
        <Link className="nav-link" href="/agents">
          Agent registry
        </Link>
      </nav>
      <header className="mission-header compact">
        <div>
          <p className="section-label">
            {agent.adapter_type === "codex" ? "Connected Codex agent" : "Simulated agent"}
          </p>
          <h1>{agent.name}</h1>
          <p>{agent.description || "No description provided."}</p>
        </div>
        <div className="status-badge">{agent.effective_status}</div>
      </header>
      <section className="durable-grid">
        <section className="command-panel">
          <h2>Runtime</h2>
          <p>
            Concurrency: {agent.current_execution_count}/{agent.concurrency_limit}
          </p>
          <p>Trust level: {agent.trust_level}</p>
          <p>
            Last heartbeat: {agent.last_heartbeat_at ? new Date(agent.last_heartbeat_at).toLocaleString() : "Never"}
          </p>
          <h3>Capabilities</h3>
          <p>{agent.capabilities.join(" · ")}</p>
        </section>
        <section className="command-panel">
          <h2>Recent executions</h2>
          <div className="log-list">
            {executions.length === 0 ? (
              <p>No executions yet.</p>
            ) : (
              executions.map((execution) => (
                <div className="log-item" key={execution.execution_id}>
                  <span className="log-sequence">{execution.status.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{execution.progress_summary || execution.stage || "Execution requested"}</strong>
                    <small>
                      {execution.status} · {new Date(execution.created_at).toLocaleString()}
                    </small>
                    {execution.commit_id && <p>Commit {execution.commit_id}</p>}
                    <Link href={`/missions/${execution.mission_id}`}>View mission</Link>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
