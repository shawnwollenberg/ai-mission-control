import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { appendEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { deriveSigningKey } from "@/remote-agent/protocol";
import type { RegistryActor } from "@/application/registry";

const allowedCapabilities = new Set([
  "repository.read",
  "repository.write",
  "code.implement",
  "code.review",
  "test.run",
  "git.commit",
  "artifact.create",
  "metrics.read",
  "logs.read",
  "alert.analyze",
  "incident.create",
  "remediation.recommend",
  "health.verify",
  "portfolio.read",
  "market.read",
  "protocol.read",
  "position.analyze",
  "transaction.simulate",
  "strategy.recommend",
  "web.research",
  "document.read",
  "content.draft",
  "content.review",
  "report.create",
  "summary.create",
]);
function requireOwner(actor: RegistryActor) {
  if (actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
}
function validateEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ValidationFailedError("Remote endpoint must be HTTP(S) without embedded credentials");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new ValidationFailedError("Production remote endpoints require HTTPS");
  return url.toString();
}
async function projectRegistration(client: PoolClient, events: DomainEvent[], secretVerifier: string) {
  const registered = events.find((event) => event.eventType === "agent.registered")!;
  const credential = events.find((event) => event.eventType === "agent.credential_created")!;
  const p = registered.payload;
  await client.query(
    `INSERT INTO agents(workspace_id,agent_id,name,description,adapter_type,capabilities,supported_domains,trust_level,status,concurrency_limit,endpoint,protocol_versions,allowed_callback_actions,credential_status,credential_rotated_at) VALUES($1,$2,$3,$4,'remote_http',$5,$6,$7,'offline',$8,$9,$10,$11,'active',$12)`,
    [
      registered.workspaceId,
      registered.aggregateId,
      p.name,
      p.description ?? null,
      JSON.stringify(p.capabilities),
      JSON.stringify(p.supportedDomains),
      p.trustLevel,
      p.concurrencyLimit,
      p.endpoint,
      JSON.stringify(p.protocolVersions),
      JSON.stringify(p.allowedCallbackActions),
      credential.occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO agent_credentials(workspace_id,credential_id,agent_id,version,secret_verifier,status,allowed_protocol_versions,created_at,expires_at) VALUES($1,$2,$3,1,$4,'active',$5,$6,$7)`,
    [
      registered.workspaceId,
      credential.payload.credentialId,
      registered.aggregateId,
      secretVerifier,
      JSON.stringify(credential.payload.allowedProtocolVersions),
      credential.occurredAt,
      credential.payload.expiresAt ?? null,
    ],
  );
}
export async function registerRemoteAgent(input: {
  actor: RegistryActor;
  name: string;
  description?: string;
  endpoint: string;
  capabilities: string[];
  supportedDomains: string[];
  concurrencyLimit?: number;
  trustLevel?: string;
  expiresAt?: string;
}) {
  requireOwner(input.actor);
  if (!input.name.trim()) throw new ValidationFailedError("Agent name is required");
  if (!input.capabilities.length || input.capabilities.some((capability) => !allowedCapabilities.has(capability)))
    throw new ValidationFailedError("Remote agent capabilities contain unsupported or prohibited values");
  const agentId = randomUUID(),
    credentialId = randomUUID(),
    secret = `mc_agent_${randomBytes(32).toString("base64url")}`,
    verifier = deriveSigningKey(secret),
    now = new Date().toISOString();
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "agent",
    aggregateId: agentId,
    expectedVersion: 0,
    commandId: randomUUID(),
    commandType: "RegisterRemoteAgent",
    correlationId: agentId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "agent.registered",
        eventSchemaVersion: 1,
        occurredAt: now,
        payload: {
          name: input.name.trim(),
          description: input.description?.trim(),
          adapterType: "remote_http",
          endpoint: validateEndpoint(input.endpoint),
          capabilities: Array.from(new Set(input.capabilities)).sort(),
          supportedDomains: Array.from(new Set(input.supportedDomains)).sort(),
          concurrencyLimit: input.concurrencyLimit ?? 1,
          trustLevel: input.trustLevel ?? "controlled",
          protocolVersions: ["1.0"],
          allowedCallbackActions: [
            "execution.lifecycle",
            "artifact.submit",
            "approval.request",
            "capabilities.report",
            "heartbeat.report",
          ],
        },
      },
      {
        eventType: "agent.credential_created",
        eventSchemaVersion: 1,
        occurredAt: now,
        payload: { credentialId, version: 1, allowedProtocolVersions: ["1.0"], expiresAt: input.expiresAt ?? null },
      },
    ],
    applyProjections: (client, events) => projectRegistration(client, events, verifier),
  });
  return { agentId, credential: { credentialId, secret, protocolVersion: "1.0", displayedOnce: true } };
}
export async function getRemoteAgentAuth(agentId: string, credentialId: string) {
  const row = (
    await getDatabasePool().query<{
      workspace_id: string;
      agent_id: string;
      endpoint: string;
      status: string;
      credential_id: string;
      secret_verifier: string;
      credential_status: string;
      expires_at: Date | null;
      revoked_at: Date | null;
      allowed_protocol_versions: string[];
    }>(
      `SELECT a.workspace_id,a.agent_id,a.endpoint,a.status,a.credential_status,c.credential_id,c.secret_verifier,c.expires_at,c.revoked_at,c.allowed_protocol_versions FROM agents a JOIN agent_credentials c ON c.workspace_id=a.workspace_id AND c.agent_id=a.agent_id WHERE a.agent_id=$1 AND c.credential_id=$2`,
      [agentId, credentialId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Agent credential");
  if (
    row.status === "disabled" ||
    row.credential_status === "revoked" ||
    row.revoked_at ||
    (row.expires_at && row.expires_at.getTime() <= Date.now())
  )
    throw new ValidationFailedError("Agent credential is not active");
  return row;
}
