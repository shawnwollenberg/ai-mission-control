import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool } from "@/lib/database";

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
      `SELECT a.*,count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled'))::int current_execution_count FROM agents a LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id WHERE a.workspace_id=$1 GROUP BY a.workspace_id,a.agent_id ORDER BY a.created_at`,
      [workspaceId],
    )
  ).rows;
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
    `INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,false,false,$10) ON CONFLICT(workspace_id,repository_id) DO UPDATE SET name=EXCLUDED.name,default_branch=EXCLUDED.default_branch,allowed_agent_ids=EXCLUDED.allowed_agent_ids,read_allowed=EXCLUDED.read_allowed,write_allowed=EXCLUDED.write_allowed,commit_allowed=EXCLUDED.commit_allowed,validation_commands=EXCLUDED.validation_commands,updated_at=now() RETURNING *`,
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
      JSON.stringify(commands),
    ],
  );
  return result.rows[0];
}
export async function listRepositories(workspaceId: string) {
  return (
    await getDatabasePool().query("SELECT * FROM repositories WHERE workspace_id=$1 ORDER BY created_at", [workspaceId])
  ).rows;
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
