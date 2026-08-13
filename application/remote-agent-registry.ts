import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { deriveSigningKey } from "@/remote-agent/protocol";
import type { RegistryActor } from "@/application/registry";
import { parseAgentProviderProfile, type AgentProviderProfile } from "@/domain/agent-provider";
import { canonicalHash } from "@/lib/canonical-json";

const allowedCapabilities = new Set([
  "repository.read",
  "repository.write",
  "repository.isolated_worktree_write",
  "code.implement",
  "code.review",
  "test.run",
  "git.commit",
  "git.commit_local",
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
  "plan.generate",
  "plan.critique",
  "plan.revise",
  "plan.review",
  "project_brain.context",
]);
function requireOwner(actor: RegistryActor) {
  if (actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
}
function validateEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ValidationFailedError("Remote endpoint must be HTTP(S) without embedded credentials");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !loopback)
    throw new ValidationFailedError("Production remote endpoints require HTTPS");
  return url.toString();
}
async function projectRegistration(client: PoolClient, events: DomainEvent[], secretVerifier: string) {
  const registered = events.find((event) => event.eventType === "agent.registered")!;
  const credential = events.find((event) => event.eventType === "agent.credential_created")!;
  const p = registered.payload;
  const providerProfile = parseAgentProviderProfile(p.providerProfile);
  const capabilityAttestation = p.capabilityAttestation as Record<string, unknown>;
  await client.query(
    `INSERT INTO agents(workspace_id,agent_id,name,description,adapter_type,capabilities,supported_domains,trust_level,status,concurrency_limit,endpoint,protocol_versions,allowed_callback_actions,credential_status,credential_rotated_at,delivery_mode,mission_agent_adapter,provider_id,agent_version,supported_mission_roles,supported_operations,supported_models,model_capabilities,capability_attestation_hash,capability_attestation_version,capability_source,capability_attested_at,capability_attestation_expires_at,structured_output,project_brain_context,repository_mutation,provider_runtime_requirements_id,provider_runtime_requirements_hash) VALUES($1,$2,$3,$4,'remote_http',$5,$6,$7,'offline',$8,$9,$10,$11,'active',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
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
      p.deliveryMode ?? "push",
      p.missionAgentAdapter ?? null,
      providerProfile.provider,
      providerProfile.agentVersion,
      JSON.stringify(providerProfile.supportedMissionRoles),
      JSON.stringify(providerProfile.supportedOperations),
      JSON.stringify(providerProfile.supportedModels),
      JSON.stringify(providerProfile.modelCapabilities),
      capabilityAttestation.attestationHash,
      providerProfile.capabilityAttestationVersion,
      providerProfile.capabilitySource,
      capabilityAttestation.advertisedAt,
      capabilityAttestation.expiresAt,
      providerProfile.structuredOutput,
      providerProfile.projectBrainContext,
      providerProfile.repositoryMutation,
      providerProfile.runtimeRequirements!.requirementsId,
      providerProfile.runtimeRequirements!.requirementsHash,
    ],
  );
  await client.query(
    `INSERT INTO agent_model_capability_attestations(
       workspace_id,capability_attestation_id,agent_id,provider_id,agent_version,
       attestation_version,capability_source,supported_models,model_capabilities,
       provider_runtime_requirements_id,provider_runtime_requirements_hash,attestation_hash,
       advertised_at,expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      registered.workspaceId,
      capabilityAttestation.attestationId,
      registered.aggregateId,
      providerProfile.provider,
      providerProfile.agentVersion,
      providerProfile.capabilityAttestationVersion,
      providerProfile.capabilitySource,
      JSON.stringify(providerProfile.supportedModels),
      JSON.stringify(providerProfile.modelCapabilities),
      providerProfile.runtimeRequirements!.requirementsId,
      providerProfile.runtimeRequirements!.requirementsHash,
      capabilityAttestation.attestationHash,
      capabilityAttestation.advertisedAt,
      capabilityAttestation.expiresAt,
    ],
  );
  await client.query(
    `UPDATE agents SET capability_attestation_id=$3
     WHERE workspace_id=$1 AND agent_id=$2`,
    [registered.workspaceId, registered.aggregateId, capabilityAttestation.attestationId],
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
  deliveryMode?: "push" | "pull";
  missionAgentAdapter?: "codex" | "hermes" | "claude-code" | "generic";
  providerProfile?: AgentProviderProfile;
}) {
  requireOwner(input.actor);
  if (!input.name.trim()) throw new ValidationFailedError("Agent name is required");
  if (!input.capabilities.length || input.capabilities.some((capability) => !allowedCapabilities.has(capability)))
    throw new ValidationFailedError("Remote agent capabilities contain unsupported or prohibited values");
  const inferredProvider =
    input.missionAgentAdapter === "claude-code"
      ? "claude_code"
      : input.missionAgentAdapter === "codex"
        ? "codex"
        : input.missionAgentAdapter === "hermes"
          ? "hermes"
          : "generic";
  const providerProfile = parseAgentProviderProfile(
    input.providerProfile ?? {
      provider: inferredProvider,
      agent_version: "unreported",
      supported_mission_roles: [],
      supported_operations: ["inspect_repository"],
      supported_models: ["default"],
      model_capabilities: [
        {
          model_id: "default",
          display_name: "Default provider model (unverified)",
          provider: inferredProvider,
          // Legacy registrations remain deliberately ineligible for every
          // consensus role until an owner approves a complete attestation.
          supported_roles: ["implementation_reviewer"],
          supported_operations: ["inspect_repository"],
          structured_output: false,
          repository_read: true,
          repository_mutation: false,
          plan_mode: true,
          runtime_model_identity: "unverifiable",
        },
      ],
      capability_attestation_version: 1,
      capability_source: "operator_allowlist",
      structured_output: false,
      project_brain_context: false,
      repository_mutation: false,
    },
  );
  if (providerProfile.provider !== inferredProvider)
    throw new ValidationFailedError("Provider profile does not match the registered Mission Agent adapter");
  const agentId = randomUUID(),
    credentialId = randomUUID(),
    secret = `mc_agent_${randomBytes(32).toString("base64url")}`,
    verifier = deriveSigningKey(secret),
    now = new Date().toISOString();
  const capabilityAttestation = {
    attestationId: randomUUID(),
    attestationHash: canonicalHash({
      agentId,
      provider: providerProfile.provider,
      agentVersion: providerProfile.agentVersion,
      attestationVersion: providerProfile.capabilityAttestationVersion,
      capabilitySource: providerProfile.capabilitySource,
      supportedModels: providerProfile.supportedModels,
      modelCapabilities: providerProfile.modelCapabilities,
      runtimeRequirements: providerProfile.runtimeRequirements,
    }),
    advertisedAt: now,
    expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
  };
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
          deliveryMode: input.deliveryMode ?? "push",
          missionAgentAdapter: input.missionAgentAdapter,
          providerProfile,
          capabilityAttestation,
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
      credential_record_status: string;
      credential_id: string;
      secret_verifier: string;
      credential_status: string;
      expires_at: Date | null;
      revoked_at: Date | null;
      allowed_protocol_versions: string[];
      delivery_mode: "push" | "pull";
    }>(
      `SELECT a.workspace_id,a.agent_id,a.endpoint,a.status,a.credential_status,a.delivery_mode,c.credential_id,c.status credential_record_status,c.secret_verifier,c.expires_at,c.revoked_at,c.allowed_protocol_versions FROM agents a JOIN agent_credentials c ON c.workspace_id=a.workspace_id AND c.agent_id=a.agent_id WHERE a.agent_id=$1 AND c.credential_id=$2`,
      [agentId, credentialId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Agent credential");
  if (
    row.status === "disabled" ||
    row.credential_status === "revoked" ||
    !["active", "pending_verification", "expiring"].includes(row.credential_record_status) ||
    row.revoked_at ||
    (row.expires_at && row.expires_at.getTime() <= Date.now())
  )
    throw new ValidationFailedError("Agent credential is not active");
  return row;
}

export async function rotateRemoteAgentCredential(input: {
  actor: RegistryActor;
  agentId: string;
  overlapSeconds?: number;
  expiresAt?: string;
}) {
  requireOwner(input.actor);
  const overlapSeconds = Math.min(Math.max(input.overlapSeconds ?? 300, 30), 3600);
  const current = (
    await getDatabasePool().query<{ version: number }>(
      "SELECT version FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 ORDER BY version DESC LIMIT 1",
      [input.actor.workspaceId, input.agentId],
    )
  ).rows[0];
  if (!current) throw new NotFoundError("Agent credential");
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "agent",
    aggregateId: input.agentId,
  });
  const credentialId = randomUUID();
  const version = current.version + 1;
  const secret = `mc_agent_${randomBytes(32).toString("base64url")}`;
  const verifier = deriveSigningKey(secret);
  const overlapEndsAt = new Date(Date.now() + overlapSeconds * 1000).toISOString();
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "agent",
    aggregateId: input.agentId,
    expectedVersion: events.length,
    commandId: randomUUID(),
    commandType: "RotateRemoteAgentCredential",
    correlationId: input.agentId,
    causationId: events.at(-1)?.eventId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "agent.credential_rotation_requested",
        eventSchemaVersion: 1,
        payload: { credentialId, version, overlapEndsAt, expiresAt: input.expiresAt ?? null },
      },
    ],
    applyProjections: async (client, appended) => {
      await client.query(
        `UPDATE agent_credentials SET status='expiring',overlap_ends_at=$3,rotated_at=$4 WHERE workspace_id=$1 AND agent_id=$2 AND status='active'`,
        [input.actor.workspaceId, input.agentId, overlapEndsAt, appended[0].occurredAt],
      );
      await client.query(
        `INSERT INTO agent_credentials(workspace_id,credential_id,agent_id,version,secret_verifier,status,allowed_protocol_versions,created_at,expires_at,overlap_ends_at) VALUES($1,$2,$3,$4,$5,'pending_verification','["1.0"]',$6,$7,$8)`,
        [
          input.actor.workspaceId,
          credentialId,
          input.agentId,
          version,
          verifier,
          appended[0].occurredAt,
          input.expiresAt ?? null,
          overlapEndsAt,
        ],
      );
      await client.query(
        "UPDATE agents SET credential_status='rotating',credential_rotated_at=$3,updated_at=$3 WHERE workspace_id=$1 AND agent_id=$2",
        [input.actor.workspaceId, input.agentId, appended[0].occurredAt],
      );
    },
  });
  return {
    agentId: input.agentId,
    credential: { credentialId, version, secret, protocolVersion: "1.0", overlapEndsAt, displayedOnce: true },
    eventId: result.events[0].eventId,
  };
}

export async function revokeRemoteAgentCredential(input: {
  actor: RegistryActor;
  agentId: string;
  credentialId?: string;
  revokeAll?: boolean;
  emergency?: boolean;
}) {
  requireOwner(input.actor);
  if (!input.revokeAll && !input.credentialId) throw new ValidationFailedError("Credential ID is required");
  const target = input.revokeAll
    ? undefined
    : (
        await getDatabasePool().query<{ version: number; status: string }>(
          "SELECT version,status FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 AND credential_id=$3",
          [input.actor.workspaceId, input.agentId, input.credentialId],
        )
      ).rows[0];
  if (!input.revokeAll && !target) throw new NotFoundError("Agent credential");
  if (!input.emergency && !input.revokeAll) {
    const verifiedReplacement = await getDatabasePool().query(
      "SELECT 1 FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 AND version>$3 AND status='active' AND verified_at IS NOT NULL LIMIT 1",
      [input.actor.workspaceId, input.agentId, target!.version],
    );
    if (!verifiedReplacement.rowCount)
      throw new ValidationFailedError("A verified replacement credential is required before normal revocation");
  }
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "agent",
    aggregateId: input.agentId,
  });
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "agent",
    aggregateId: input.agentId,
    expectedVersion: events.length,
    commandId: randomUUID(),
    commandType: input.revokeAll ? "RevokeAllRemoteAgentCredentials" : "RevokeRemoteAgentCredential",
    correlationId: input.agentId,
    causationId: events.at(-1)?.eventId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: input.revokeAll ? "agent.credentials_revoked" : "agent.credential_revoked",
        eventSchemaVersion: 1,
        payload: {
          credentialId: input.credentialId ?? null,
          emergency: Boolean(input.emergency),
          revokeAll: Boolean(input.revokeAll),
        },
      },
    ],
    applyProjections: async (client, appended) => {
      await client.query(
        `UPDATE agent_credentials SET status='revoked',revoked_at=$4 WHERE workspace_id=$1 AND agent_id=$2 AND ($3::uuid IS NULL OR credential_id=$3) AND status<>'revoked'`,
        [input.actor.workspaceId, input.agentId, input.revokeAll ? null : input.credentialId, appended[0].occurredAt],
      );
      const active = await client.query(
        "SELECT 1 FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('active','pending_verification','expiring') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1",
        [input.actor.workspaceId, input.agentId],
      );
      await client.query(
        "UPDATE agents SET credential_status=$3,status=CASE WHEN $3='revoked' THEN 'disabled' ELSE status END,updated_at=$4 WHERE workspace_id=$1 AND agent_id=$2",
        [input.actor.workspaceId, input.agentId, active.rowCount ? "active" : "revoked", appended[0].occurredAt],
      );
    },
  });
  return { revoked: true, eventId: result.events[0].eventId };
}

export async function listAgentCredentials(workspaceId: string, agentId: string) {
  return (
    await getDatabasePool().query(
      `SELECT credential_id,version,status,created_at,last_used_at,verified_at,expires_at,overlap_ends_at,revoked_at FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 ORDER BY version DESC`,
      [workspaceId, agentId],
    )
  ).rows;
}
