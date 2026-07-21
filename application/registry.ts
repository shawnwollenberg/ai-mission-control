import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool } from "@/lib/database";
import { grantAgentResource } from "@/application/agent-eligibility";

export type RegistryActor = { workspaceId: string; userId: string; role: "owner" | "member" };
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
}) {
  if (!input.name.trim() || !/^[a-f0-9]{64}$/.test(input.fingerprint) || !input.defaultBranch.trim())
    throw new ValidationFailedError("Repository identity is invalid");
  const agent = (
    await getDatabasePool().query(
      "SELECT 1 FROM agents WHERE workspace_id=$1 AND agent_id=$2 AND delivery_mode='pull' AND status<>'disabled'",
      [input.workspaceId, input.agentId],
    )
  ).rows[0];
  if (!agent) throw new NotFoundError("Mission Agent");
  const repositoryId = randomUUID();
  const result = await getDatabasePool().query(
    `INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,
      commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,pull_request_allowed,protected_branches,
      allowed_branch_prefixes,allowed_remotes,provider_type,location_mode,repository_fingerprint,observed_remote_url,observed_commit)
     VALUES($1,$2,$3,$4,$5,$6,true,false,false,$11,false,false,'[]',$11,$7,$12,'["origin"]',$13,'mission_agent',$8,$9,$10)
     ON CONFLICT(workspace_id,repository_fingerprint) WHERE repository_fingerprint IS NOT NULL AND disabled_at IS NULL
     DO UPDATE SET name=EXCLUDED.name,default_branch=EXCLUDED.default_branch,allowed_agent_ids=EXCLUDED.allowed_agent_ids,
       observed_remote_url=EXCLUDED.observed_remote_url,observed_commit=EXCLUDED.observed_commit,updated_at=now()
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
  await grantAgentResource({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    resourceType: "repository",
    resourceId: repository.repository_id,
    permissions: ["read"],
  });
  return repository;
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
  if (!Array.isArray(row.allowed_agent_ids) || !row.allowed_agent_ids.includes(agentId))
    throw new ValidationFailedError("Agent is not allowed to access this repository");
  if (row.current_executions >= row.concurrency_limit)
    throw new ValidationFailedError("Agent concurrency limit is reached");
  return row;
}
