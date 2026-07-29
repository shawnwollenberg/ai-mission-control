import { randomUUID } from "node:crypto";
import { ConcurrencyConflictError, NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";
import {
  deriveStableRepositoryIdentity,
  finalizeRepositoryIdentityActivation,
  STABLE_IDENTITY_VERSION,
  type RemoteCandidate,
} from "@/application/repository-identity";

export type RegistryActor = { workspaceId: string; userId: string; role: "owner" | "member" };
type RepositoryRegistrationFailurePoint = "after_repository" | "after_identity" | "after_grant";
type DispatchPolicyRow = {
  agent_status: string;
  adapter_type: string;
  capabilities: string[];
  concurrency_limit: number;
  repository_id: string;
  disabled_at: Date | null;
  allowed_agent_ids: string[];
  current_executions: number;
  read_allowed: boolean;
  write_allowed: boolean;
  commit_allowed: boolean;
  local_path: string;
  default_branch: string;
  validation_commands: string[][];
  location_mode: "server" | "mission_agent";
  project_brain_enabled: boolean;
  identity_migration_status: string;
};
function owner(actor: RegistryActor) {
  if (actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
}
export async function registerAgent(input: {
  actor: RegistryActor;
  agentId?: string;
  name: string;
  description?: string;
  adapterType: "mock" | "codex";
  capabilities: string[];
  supportedDomains: string[];
  trustLevel: string;
  concurrencyLimit?: number;
  runtimeConfigurationReference?: string;
  credentialReference?: string;
}) {
  owner(input.actor);
  const agentId = input.agentId ?? randomUUID();
  if (!input.name.trim()) throw new ValidationFailedError("Agent name is required");
  const result = await getDatabasePool().query(
    `INSERT INTO agents(workspace_id,agent_id,name,description,adapter_type,capabilities,supported_domains,trust_level,status,concurrency_limit,configuration_reference,credential_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11) ON CONFLICT(workspace_id,agent_id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,capabilities=EXCLUDED.capabilities,supported_domains=EXCLUDED.supported_domains,trust_level=EXCLUDED.trust_level,concurrency_limit=EXCLUDED.concurrency_limit,configuration_reference=EXCLUDED.configuration_reference,credential_reference=EXCLUDED.credential_reference,updated_at=now() RETURNING *`,
    [
      input.actor.workspaceId,
      agentId,
      input.name.trim(),
      input.description?.trim() ?? null,
      input.adapterType,
      JSON.stringify(input.capabilities),
      JSON.stringify(input.supportedDomains),
      input.trustLevel,
      input.concurrencyLimit ?? 1,
      input.runtimeConfigurationReference ?? null,
      input.credentialReference ?? null,
    ],
  );
  return result.rows[0];
}
export async function setAgentEnabled(input: { actor: RegistryActor; agentId: string; enabled: boolean }) {
  owner(input.actor);
  const result = await getDatabasePool().query(
    "UPDATE agents SET status=$3,disabled_at=CASE WHEN $3='disabled' THEN now() ELSE NULL END,updated_at=now() WHERE workspace_id=$1 AND agent_id=$2 RETURNING *",
    [input.actor.workspaceId, input.agentId, input.enabled ? "active" : "disabled"],
  );
  if (!result.rowCount) throw new NotFoundError("Agent");
  return result.rows[0];
}
export async function listAgents(workspaceId: string) {
  return (
    await getDatabasePool().query(
      `SELECT a.*,CASE WHEN a.status='active' AND a.last_heartbeat_at < now()-interval '3 minutes' THEN 'offline' WHEN a.status='active' AND a.last_heartbeat_at < now()-interval '90 seconds' THEN 'degraded' ELSE a.status END effective_status,count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled'))::int current_execution_count,(SELECT count(*)::int FROM repositories r WHERE r.workspace_id=a.workspace_id AND r.allowed_agent_ids ? a.agent_id::text AND r.disabled_at IS NULL) repository_count FROM agents a LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id WHERE a.workspace_id=$1 GROUP BY a.workspace_id,a.agent_id ORDER BY a.created_at`,
      [workspaceId],
    )
  ).rows;
}
export async function getAgentDetail(workspaceId: string, agentId: string) {
  const agent = (
    await getDatabasePool().query(
      `SELECT a.*,CASE WHEN a.status='active' AND a.last_heartbeat_at < now()-interval '3 minutes' THEN 'offline' WHEN a.status='active' AND a.last_heartbeat_at < now()-interval '90 seconds' THEN 'degraded' ELSE a.status END effective_status,count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled'))::int current_execution_count FROM agents a LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id WHERE a.workspace_id=$1 AND a.agent_id=$2 GROUP BY a.workspace_id,a.agent_id`,
      [workspaceId, agentId],
    )
  ).rows[0];
  if (!agent) throw new NotFoundError("Agent");
  const executions = (
    await getDatabasePool().query(
      `SELECT execution_id,mission_id,task_id,status,stage,progress_summary,commit_id,started_at,completed_at,created_at FROM execution_projections WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 10`,
      [workspaceId, agentId],
    )
  ).rows;
  const credentials = (
    await getDatabasePool().query(
      "SELECT credential_id,version,status,created_at,last_used_at,verified_at,expires_at,overlap_ends_at,revoked_at FROM agent_credentials WHERE workspace_id=$1 AND agent_id=$2 ORDER BY version DESC",
      [workspaceId, agentId],
    )
  ).rows;
  const resources = (
    await getDatabasePool().query(
      "SELECT resource_type,resource_id,permissions,created_at,revoked_at FROM agent_resource_permissions WHERE workspace_id=$1 AND agent_id=$2 ORDER BY resource_type,resource_id",
      [workspaceId, agentId],
    )
  ).rows;
  const repositories = (
    await getDatabasePool().query(
      `SELECT r.repository_id,r.name,r.observed_remote_url,r.default_branch,r.observed_commit,r.disabled_at,r.read_allowed,r.write_allowed,r.created_at,a.name agent_name,(SELECT ep.mission_id FROM execution_projections ep WHERE ep.workspace_id=r.workspace_id AND ep.repository_id=r.repository_id ORDER BY ep.created_at DESC LIMIT 1) last_used_mission_id,(SELECT ep.created_at FROM execution_projections ep WHERE ep.workspace_id=r.workspace_id AND ep.repository_id=r.repository_id ORDER BY ep.created_at DESC LIMIT 1) last_used_at FROM repositories r JOIN agents a ON a.workspace_id=r.workspace_id AND a.agent_id=$2 WHERE r.workspace_id=$1 AND r.allowed_agent_ids ? $2::text ORDER BY r.created_at`,
      [workspaceId, agentId],
    )
  ).rows;
  const deliveries = (
    await getDatabasePool().query(
      "SELECT message_type,status,attempt_count,response_status,response_summary,created_at,delivered_at FROM webhook_deliveries WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 20",
      [workspaceId, agentId],
    )
  ).rows;
  const artifacts = (
    await getDatabasePool().query(
      `SELECT artifact_id,kind,media_type,byte_size,checksum_sha256,created_at FROM artifacts WHERE workspace_id=$1 AND execution_id IN (SELECT execution_id FROM execution_projections WHERE workspace_id=$1 AND agent_id=$2) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`,
      [workspaceId, agentId],
    )
  ).rows;
  const securityEvents = (
    await getDatabasePool().query(
      "SELECT reason_code,occurred_at,metadata FROM protocol_security_events WHERE workspace_id=$1 AND agent_id=$2 ORDER BY occurred_at DESC LIMIT 20",
      [workspaceId, agentId],
    )
  ).rows;
  return { agent, executions, credentials, resources, repositories, deliveries, artifacts, securityEvents };
}

export async function removeMissionAgentRepositoryAssociation(input: {
  workspaceId: string;
  agentId: string;
  repositoryId: string;
}) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE repositories SET allowed_agent_ids=allowed_agent_ids-$3::text,updated_at=now() WHERE workspace_id=$1 AND repository_id=$2 AND allowed_agent_ids ? $3::text RETURNING repository_id,name`,
      [input.workspaceId, input.repositoryId, input.agentId],
    );
    if (!result.rowCount) throw new NotFoundError("Repository association");
    await client.query(
      "UPDATE agent_resource_permissions SET revoked_at=now() WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3 AND revoked_at IS NULL",
      [input.workspaceId, input.agentId, input.repositoryId],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setRepositoryEnabled(input: {
  actor: RegistryActor;
  agentId: string;
  repositoryId: string;
  enabled: boolean;
}) {
  owner(input.actor);
  const result = await getDatabasePool().query(
    `UPDATE repositories SET disabled_at=CASE WHEN $4 THEN NULL ELSE now() END,updated_at=now() WHERE workspace_id=$1 AND repository_id=$2 AND allowed_agent_ids ? $3::text RETURNING repository_id,disabled_at`,
    [input.actor.workspaceId, input.repositoryId, input.agentId, input.enabled],
  );
  if (!result.rowCount) throw new NotFoundError("Repository association");
  return result.rows[0];
}
export async function registerRepository(input: {
  actor: RegistryActor;
  repositoryId?: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  allowedAgentIds: string[];
  readAllowed?: boolean;
  writeAllowed?: boolean;
  commitAllowed?: boolean;
  pushAllowed?: boolean;
  pullRequestAllowed?: boolean;
  protectedBranches?: string[];
  allowedBranchPrefixes?: string[];
  allowedRemotes?: string[];
  providerType?: "local_fixture" | "github";
  providerConfigurationReference?: string;
  validationCommands?: string[][];
}) {
  owner(input.actor);
  if (!input.name.trim() || !input.localPath.trim() || !input.defaultBranch.trim())
    throw new ValidationFailedError("Repository name, registered path, and default branch are required");
  const repositoryId = input.repositoryId ?? randomUUID();
  const commands = input.validationCommands ?? [];
  if (
    commands.some(
      (command) =>
        !Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string" || !part),
    )
  )
    throw new ValidationFailedError("Validation commands must be non-empty argument arrays");
  const result = await getDatabasePool().query(
    `INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,pull_request_allowed,protected_branches,allowed_branch_prefixes,allowed_remotes,provider_type,provider_configuration_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(workspace_id,repository_id) DO UPDATE SET name=EXCLUDED.name,default_branch=EXCLUDED.default_branch,allowed_agent_ids=EXCLUDED.allowed_agent_ids,read_allowed=EXCLUDED.read_allowed,write_allowed=EXCLUDED.write_allowed,commit_allowed=EXCLUDED.commit_allowed,push_allowed=EXCLUDED.push_allowed,pull_request_allowed=EXCLUDED.pull_request_allowed,protected_branches=EXCLUDED.protected_branches,allowed_branch_prefixes=EXCLUDED.allowed_branch_prefixes,allowed_remotes=EXCLUDED.allowed_remotes,provider_type=EXCLUDED.provider_type,provider_configuration_reference=EXCLUDED.provider_configuration_reference,validation_commands=EXCLUDED.validation_commands,updated_at=now() RETURNING *`,
    [
      input.actor.workspaceId,
      repositoryId,
      input.name.trim(),
      input.localPath.trim(),
      input.defaultBranch.trim(),
      JSON.stringify(input.allowedAgentIds),
      input.readAllowed ?? true,
      input.writeAllowed ?? false,
      input.commitAllowed ?? false,
      input.pushAllowed ?? false,
      JSON.stringify(commands),
      input.pullRequestAllowed ?? false,
      JSON.stringify(input.protectedBranches ?? [input.defaultBranch.trim()]),
      JSON.stringify(input.allowedBranchPrefixes ?? ["codex/"]),
      JSON.stringify(input.allowedRemotes ?? ["origin"]),
      input.providerType ?? "local_fixture",
      input.providerConfigurationReference ?? null,
    ],
  );
  return result.rows[0];
}
export async function listRepositories(workspaceId: string) {
  return (
    await getDatabasePool().query("SELECT * FROM repositories WHERE workspace_id=$1 ORDER BY created_at", [workspaceId])
  ).rows;
}

export async function registerMissionAgentRepository(input: {
  workspaceId: string;
  agentId: string;
  name: string;
  fingerprint: string;
  defaultBranch: string;
  remoteUrl?: string;
  commit?: string;
  identityVersion?: string;
  canonicalRemoteUrl?: string;
  selectedRemote?: string;
  remotes?: RemoteCandidate[];
  protocolMessageId?: string;
  failureInjection?: RepositoryRegistrationFailurePoint;
}) {
  if (!input.name.trim() || !/^[a-f0-9]{64}$/.test(input.fingerprint) || !input.defaultBranch.trim())
    throw new ValidationFailedError("Repository identity is invalid");
  const agent = (
    await getDatabasePool().query(
      "SELECT mission_agent_version FROM agents WHERE workspace_id=$1 AND agent_id=$2 AND delivery_mode='pull' AND status<>'disabled'",
      [input.workspaceId, input.agentId],
    )
  ).rows[0];
  if (!agent) throw new NotFoundError("Mission Agent");
  if (input.identityVersion === STABLE_IDENTITY_VERSION) {
    const derived = deriveStableRepositoryIdentity({
      remotes: input.remotes ?? [],
      repositoryName: input.name,
    });
    if (
      input.fingerprint !== derived.fingerprint ||
      input.canonicalRemoteUrl !== derived.canonicalRemoteUrl ||
      input.selectedRemote !== derived.selectedRemote
    )
      throw new ValidationFailedError("Stable repository registration does not match server derivation");
    const commandId = stableUuid(
      `repository-registration:${input.workspaceId}:${input.agentId}:${input.protocolMessageId ?? randomUUID()}`,
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = (
        await getDatabasePool().query<{
          repository_id: string;
          canonical_remote_url: string | null;
          identity_migration_status: string;
        }>(
          `SELECT r.repository_id,i.canonical_remote_url,r.identity_migration_status
           FROM repositories r
           JOIN repository_identities i
             ON i.workspace_id=r.workspace_id AND i.repository_id=r.repository_id
             AND i.identity_version='stable-v2' AND i.fingerprint=$2
           WHERE r.workspace_id=$1 AND r.disabled_at IS NULL
           LIMIT 1`,
          [input.workspaceId, input.fingerprint],
        )
      ).rows[0];
      if (existing?.canonical_remote_url !== undefined && existing.canonical_remote_url !== derived.canonicalRemoteUrl)
        throw new ValidationFailedError("Stable repository identity conflicts with its canonical remote");
      if (!existing) {
        const legacyRows = (
          await getDatabasePool().query<{ observed_remote_url: string | null }>(
            `SELECT observed_remote_url FROM repositories
             WHERE workspace_id=$1 AND identity_version='legacy-v1' AND disabled_at IS NULL
               AND observed_remote_url IS NOT NULL`,
            [input.workspaceId],
          )
        ).rows;
        if (
          legacyRows.some((row) => {
            try {
              return (
                deriveStableRepositoryIdentity({
                  remotes: [{ name: "origin", url: row.observed_remote_url! }],
                  repositoryName: input.name,
                }).canonicalRemoteUrl === derived.canonicalRemoteUrl
              );
            } catch {
              return false;
            }
          })
        )
          throw new ValidationFailedError("This repository requires governed legacy identity migration");
      }
      const repositoryId =
        existing?.repository_id ?? stableUuid(`stable-v2-repository:${input.workspaceId}:${input.fingerprint}`);
      const aggregateEvents = await loadAggregateEvents({
        workspaceId: input.workspaceId,
        aggregateType: "repository",
        aggregateId: repositoryId,
      });
      try {
        await appendEvents({
          workspaceId: input.workspaceId,
          aggregateType: "repository",
          aggregateId: repositoryId,
          expectedVersion: aggregateEvents.length,
          commandId,
          commandType: "RegisterMissionAgentRepository",
          correlationId: repositoryId,
          causationId: aggregateEvents.at(-1)?.eventId,
          actor: { type: "agent", id: input.agentId },
          events: [
            {
              eventType: existing ? "repository.registration_refreshed" : "repository.registered",
              eventSchemaVersion: 1,
              payload: {
                repositoryId,
                agentId: input.agentId,
                name: input.name.trim().slice(0, 160),
                defaultBranch: input.defaultBranch.trim().slice(0, 200),
                identityVersion: STABLE_IDENTITY_VERSION,
                fingerprint: input.fingerprint,
                canonicalRemoteUrl: derived.canonicalRemoteUrl,
                selectedRemote: derived.selectedRemote,
                observedCommit: input.commit?.slice(0, 80) ?? null,
              },
            },
          ],
          applyProjections: (client, events) =>
            applyRepositoryRegistrationProjection(client, events, input.failureInjection),
        });
        const repository = (
          await getDatabasePool().query(
            `SELECT repository_id,name,default_branch,repository_fingerprint,observed_commit
             FROM repositories WHERE workspace_id=$1 AND repository_id=$2`,
            [input.workspaceId, repositoryId],
          )
        ).rows[0];
        if (!repository) throw new ValidationFailedError("Repository registration projection is unavailable");
        if (existing?.identity_migration_status === "agent_activated")
          await finalizeRepositoryIdentityActivation({
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            repositoryId,
            stableFingerprint: input.fingerprint,
          });
        return repository;
      } catch (error) {
        if (error instanceof ConcurrencyConflictError && attempt < 3) continue;
        throw error;
      }
    }
    throw new ConcurrencyConflictError({ repositoryFingerprint: input.fingerprint });
  }
  // A version string does not prove which identity algorithm produced an
  // agent-supplied fingerprint. Only governed migration may activate stable-v2.
  const identityVersion = "legacy-v1";
  const migrated = (
    await getDatabasePool().query(
      `SELECT r.repository_id FROM repository_identities i
       JOIN repositories r ON r.workspace_id=i.workspace_id AND r.repository_id=i.repository_id
       WHERE i.workspace_id=$1 AND i.identity_version='legacy-v1' AND i.fingerprint=$2
         AND r.identity_version='stable-v2' AND r.disabled_at IS NULL
         AND r.allowed_agent_ids ? $3::text LIMIT 1`,
      [input.workspaceId, input.fingerprint, input.agentId],
    )
  ).rows[0];
  if (migrated)
    throw new ValidationFailedError(
      "Legacy repository identity refresh rejected because this repository has an active stable identity",
    );
  const repositoryId = randomUUID();
  const result = await getDatabasePool().query(
    `INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,
      commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,pull_request_allowed,protected_branches,
      allowed_branch_prefixes,allowed_remotes,provider_type,location_mode,repository_fingerprint,observed_remote_url,observed_commit)
     VALUES($1,$2,$3,$4,$5,$6,true,false,false,$11,false,false,'[]',$11,$7,$12,'["origin"]',$13,'mission_agent',$8,$9,$10)
     ON CONFLICT(workspace_id,repository_fingerprint) WHERE repository_fingerprint IS NOT NULL AND disabled_at IS NULL
     DO UPDATE SET name=EXCLUDED.name,default_branch=EXCLUDED.default_branch,
       observed_remote_url=EXCLUDED.observed_remote_url,observed_commit=EXCLUDED.observed_commit,updated_at=now()
     WHERE repositories.allowed_agent_ids @> $6::jsonb
     RETURNING repository_id,name,default_branch,repository_fingerprint,observed_commit`,
    [
      input.workspaceId,
      repositoryId,
      input.name.trim().slice(0, 160),
      `mission-agent://${input.fingerprint}`,
      input.defaultBranch.trim().slice(0, 200),
      JSON.stringify([input.agentId]),
      JSON.stringify([input.defaultBranch.trim().slice(0, 200)]),
      input.fingerprint,
      input.remoteUrl?.slice(0, 500) ?? null,
      input.commit?.slice(0, 80) ?? null,
      Boolean(input.remoteUrl && /github\.com[:/]/i.test(input.remoteUrl)),
      JSON.stringify(input.remoteUrl && /github\.com[:/]/i.test(input.remoteUrl) ? ["mission/"] : []),
      input.remoteUrl && /github\.com[:/]/i.test(input.remoteUrl) ? "github" : "local_fixture",
    ],
  );
  const repository = result.rows[0];
  if (!repository) throw new ValidationFailedError("Repository is already associated with another Mission Agent");
  await getDatabasePool().query(
    `UPDATE repositories SET identity_version=$3,identity_migration_status='not_required'
     WHERE workspace_id=$1 AND repository_id=$2 AND identity_version='legacy-v1'
       AND NOT EXISTS(SELECT 1 FROM repository_identities i WHERE i.workspace_id=$1 AND i.repository_id=$2)`,
    [input.workspaceId, repository.repository_id, identityVersion],
  );
  await getDatabasePool().query(
    `INSERT INTO repository_identities(
       workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
       selected_remote,created_at,verified_at,verification_source,migration_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,now(),now(),'mission-agent-registration','active')
     ON CONFLICT DO NOTHING`,
    [
      input.workspaceId,
      repository.repository_id,
      identityVersion,
      input.fingerprint,
      input.remoteUrl ?? null,
      input.name.trim().slice(0, 160),
      input.remoteUrl ? "origin" : null,
    ],
  );
  await getDatabasePool().query(
    `INSERT INTO agent_resource_permissions(
       workspace_id,agent_id,resource_type,resource_id,permissions
     ) VALUES($1,$2,'repository',$3,'["read"]')
     ON CONFLICT(workspace_id,agent_id,resource_type,resource_id) DO NOTHING`,
    [input.workspaceId, input.agentId, repository.repository_id],
  );
  return repository;
}

export async function applyRepositoryRegistrationProjection(
  client: import("pg").PoolClient,
  events: DomainEvent[],
  failureInjection?: RepositoryRegistrationFailurePoint,
) {
  for (const event of events) {
    if (!["repository.registered", "repository.registration_refreshed"].includes(event.eventType)) continue;
    const payload = event.payload;
    const repositoryId = String(payload.repositoryId ?? "");
    const agentId = String(payload.agentId ?? "");
    const fingerprint = String(payload.fingerprint ?? "");
    const name = String(payload.name ?? "");
    const defaultBranch = String(payload.defaultBranch ?? "");
    const canonicalRemoteUrl = String(payload.canonicalRemoteUrl ?? "");
    const selectedRemote = String(payload.selectedRemote ?? "");
    const observedCommit = payload.observedCommit ? String(payload.observedCommit) : null;
    if (
      !repositoryId ||
      !agentId ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !name ||
      !defaultBranch ||
      !canonicalRemoteUrl ||
      !selectedRemote
    )
      throw new ValidationFailedError("Canonical repository registration event is invalid");
    await client.query(
      `INSERT INTO repositories(
         workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,
         commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,pull_request_allowed,
         protected_branches,allowed_branch_prefixes,allowed_remotes,provider_type,location_mode,
         repository_fingerprint,observed_remote_url,observed_commit,identity_version,identity_migration_status)
       VALUES($1,$2,$3,$4,$5,jsonb_build_array($6::text),true,false,false,$10,false,false,'[]',$10,
         jsonb_build_array($5::text),$11,'["origin"]',$12,'mission_agent',$7,$8,$9,'stable-v2','not_required')
       ON CONFLICT(workspace_id,repository_id) DO UPDATE SET
         name=EXCLUDED.name,default_branch=EXCLUDED.default_branch,
         allowed_agent_ids=CASE
           WHEN repositories.allowed_agent_ids ? $6::text THEN repositories.allowed_agent_ids
           ELSE repositories.allowed_agent_ids||to_jsonb($6::text)
         END,
         observed_remote_url=EXCLUDED.observed_remote_url,observed_commit=EXCLUDED.observed_commit,updated_at=now()
       WHERE repositories.identity_version='stable-v2'
         AND repositories.repository_fingerprint=EXCLUDED.repository_fingerprint`,
      [
        event.workspaceId,
        repositoryId,
        name,
        `mission-agent://${fingerprint}`,
        defaultBranch,
        agentId,
        fingerprint,
        canonicalRemoteUrl,
        observedCommit,
        /github\.com\//i.test(canonicalRemoteUrl),
        JSON.stringify(/github\.com\//i.test(canonicalRemoteUrl) ? ["mission/"] : []),
        /github\.com\//i.test(canonicalRemoteUrl) ? "github" : "local_fixture",
      ],
    );
    if (failureInjection === "after_repository") throw new Error("Injected failure after repository projection");
    await client.query(
      `INSERT INTO repository_identities(
         workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
         selected_remote,created_at,verified_at,verification_source,migration_status,migration_event_id)
       VALUES($1,$2,'stable-v2',$3,$4,$5,$6,$7,$7,'mission-agent+mission-control-registration','active',$8)
       ON CONFLICT(workspace_id,repository_id,identity_version,fingerprint) DO NOTHING`,
      [
        event.workspaceId,
        repositoryId,
        fingerprint,
        canonicalRemoteUrl,
        name,
        selectedRemote,
        event.occurredAt,
        event.eventId,
      ],
    );
    if (failureInjection === "after_identity") throw new Error("Injected failure after identity projection");
    await client.query(
      `INSERT INTO agent_resource_permissions(
         workspace_id,agent_id,resource_type,resource_id,permissions)
       VALUES($1,$2,'repository',$3,'["read"]')
       ON CONFLICT(workspace_id,agent_id,resource_type,resource_id) DO UPDATE SET
         permissions=(
           SELECT jsonb_agg(permission ORDER BY permission)
           FROM (
             SELECT DISTINCT jsonb_array_elements_text(
               agent_resource_permissions.permissions||EXCLUDED.permissions
             ) permission
           ) permissions
         ),
         revoked_at=NULL`,
      [event.workspaceId, agentId, repositoryId],
    );
    if (failureInjection === "after_grant") throw new Error("Injected failure after grant projection");
  }
}
export async function getDispatchPolicy(workspaceId: string, agentId: string, repositoryId: string) {
  const result = await getDatabasePool().query<DispatchPolicyRow>(
    `SELECT a.status agent_status,a.adapter_type,a.capabilities,a.concurrency_limit,r.*,count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled'))::int current_executions FROM agents a JOIN repositories r ON r.workspace_id=a.workspace_id AND r.repository_id=$3 LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id WHERE a.workspace_id=$1 AND a.agent_id=$2 GROUP BY a.workspace_id,a.agent_id,r.workspace_id,r.repository_id`,
    [workspaceId, agentId, repositoryId],
  );
  if (!result.rowCount) throw new NotFoundError("Agent or repository");
  const row = result.rows[0];
  if (row.agent_status !== "active") throw new ValidationFailedError("Agent is not active");
  if (row.disabled_at) throw new ValidationFailedError("Repository is disabled");
  if (!["not_required", "completed"].includes(row.identity_migration_status))
    throw new ValidationFailedError("Repository dispatch is blocked during identity migration");
  if (!Array.isArray(row.allowed_agent_ids) || !row.allowed_agent_ids.includes(agentId))
    throw new ValidationFailedError("Agent is not allowed to access this repository");
  if (row.current_executions >= row.concurrency_limit)
    throw new ValidationFailedError("Agent concurrency limit is reached");
  return row;
}
