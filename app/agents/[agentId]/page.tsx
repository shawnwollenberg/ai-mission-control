import Link from "next/link";
import { getAgentDetail } from "@/application/registry";
import { requirePageIdentity } from "@/lib/page-auth";
import CredentialControls from "./credential-controls";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const identity = await requirePageIdentity("/agents");
  const { agent, executions, credentials, resources, deliveries, artifacts, securityEvents } = await getAgentDetail(
    identity.workspaceId,
    (await params).agentId,
  );
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
            {agent.adapter_type === "codex"
              ? "Live Codex agent"
              : agent.adapter_type === "remote_http"
                ? "Live Hermes agent"
                : "Simulated agent"}
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
          {agent.adapter_type === "remote_http" && (
            <>
              <p>Protocol: {(agent.protocol_versions ?? []).join(", ")}</p>
              <p>Endpoint: {agent.endpoint}</p>
              <p>Credential status: {agent.credential_status}</p>
            </>
          )}
          <p>
            Last heartbeat: {agent.last_heartbeat_at ? new Date(agent.last_heartbeat_at).toLocaleString() : "Never"}
          </p>
          <h3>Capabilities</h3>
          <p>{agent.capabilities.join(" · ")}</p>
          <h3>Domains</h3>
          <p>{agent.supported_domains.join(" · ")}</p>
          {agent.adapter_type === "remote_http" && <CredentialControls agentId={agent.agent_id} />}
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
      {agent.adapter_type === "remote_http" && (
        <section className="durable-grid">
          <section className="command-panel">
            <h2>Credential versions</h2>
            {credentials.map((item) => (
              <div className="log-item" key={item.credential_id}>
                <div>
                  <strong>
                    Version {item.version} · {item.status}
                  </strong>
                  <small>
                    Created {new Date(item.created_at).toLocaleString()} · Last used{" "}
                    {item.last_used_at ? new Date(item.last_used_at).toLocaleString() : "Never"} · Verified{" "}
                    {item.verified_at ? new Date(item.verified_at).toLocaleString() : "Pending"}
                  </small>
                </div>
              </div>
            ))}
          </section>
          <section className="command-panel">
            <h2>Resource permissions</h2>
            {resources.length ? (
              resources.map((item) => (
                <p key={`${item.resource_type}:${item.resource_id}`}>
                  {item.resource_type}/{item.resource_id}: {item.permissions.join(", ")}
                </p>
              ))
            ) : (
              <p>No resource permissions granted.</p>
            )}
            <h2>Recent deliveries</h2>
            {deliveries.map((item, index) => (
              <p key={index}>
                {item.message_type}: {item.status} · {item.attempt_count} attempt(s)
              </p>
            ))}
          </section>
          <section className="command-panel">
            <h2>Recent artifacts</h2>
            {artifacts.length ? (
              artifacts.map((item) => (
                <p key={item.artifact_id}>
                  {item.kind} · {item.media_type} · {item.byte_size} bytes
                </p>
              ))
            ) : (
              <p>No artifacts.</p>
            )}
          </section>
          <section className="command-panel">
            <h2>Security events</h2>
            {securityEvents.length ? (
              securityEvents.map((item, index) => (
                <p key={index}>
                  {item.reason_code} · {new Date(item.occurred_at).toLocaleString()}
                </p>
              ))
            ) : (
              <p>No recent security failures.</p>
            )}
          </section>
        </section>
      )}
    </main>
  );
}
