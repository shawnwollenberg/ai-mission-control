import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalHash } from "@/lib/canonical-json";
import { getDatabasePool } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { appendEvents, type DomainEvent } from "@/lib/postgres-event-store";

export const LEGACY_IDENTITY_VERSION = "legacy-v1";
export const STABLE_IDENTITY_VERSION = "stable-v2";
export const STABLE_IDENTITY_PROTOCOL_VERSION = "2";
export const ACTIVATION_ACKNOWLEDGEMENT_VERSION = "1";
export const MISSION_AGENT_069_CHECKSUM = "a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af";

export type RemoteCandidate = { name: string; url: string };
export type CanonicalRepositoryIdentity = {
  identityVersion: typeof STABLE_IDENTITY_VERSION;
  canonicalRemoteUrl: string;
  repositoryName: string;
  selectedRemote: string;
  fingerprint: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalizeRemoteUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new ValidationFailedError("A Git remote URL is required");
  let host: string;
  let pathname: string;
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ValidationFailedError("The Git remote URL is not canonicalizable");
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol))
      throw new ValidationFailedError("The Git remote protocol is unsupported");
    if (parsed.password || (parsed.protocol !== "ssh:" && parsed.username))
      throw new ValidationFailedError("The Git remote URL must not contain credentials");
    const defaults: Record<string, string> = { "http:": "80", "https:": "443", "ssh:": "22", "git:": "9418" };
    host = `${parsed.hostname}${parsed.port && parsed.port !== defaults[parsed.protocol] ? `:${parsed.port}` : ""}`;
    pathname = parsed.pathname;
  }
  const cleanPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !cleanPath || cleanPath.split("/").some((part) => !part || part === "." || part === ".."))
    throw new ValidationFailedError("The Git remote identity is ambiguous");
  return `${host.toLowerCase()}/${cleanPath.normalize("NFC")}`;
}

export function deriveStableRepositoryIdentity(input: {
  remotes: RemoteCandidate[];
  repositoryName: string;
}): CanonicalRepositoryIdentity {
  const remotes = input.remotes
    .filter((remote) => remote.name.trim() && remote.url.trim())
    .map((remote) => ({ name: remote.name.trim(), url: remote.url.trim() }));
  const origin = remotes.filter((remote) => remote.name === "origin");
  const selected =
    origin.length === 1 ? origin[0] : origin.length === 0 && remotes.length === 1 ? remotes[0] : undefined;
  if (!selected)
    throw new ValidationFailedError(
      remotes.length
        ? "Repository remotes are ambiguous; an exact origin is required"
        : "Local-only repositories are not migration eligible",
    );
  const canonicalRemoteUrl = canonicalizeRemoteUrl(selected.url);
  const remoteName = canonicalRemoteUrl.slice(canonicalRemoteUrl.lastIndexOf("/") + 1);
  const repositoryName = input.repositoryName.trim().normalize("NFC");
  if (!repositoryName || repositoryName !== remoteName)
    throw new ValidationFailedError("Repository name does not exactly match the selected canonical remote");
  return {
    identityVersion: STABLE_IDENTITY_VERSION,
    canonicalRemoteUrl,
    repositoryName,
    selectedRemote: selected.name,
    fingerprint: sha256(`${canonicalRemoteUrl}\n${repositoryName}`),
  };
}

type MigrationSnapshot = {
  repositoryId: string;
  agentId: string;
  legacyFingerprint: string;
  legacyCreatedAt: string;
  legacyCanonicalRemoteUrl: string | null;
  legacySelectedRemote: string | null;
  legacyVerificationSource: string;
  legacyVerifiedAt: string | null;
  stableFingerprint: string;
  canonicalRemoteUrl: string;
  repositoryName: string;
  registeredPath: string;
  currentHead: string;
  selectedRemote: string;
  permissions: Record<string, unknown>;
  projectBrainEnabled: boolean;
};

type RepositoryIdentityEventPayload = Partial<MigrationSnapshot> & {
  requestFingerprint?: string;
  expiresAt?: string;
  approvedBy?: string;
  activationRequest?: Record<string, unknown>;
  activationRequestChecksum?: string;
  activationRequestId?: string;
  activationExpiresAt?: string;
  activationAcknowledgement?: Record<string, unknown>;
  activationAcknowledgementChecksum?: string;
};

export function repositoryIdentityRequestFingerprint(snapshot: MigrationSnapshot) {
  return canonicalHash(snapshot);
}

async function applyRepositoryIdentityProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    const payload = event.payload as RepositoryIdentityEventPayload;
    if (event.eventType === "repository.identity_migration.previewed") {
      await client.query(
        `INSERT INTO repository_identity_migrations(
          workspace_id,migration_id,repository_id,agent_id,status,request_fingerprint,legacy_fingerprint,
          stable_fingerprint,canonical_remote_url,repository_name,registered_path,current_head,selected_remote,
          permission_snapshot,project_brain_enabled,legacy_created_at,legacy_canonical_remote_url,
          legacy_selected_remote,legacy_verification_source,legacy_verified_at,aggregate_version,previewed_at,expires_at,last_event_id)
         VALUES($1,$2,$3,$4,'previewed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT(workspace_id,migration_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,last_event_id=EXCLUDED.last_event_id`,
        [
          event.workspaceId,
          event.aggregateId,
          payload.repositoryId,
          payload.agentId,
          payload.requestFingerprint,
          payload.legacyFingerprint,
          payload.stableFingerprint,
          payload.canonicalRemoteUrl,
          payload.repositoryName,
          payload.registeredPath,
          payload.currentHead,
          payload.selectedRemote,
          payload.permissions,
          payload.projectBrainEnabled,
          payload.legacyCreatedAt,
          payload.legacyCanonicalRemoteUrl,
          payload.legacySelectedRemote,
          payload.legacyVerificationSource,
          payload.legacyVerifiedAt,
          event.aggregateVersion,
          event.occurredAt,
          payload.expiresAt,
          event.eventId,
        ],
      );
    } else if (
      event.eventType === "repository.identity_migration.requested" ||
      event.eventType === "repository.identity_migration.started" ||
      event.eventType === "repository.identity_migration.verified"
    ) {
      await client.query(
        `UPDATE repository_identity_migrations SET aggregate_version=$3,last_event_id=$4
         WHERE workspace_id=$1 AND migration_id=$2`,
        [event.workspaceId, event.aggregateId, event.aggregateVersion, event.eventId],
      );
    } else if (event.eventType === "repository.identity_migration.approved") {
      await client.query(
        `UPDATE repository_identity_migrations SET status='approved',approved_by=$3,approved_at=$4,
         aggregate_version=$5,last_event_id=$6 WHERE workspace_id=$1 AND migration_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          payload.approvedBy,
          event.occurredAt,
          event.aggregateVersion,
          event.eventId,
        ],
      );
    } else if (event.eventType === "repository.identity_activation.requested") {
      await client.query(
        `UPDATE repository_identity_migrations SET status='awaiting_agent_activation',
         activation_request=$3,activation_request_checksum=$4,activation_request_id=$5,
         activation_requested_at=$6,activation_expires_at=$7,aggregate_version=$8,last_event_id=$9
         WHERE workspace_id=$1 AND migration_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          payload.activationRequest,
          payload.activationRequestChecksum,
          payload.activationRequestId,
          event.occurredAt,
          payload.activationExpiresAt,
          event.aggregateVersion,
          event.eventId,
        ],
      );
      await client.query(
        `UPDATE repositories SET identity_migration_status='awaiting_agent_activation',updated_at=$3
         WHERE workspace_id=$1 AND repository_id=$2`,
        [event.workspaceId, payload.repositoryId, event.occurredAt],
      );
    } else if (event.eventType === "repository.identity_activation.acknowledged") {
      await client.query(
        `UPDATE repository_identity_migrations SET status='agent_activated',
         activation_acknowledgement=$3,activation_acknowledgement_checksum=$4,
         activation_acknowledged_at=$5,aggregate_version=$6,last_event_id=$7
         WHERE workspace_id=$1 AND migration_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          payload.activationAcknowledgement,
          payload.activationAcknowledgementChecksum,
          event.occurredAt,
          event.aggregateVersion,
          event.eventId,
        ],
      );
    } else if (event.eventType === "repository.identity_activation.completed") {
      await client.query(
        `UPDATE repository_identity_migrations SET status='completed',completed_at=$3,
         aggregate_version=$4,last_event_id=$5 WHERE workspace_id=$1 AND migration_id=$2`,
        [event.workspaceId, event.aggregateId, event.occurredAt, event.aggregateVersion, event.eventId],
      );
      await client.query(
        `UPDATE repositories SET identity_migration_status='completed',updated_at=$3
         WHERE workspace_id=$1 AND repository_id=$2 AND identity_version='stable-v2'
           AND identity_migration_status='agent_activated'`,
        [event.workspaceId, payload.repositoryId, event.occurredAt],
      );
    } else if (event.eventType === "repository.identity_migration.completed") {
      await client.query(
        `INSERT INTO repository_identities(
          workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
          selected_remote,created_at,verified_at,verification_source,migration_status,superseded_fingerprint,migration_event_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'mission-control+mission-agent','completed',$9,$10)
         ON CONFLICT(workspace_id,repository_id,identity_version,fingerprint) DO NOTHING`,
        [
          event.workspaceId,
          payload.repositoryId,
          STABLE_IDENTITY_VERSION,
          payload.stableFingerprint,
          payload.canonicalRemoteUrl,
          payload.repositoryName,
          payload.selectedRemote,
          event.occurredAt,
          payload.legacyFingerprint,
          event.eventId,
        ],
      );
      await client.query(
        `INSERT INTO repository_identities(
          workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,selected_remote,
          created_at,verified_at,verification_source,migration_status,migration_event_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'superseded',$11)
         ON CONFLICT(workspace_id,repository_id,identity_version,fingerprint)
         DO UPDATE SET migration_status='superseded',migration_event_id=EXCLUDED.migration_event_id`,
        [
          event.workspaceId,
          payload.repositoryId,
          LEGACY_IDENTITY_VERSION,
          payload.legacyFingerprint,
          payload.legacyCanonicalRemoteUrl,
          payload.repositoryName,
          payload.legacySelectedRemote,
          payload.legacyCreatedAt,
          payload.legacyVerifiedAt,
          payload.legacyVerificationSource,
          event.eventId,
        ],
      );
      await client.query(
        `UPDATE repository_identities SET migration_status='superseded',verified_at=COALESCE(verified_at,$4),
         migration_event_id=$5 WHERE workspace_id=$1 AND repository_id=$2 AND identity_version=$3`,
        [event.workspaceId, payload.repositoryId, LEGACY_IDENTITY_VERSION, event.occurredAt, event.eventId],
      );
      await client.query(
        `UPDATE repositories SET repository_fingerprint=$3,local_path='mission-agent://' || $3,
         identity_version=$4,identity_migration_status='agent_activated',
         identity_last_verified_at=$5,updated_at=$5 WHERE workspace_id=$1 AND repository_id=$2`,
        [event.workspaceId, payload.repositoryId, payload.stableFingerprint, STABLE_IDENTITY_VERSION, event.occurredAt],
      );
      await client.query(
        `UPDATE repository_identity_migrations SET status='agent_activated',aggregate_version=$3,last_event_id=$4
         WHERE workspace_id=$1 AND migration_id=$2`,
        [event.workspaceId, event.aggregateId, event.aggregateVersion, event.eventId],
      );
    } else if (event.eventType === "repository.identity_migration.rolled_back") {
      await client.query(
        `UPDATE repository_identities SET migration_status=CASE
           WHEN identity_version=$3 AND fingerprint=$4 THEN 'active'
           WHEN identity_version=$5 AND fingerprint=$6 THEN 'rolled_back'
           ELSE migration_status END,
         migration_event_id=$7
         WHERE workspace_id=$1 AND repository_id=$2`,
        [
          event.workspaceId,
          payload.repositoryId,
          LEGACY_IDENTITY_VERSION,
          payload.legacyFingerprint,
          STABLE_IDENTITY_VERSION,
          payload.stableFingerprint,
          event.eventId,
        ],
      );
      await client.query(
        `UPDATE repositories SET repository_fingerprint=$3,local_path='mission-agent://' || $3,
         identity_version=$4,identity_migration_status='rolled_back',
         identity_last_verified_at=$5,updated_at=$5 WHERE workspace_id=$1 AND repository_id=$2`,
        [event.workspaceId, payload.repositoryId, payload.legacyFingerprint, LEGACY_IDENTITY_VERSION, event.occurredAt],
      );
      await client.query(
        `UPDATE repository_identity_migrations SET status='rolled_back',rolled_back_at=$3,aggregate_version=$4,last_event_id=$5
         WHERE workspace_id=$1 AND migration_id=$2`,
        [event.workspaceId, event.aggregateId, event.occurredAt, event.aggregateVersion, event.eventId],
      );
    }
  }
}

function repositoryAuthoritySnapshot(row: Record<string, unknown>) {
  return {
    readAllowed: row.read_allowed,
    writeAllowed: row.write_allowed,
    commitAllowed: row.commit_allowed,
    pushAllowed: row.push_allowed,
    pullRequestAllowed: row.pull_request_allowed,
    mergeAllowed: row.merge_allowed,
    deploymentAllowed: row.deployment_allowed,
    allowedAgentIds: row.allowed_agent_ids,
    resourcePermissions: row.resource_permissions ?? [],
    protectedBranches: row.protected_branches,
    allowedBranchPrefixes: row.allowed_branch_prefixes,
    allowedRemotes: row.allowed_remotes,
    validationCommands: row.validation_commands,
    providerType: row.provider_type,
    providerConfigurationReference: row.provider_configuration_reference,
  };
}

async function assertRepositoryIdentityTransition(
  client: PoolClient,
  input: {
    workspaceId: string;
    repositoryId: string;
    agentId: string;
    expectedVersion: "legacy-v1" | "stable-v2";
    expectedFingerprint: string;
    expectedHead: string;
    expectedRemote: string;
    expectedName: string;
    expectedPermissions: Record<string, unknown>;
    expectedProjectBrainEnabled: boolean;
  },
) {
  const current = (
    await client.query(
      `SELECT r.*,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'agentId',p.agent_id,'permissions',p.permissions,'revokedAt',p.revoked_at
        ) ORDER BY p.agent_id,p.created_at)
        FROM agent_resource_permissions p WHERE p.workspace_id=r.workspace_id
          AND p.resource_type='repository' AND p.resource_id=r.repository_id::text),'[]'::jsonb) resource_permissions,
        (SELECT count(*)::int FROM execution_projections e WHERE e.workspace_id=r.workspace_id
          AND e.repository_id=r.repository_id AND e.status NOT IN('succeeded','failed','timed_out','cancelled')) active_executions,
        (SELECT count(*)::int FROM pull_assignments p JOIN execution_projections e
          ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
          WHERE p.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
          AND p.status IN('leased','acknowledged')) active_leases
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2 FOR UPDATE`,
      [input.workspaceId, input.repositoryId],
    )
  ).rows[0];
  if (
    !current ||
    current.disabled_at ||
    current.identity_version !== input.expectedVersion ||
    current.repository_fingerprint !== input.expectedFingerprint ||
    current.local_path !== `mission-agent://${input.expectedFingerprint}` ||
    !Array.isArray(current.allowed_agent_ids) ||
    !current.allowed_agent_ids.includes(input.agentId) ||
    current.name !== input.expectedName ||
    current.observed_commit !== input.expectedHead ||
    !current.observed_remote_url ||
    (input.expectedVersion === STABLE_IDENTITY_VERSION
      ? current.observed_remote_url !== input.expectedRemote
      : canonicalizeRemoteUrl(current.observed_remote_url) !== input.expectedRemote) ||
    Number(current.active_executions) !== 0 ||
    Number(current.active_leases) !== 0 ||
    canonicalHash(repositoryAuthoritySnapshot(current)) !== canonicalHash(input.expectedPermissions) ||
    current.project_brain_enabled !== input.expectedProjectBrainEnabled
  )
    throw new ValidationFailedError("Repository migration eligibility changed after approval");
}

async function repositorySnapshot(workspaceId: string, repositoryId: string, agentId: string) {
  const row = (
    await getDatabasePool().query(
      `SELECT r.*,a.mission_agent_version,
        i.created_at legacy_created_at,i.canonical_remote_url legacy_canonical_remote_url,
        i.selected_remote legacy_selected_remote,i.verification_source legacy_verification_source,
        i.verified_at legacy_verified_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'agentId',p.agent_id,'permissions',p.permissions,'revokedAt',p.revoked_at
        ) ORDER BY p.agent_id,p.created_at)
        FROM agent_resource_permissions p WHERE p.workspace_id=r.workspace_id
          AND p.resource_type='repository' AND p.resource_id=r.repository_id::text),'[]'::jsonb) resource_permissions,
        (SELECT count(*)::int FROM execution_projections e WHERE e.workspace_id=r.workspace_id
          AND e.repository_id=r.repository_id AND e.status NOT IN('succeeded','failed','timed_out','cancelled')) active_executions,
        (SELECT count(*)::int FROM pull_assignments p JOIN execution_projections e
          ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
          WHERE p.workspace_id=r.workspace_id AND e.repository_id=r.repository_id
          AND p.status IN('leased','acknowledged')) active_leases
       FROM repositories r JOIN agents a ON a.workspace_id=r.workspace_id AND a.agent_id=$3
       LEFT JOIN repository_identities i ON i.workspace_id=r.workspace_id AND i.repository_id=r.repository_id
         AND i.identity_version='legacy-v1' AND i.fingerprint=r.repository_fingerprint
       WHERE r.workspace_id=$1 AND r.repository_id=$2 AND r.allowed_agent_ids ? $3::text`,
      [workspaceId, repositoryId, agentId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Repository mapping");
  return row;
}

export async function previewRepositoryIdentityMigration(input: {
  workspaceId: string;
  agentId: string;
  repositoryId: string;
  registeredPath: string;
  currentHead: string;
  remotes: RemoteCandidate[];
  repositoryName: string;
  agentLegacyFingerprint: string;
  migrationToolVersion: string;
}) {
  if (input.migrationToolVersion !== "1")
    throw new ValidationFailedError("Mission Agent does not support governed stable identity migration");
  const row = await repositorySnapshot(input.workspaceId, input.repositoryId, input.agentId);
  if (row.identity_version !== LEGACY_IDENTITY_VERSION || row.repository_fingerprint !== input.agentLegacyFingerprint)
    throw new ValidationFailedError("The legacy repository identity does not match the registered mapping");
  if (Number(row.active_executions) || Number(row.active_leases))
    throw new ValidationFailedError("Repository identity migration is blocked by active execution work");
  const identity = deriveStableRepositoryIdentity({ remotes: input.remotes, repositoryName: input.repositoryName });
  if (row.observed_remote_url && canonicalizeRemoteUrl(row.observed_remote_url) !== identity.canonicalRemoteUrl)
    throw new ValidationFailedError("Mission Control and Mission Agent derived different canonical remotes");
  if (row.name !== identity.repositoryName)
    throw new ValidationFailedError("Mission Control and Mission Agent derived different repository names");
  const permissions = repositoryAuthoritySnapshot(row);
  const snapshot: MigrationSnapshot = {
    repositoryId: input.repositoryId,
    agentId: input.agentId,
    legacyFingerprint: row.repository_fingerprint,
    legacyCreatedAt: new Date(row.legacy_created_at ?? row.created_at).toISOString(),
    legacyCanonicalRemoteUrl: row.legacy_canonical_remote_url ?? row.observed_remote_url ?? null,
    legacySelectedRemote: row.legacy_selected_remote ?? (row.observed_remote_url ? "origin" : null),
    legacyVerificationSource: row.legacy_verification_source ?? "legacy-registration",
    legacyVerifiedAt: row.legacy_verified_at ? new Date(row.legacy_verified_at).toISOString() : null,
    stableFingerprint: identity.fingerprint,
    canonicalRemoteUrl: identity.canonicalRemoteUrl,
    repositoryName: identity.repositoryName,
    registeredPath: input.registeredPath,
    currentHead: input.currentHead,
    selectedRemote: identity.selectedRemote,
    permissions,
    projectBrainEnabled: row.project_brain_enabled,
  };
  const requestFingerprint = repositoryIdentityRequestFingerprint(snapshot);
  const migrationId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: migrationId,
    expectedVersion: 0,
    commandId: randomUUID(),
    commandType: "PreviewRepositoryIdentityMigration",
    correlationId: input.repositoryId,
    actor: { type: "agent", id: input.agentId },
    events: [
      {
        eventType: "repository.identity_migration.previewed",
        eventSchemaVersion: 1,
        payload: {
          ...snapshot,
          requestFingerprint,
          expiresAt,
          safe: true,
          differences: ["identityVersion", "fingerprint"],
        },
      },
      {
        eventType: "repository.identity_migration.requested",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: input.repositoryId,
          requestFingerprint,
          approvalType: "repository_identity_migration",
        },
      },
    ],
    applyProjections: applyRepositoryIdentityProjection,
  });
  return {
    migrationId,
    ...snapshot,
    requestFingerprint,
    expiresAt,
    safe: true,
    ambiguities: [],
    requiredApproval: "repository_identity_migration",
  };
}

export async function approveRepositoryIdentityMigration(input: {
  workspaceId: string;
  migrationId: string;
  requestFingerprint: string;
  actorId: string;
}) {
  const row = (
    await getDatabasePool().query(
      `SELECT * FROM repository_identity_migrations WHERE workspace_id=$1 AND migration_id=$2`,
      [input.workspaceId, input.migrationId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Repository identity migration");
  if (
    row.status !== "previewed" ||
    row.request_fingerprint !== input.requestFingerprint ||
    Date.parse(row.expires_at) <= Date.now()
  )
    throw new ValidationFailedError(
      "Repository identity migration approval is stale or does not match the exact preview",
    );
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: input.migrationId,
    expectedVersion: row.aggregate_version,
    commandId: randomUUID(),
    commandType: "ApproveRepositoryIdentityMigration",
    correlationId: row.repository_id,
    actor: { type: "human", id: input.actorId },
    events: [
      {
        eventType: "repository.identity_migration.approved",
        eventSchemaVersion: 1,
        payload: { approvedBy: input.actorId, requestFingerprint: input.requestFingerprint },
      },
    ],
    applyProjections: applyRepositoryIdentityProjection,
  });
  return { migrationId: input.migrationId, status: "approved" as const };
}

export async function prepareRepositoryIdentityActivation(input: {
  workspaceId: string;
  agentId: string;
  migrationId: string;
  requestFingerprint: string;
  stableFingerprint: string;
  registeredPath: string;
  currentHead: string;
  signingKey: string;
}) {
  const row = (
    await getDatabasePool().query(
      `SELECT * FROM repository_identity_migrations WHERE workspace_id=$1 AND migration_id=$2 AND agent_id=$3`,
      [input.workspaceId, input.migrationId, input.agentId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Repository identity migration");
  if (row.status === "awaiting_agent_activation" && row.activation_request)
    return { status: "awaiting_agent_activation" as const, activationRequest: row.activation_request };
  if (
    row.status !== "approved" ||
    row.request_fingerprint !== input.requestFingerprint ||
    row.stable_fingerprint !== input.stableFingerprint ||
    row.registered_path !== input.registeredPath ||
    row.current_head !== input.currentHead ||
    Date.parse(row.expires_at) <= Date.now()
  )
    throw new ValidationFailedError("Mission Agent verification does not match the exact approved migration");
  const requestId = randomUUID();
  const activationExpiresAt = new Date(Math.min(Date.parse(row.expires_at), Date.now() + 5 * 60_000)).toISOString();
  const unsigned = {
    protocolVersion: "1",
    requestId,
    migrationId: input.migrationId,
    repositoryId: row.repository_id,
    agentId: input.agentId,
    agentVersion: "0.6.9",
    requiredArtifactChecksum: MISSION_AGENT_069_CHECKSUM,
    identityProtocolVersion: STABLE_IDENTITY_PROTOCOL_VERSION,
    acknowledgementVersion: ACTIVATION_ACKNOWLEDGEMENT_VERSION,
    legacyFingerprint: row.legacy_fingerprint,
    stableFingerprint: row.stable_fingerprint,
    canonicalRemoteUrl: row.canonical_remote_url,
    repositoryName: row.repository_name,
    registeredPath: row.registered_path,
    currentHead: row.current_head,
    permissionSnapshotHash: canonicalHash(row.permission_snapshot),
    projectBrainEnabled: row.project_brain_enabled,
    approvalReference: input.migrationId,
    requestFingerprint: row.request_fingerprint,
    nonce: randomUUID(),
    requestedAt: new Date().toISOString(),
    expiresAt: activationExpiresAt,
  };
  const requestChecksum = canonicalHash(unsigned);
  const activationRequest = {
    ...unsigned,
    requestChecksum,
    missionControlSignature: createHmac("sha256", input.signingKey).update(requestChecksum).digest("hex"),
  };
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: input.migrationId,
    expectedVersion: row.aggregate_version,
    commandId: `00000000-0000-5000-8000-${sha256(`complete:${input.migrationId}`).slice(0, 12)}`,
    commandType: "PrepareRepositoryIdentityActivation",
    correlationId: row.repository_id,
    actor: { type: "agent", id: input.agentId },
    events: [
      {
        eventType: "repository.identity_activation.requested",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          agentId: input.agentId,
          activationRequest,
          activationRequestChecksum: requestChecksum,
          activationRequestId: requestId,
          activationExpiresAt,
        },
      },
    ],
    beforeAppend: (client) =>
      assertRepositoryIdentityTransition(client, {
        workspaceId: input.workspaceId,
        repositoryId: row.repository_id,
        agentId: input.agentId,
        expectedVersion: LEGACY_IDENTITY_VERSION,
        expectedFingerprint: row.legacy_fingerprint,
        expectedHead: row.current_head,
        expectedRemote: row.canonical_remote_url,
        expectedName: row.repository_name,
        expectedPermissions: row.permission_snapshot,
        expectedProjectBrainEnabled: row.project_brain_enabled,
      }),
    applyProjections: applyRepositoryIdentityProjection,
  });
  return { status: "awaiting_agent_activation" as const, activationRequest };
}

export async function acknowledgeRepositoryIdentityActivation(input: {
  workspaceId: string;
  agentId: string;
  acknowledgement: Record<string, unknown>;
}) {
  const migrationId = String(input.acknowledgement.migrationId ?? "");
  const row = (
    await getDatabasePool().query(
      `SELECT * FROM repository_identity_migrations
       WHERE workspace_id=$1 AND migration_id=$2 AND agent_id=$3`,
      [input.workspaceId, migrationId, input.agentId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Repository identity activation");
  const artifact = input.acknowledgement.artifact as Record<string, unknown> | undefined;
  if (
    !["awaiting_agent_activation", "agent_activated"].includes(row.status) ||
    String(input.acknowledgement.requestId ?? "") !== row.activation_request_id ||
    String(input.acknowledgement.repositoryId ?? "") !== row.repository_id ||
    input.acknowledgement.activationProtocolVersion !== ACTIVATION_ACKNOWLEDGEMENT_VERSION ||
    input.acknowledgement.agentVersion !== "0.6.9" ||
    artifact?.sha256 !== MISSION_AGENT_069_CHECKSUM ||
    artifact?.manifestVersion !== "1" ||
    input.acknowledgement.legacyFingerprint !== row.legacy_fingerprint ||
    input.acknowledgement.stableFingerprint !== row.stable_fingerprint ||
    input.acknowledgement.canonicalRemoteUrl !== row.canonical_remote_url ||
    input.acknowledgement.repositoryName !== row.repository_name ||
    input.acknowledgement.registeredPath !== row.registered_path ||
    input.acknowledgement.currentHead !== row.current_head ||
    input.acknowledgement.permissionSnapshotHash !== canonicalHash(row.permission_snapshot) ||
    input.acknowledgement.projectBrainEnabled !== row.project_brain_enabled ||
    Date.parse(String(input.acknowledgement.expiresAt ?? "")) <= Date.now() ||
    Date.parse(row.activation_expires_at) <= Date.now() ||
    Date.parse(row.expires_at) <= Date.now()
  )
    throw new ValidationFailedError("Repository identity activation acknowledgement does not match");
  const acknowledgementChecksum = canonicalHash(input.acknowledgement);
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: migrationId,
    expectedVersion: row.aggregate_version,
    commandId: `00000000-0000-5000-8000-${sha256(`ack:${migrationId}:${acknowledgementChecksum}`).slice(0, 12)}`,
    commandType: "AcknowledgeRepositoryIdentityActivation",
    correlationId: row.repository_id,
    actor: { type: "agent", id: input.agentId },
    events: [
      {
        eventType: "repository.identity_activation.acknowledged",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          activationAcknowledgement: input.acknowledgement,
          activationAcknowledgementChecksum: acknowledgementChecksum,
        },
      },
      {
        eventType: "repository.identity_migration.completed",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          agentId: input.agentId,
          legacyFingerprint: row.legacy_fingerprint,
          stableFingerprint: row.stable_fingerprint,
          canonicalRemoteUrl: row.canonical_remote_url,
          repositoryName: row.repository_name,
          selectedRemote: row.selected_remote,
          registeredPath: row.registered_path,
          currentHead: row.current_head,
          permissions: row.permission_snapshot,
          projectBrainEnabled: row.project_brain_enabled,
          approvalReference: migrationId,
          legacyCreatedAt: new Date(row.legacy_created_at).toISOString(),
          legacyCanonicalRemoteUrl: row.legacy_canonical_remote_url,
          legacySelectedRemote: row.legacy_selected_remote,
          legacyVerificationSource: row.legacy_verification_source,
          legacyVerifiedAt: row.legacy_verified_at ? new Date(row.legacy_verified_at).toISOString() : null,
        },
      },
    ],
    beforeAppend: (client) =>
      assertRepositoryIdentityTransition(client, {
        workspaceId: input.workspaceId,
        repositoryId: row.repository_id,
        agentId: input.agentId,
        expectedVersion: LEGACY_IDENTITY_VERSION,
        expectedFingerprint: row.legacy_fingerprint,
        expectedHead: row.current_head,
        expectedRemote: row.canonical_remote_url,
        expectedName: row.repository_name,
        expectedPermissions: row.permission_snapshot,
        expectedProjectBrainEnabled: row.project_brain_enabled,
      }),
    applyProjections: applyRepositoryIdentityProjection,
  });
  return { status: "agent_activated" as const, repositoryId: row.repository_id };
}

export async function finalizeRepositoryIdentityActivation(input: {
  workspaceId: string;
  agentId: string;
  repositoryId: string;
  stableFingerprint: string;
}) {
  const row = (
    await getDatabasePool().query(
      `SELECT m.*,a.mission_agent_version,a.mission_agent_artifact_checksum,
        a.mission_agent_checksum_status,a.mission_agent_capability_expires_at
       FROM repository_identity_migrations m
       JOIN agents a ON a.workspace_id=m.workspace_id AND a.agent_id=m.agent_id
       WHERE m.workspace_id=$1 AND m.repository_id=$2 AND m.agent_id=$3
         AND m.status='agent_activated' ORDER BY m.activation_acknowledged_at DESC LIMIT 1`,
      [input.workspaceId, input.repositoryId, input.agentId],
    )
  ).rows[0];
  if (!row) return { status: "not_pending" as const };
  if (
    row.stable_fingerprint !== input.stableFingerprint ||
    row.mission_agent_version !== "0.6.9" ||
    row.mission_agent_artifact_checksum !== MISSION_AGENT_069_CHECKSUM ||
    row.mission_agent_checksum_status !== "verified" ||
    !row.mission_agent_capability_expires_at ||
    new Date(row.mission_agent_capability_expires_at).getTime() <= Date.now() ||
    !row.activation_acknowledged_at ||
    new Date(row.mission_agent_capability_expires_at).getTime() <= new Date(row.activation_acknowledged_at).getTime()
  )
    throw new ValidationFailedError("Stable repository refresh requires fresh checksum-verified 0.6.9 capabilities");
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: row.migration_id,
    expectedVersion: row.aggregate_version,
    commandId: `00000000-0000-5000-8000-${sha256(`activate:${row.migration_id}`).slice(0, 12)}`,
    commandType: "FinalizeRepositoryIdentityActivation",
    correlationId: input.repositoryId,
    actor: { type: "agent", id: input.agentId },
    events: [
      {
        eventType: "repository.identity_activation.completed",
        eventSchemaVersion: 1,
        payload: { repositoryId: input.repositoryId, stableFingerprint: input.stableFingerprint },
      },
    ],
    applyProjections: applyRepositoryIdentityProjection,
  });
  return { status: "completed" as const };
}

export async function rollbackRepositoryIdentityMigration(input: {
  workspaceId: string;
  migrationId: string;
  actorId: string;
}) {
  const row = (
    await getDatabasePool().query(
      `SELECT * FROM repository_identity_migrations WHERE workspace_id=$1 AND migration_id=$2`,
      [input.workspaceId, input.migrationId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Repository identity migration");
  if (row.status === "rolled_back") return { migrationId: input.migrationId, status: "rolled_back" as const };
  if (row.status !== "completed")
    throw new ValidationFailedError("Only a completed identity migration can be rolled back");
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: input.migrationId,
    expectedVersion: row.aggregate_version,
    commandId: randomUUID(),
    commandType: "RollbackRepositoryIdentityMigration",
    correlationId: row.repository_id,
    actor: { type: "human", id: input.actorId },
    events: [
      {
        eventType: "repository.identity_migration.rolled_back",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          agentId: row.agent_id,
          legacyFingerprint: row.legacy_fingerprint,
          stableFingerprint: row.stable_fingerprint,
        },
      },
    ],
    beforeAppend: (client) =>
      assertRepositoryIdentityTransition(client, {
        workspaceId: input.workspaceId,
        repositoryId: row.repository_id,
        agentId: row.agent_id,
        expectedVersion: STABLE_IDENTITY_VERSION,
        expectedFingerprint: row.stable_fingerprint,
        expectedHead: row.current_head,
        expectedRemote: row.canonical_remote_url,
        expectedName: row.repository_name,
        expectedPermissions: row.permission_snapshot,
        expectedProjectBrainEnabled: row.project_brain_enabled,
      }),
    applyProjections: applyRepositoryIdentityProjection,
  });
  return { migrationId: input.migrationId, status: "rolled_back" as const };
}

export { applyRepositoryIdentityProjection };
