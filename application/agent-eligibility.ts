import { getDatabasePool } from "@/lib/database";
import type { Pool, PoolClient } from "pg";
import type { AgentOperation, ModelCapability, ModelCapabilityRole } from "@/domain/agent-provider";
import { providerRuntimeBindingFor } from "@/domain/provider-runtime-requirements";
import type { AgentProvider } from "@/domain/agent-provider";
import { providerRuntimeProfileFor, type ProviderRuntimeProfileBinding } from "@/domain/provider-runtime-profiles";
import { missionControlRuntimeMode, runtimeTrustEvidence } from "@/lib/runtime-trust";

export type AgentHealthStatus = "active" | "degraded" | "stale" | "offline" | "disabled";
export type RequiredResource = { resourceType: string; resourceId: string; permission: string };
export type EligibilityResult = {
  eligible: boolean;
  reasons: string[];
  health: AgentHealthStatus;
  score: number;
  providerId?: string;
  modelCapability?: ModelCapability;
  capabilityAttestationId?: string;
  capabilityAttestationHash?: string;
  providerRuntimeRequirementsId?: string;
  providerRuntimeRequirementsHash?: string;
  providerRuntimeProfile?: ProviderRuntimeProfileBinding;
};
type AgentRow = {
  status: string;
  credential_status: string;
  last_heartbeat_at: Date | null;
  concurrency_limit: number;
  capabilities: string[];
  supported_domains: string[];
  protocol_versions: string[];
  current_executions: number;
  delivery_failures: number;
  execution_failures: number;
  protocol_failures: number;
  trust_level: string;
  cost_metadata: Record<string, unknown>;
  valid_credentials: number;
  provider_id: string;
  agent_version: string | null;
  supported_mission_roles: string[];
  supported_operations: string[];
  supported_models: string[];
  structured_output: boolean;
  project_brain_context: boolean;
  repository_mutation: boolean;
  model_capabilities: ModelCapability[];
  capability_attestation_id: string | null;
  capability_attestation_hash: string | null;
  capability_attestation_expires_at: Date | null;
  capability_attestation_row_hash: string | null;
  capability_attestation_revoked_at: Date | null;
  capability_attestation_row_expires_at: Date | null;
  provider_credentials_available: boolean;
  mission_agent_version: string | null;
  mission_agent_checksum_status: string;
  mission_agent_artifact_checksum: string | null;
  mission_agent_capability_expires_at: Date | null;
  provider_runtime_requirements_id: string | null;
  provider_runtime_requirements_hash: string | null;
  provider_runtime_requirements_satisfied: boolean;
  provider_runtime_profiles: ProviderRuntimeProfileBinding[];
  mission_agent_runtime_mode: string | null;
  mission_agent_trust_authority: string | null;
  mission_agent_acceptance_registry_path: string | null;
  mission_agent_acceptance_registry_path_hash: string | null;
  mission_agent_acceptance_registry_hash: string | null;
};
export function calculateAgentHealth(
  row: AgentRow,
  now = Date.now(),
): { status: AgentHealthStatus; reasons: string[] } {
  if (row.status === "disabled") return { status: "disabled", reasons: ["Agent is manually disabled"] };
  if (!row.valid_credentials || row.credential_status === "revoked")
    return { status: "offline", reasons: ["No valid credential"] };
  if (!row.last_heartbeat_at) return { status: "offline", reasons: ["No heartbeat received"] };
  const interval = Number(process.env.REMOTE_AGENT_HEARTBEAT_INTERVAL_MS ?? 30_000),
    age = now - row.last_heartbeat_at.getTime(),
    offline = Number(process.env.REMOTE_AGENT_OFFLINE_MS ?? 300_000);
  if (age > offline) return { status: "offline", reasons: ["Heartbeat exceeded offline threshold"] };
  if (age > interval * 4) return { status: "stale", reasons: ["Heartbeat missed more than four intervals"] };
  if (
    age > interval * 2 ||
    row.delivery_failures > 0 ||
    row.protocol_failures > 0 ||
    row.execution_failures > 0 ||
    row.current_executions >= row.concurrency_limit
  )
    return {
      status: "degraded",
      reasons: [
        age > interval * 2 ? "Heartbeat missed at least two intervals" : "Recent failure or concurrency saturation",
      ],
    };
  return { status: "active", reasons: ["Heartbeat and operational signals are healthy"] };
}
async function row(
  workspaceId: string,
  agentId: string,
  database: Pick<Pool | PoolClient, "query">,
  excludeExecutionId?: string,
) {
  return (
    await database.query<AgentRow>(
      `SELECT a.*,
        ca.attestation_hash capability_attestation_row_hash,
        ca.revoked_at capability_attestation_revoked_at,
        ca.expires_at capability_attestation_row_expires_at,
        count(e.*) FILTER(WHERE e.status NOT IN('succeeded','failed','timed_out','cancelled')
          AND ($3::uuid IS NULL OR e.execution_id<>$3::uuid))::int current_executions,
        count(e.*) FILTER(WHERE e.status IN('failed','timed_out') AND e.updated_at>now()-interval '1 hour')::int execution_failures,
        (SELECT count(*)::int FROM webhook_deliveries d WHERE d.workspace_id=a.workspace_id AND d.agent_id=a.agent_id AND d.status='failed' AND d.updated_at>now()-interval '1 hour') delivery_failures,
        (SELECT count(*)::int FROM protocol_security_events s WHERE s.workspace_id=a.workspace_id AND s.agent_id=a.agent_id AND s.occurred_at>now()-interval '1 hour') protocol_failures,
        (SELECT count(*)::int FROM agent_credentials c WHERE c.workspace_id=a.workspace_id AND c.agent_id=a.agent_id AND c.status IN('active','pending_verification','expiring') AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now())) valid_credentials
       FROM agents a
       LEFT JOIN execution_projections e ON e.workspace_id=a.workspace_id AND e.agent_id=a.agent_id
       LEFT JOIN agent_model_capability_attestations ca ON ca.workspace_id=a.workspace_id
         AND ca.capability_attestation_id=a.capability_attestation_id
       WHERE a.workspace_id=$1 AND a.agent_id=$2
       GROUP BY a.workspace_id,a.agent_id,ca.attestation_hash,ca.revoked_at,ca.expires_at`,
      [workspaceId, agentId, excludeExecutionId ?? null],
    )
  ).rows[0];
}
export async function evaluateAgentEligibility(input: {
  workspaceId: string;
  agentId: string;
  domain: string;
  requiredCapabilities: string[];
  requiredResources: RequiredResource[];
  protocolVersion?: string;
  requiredMissionRole?: string;
  requiredOperation?: AgentOperation;
  requiredOperations?: AgentOperation[];
  requiredModel?: string;
  requiredModelRole?: ModelCapabilityRole;
  requireStructuredOutput?: boolean;
  requireProjectBrainContext?: boolean;
  requireRepositoryMutation?: boolean;
  requireVerifiedMissionAgentArtifact?: boolean;
  excludeExecutionId?: string;
  database?: Pick<Pool | PoolClient, "query">;
}): Promise<EligibilityResult> {
  const database = input.database ?? getDatabasePool();
  const agent = await row(input.workspaceId, input.agentId, database, input.excludeExecutionId);
  if (!agent)
    return { eligible: false, reasons: ["Agent does not belong to this workspace"], health: "offline", score: 0 };
  const health = calculateAgentHealth(agent),
    reasons: string[] = [];
  if (!["active", "degraded"].includes(health.status)) reasons.push(`Agent health is ${health.status}`);
  if (!(agent.protocol_versions ?? []).includes(input.protocolVersion ?? "1.0"))
    reasons.push("Unsupported protocol version");
  if (!(agent.supported_domains ?? []).includes(input.domain)) reasons.push("Unsupported domain");
  if (input.requiredMissionRole && !(agent.supported_mission_roles ?? []).includes(input.requiredMissionRole))
    reasons.push(`Unsupported mission role: ${input.requiredMissionRole}`);
  const requiredOperations = Array.from(
    new Set([...(input.requiredOperations ?? []), ...(input.requiredOperation ? [input.requiredOperation] : [])]),
  );
  for (const requiredOperation of requiredOperations)
    if (!(agent.supported_operations ?? []).includes(requiredOperation))
      reasons.push(`Unsupported operation: ${requiredOperation}`);
  if (input.requiredModel && !(agent.supported_models ?? []).includes(input.requiredModel))
    reasons.push(`Unsupported model: ${input.requiredModel}`);
  if (input.requireStructuredOutput && !agent.structured_output) reasons.push("Structured output is not supported");
  if (input.requireProjectBrainContext && !agent.project_brain_context)
    reasons.push("Project Brain context is not supported");
  if (input.requireRepositoryMutation && !agent.repository_mutation)
    reasons.push("Repository mutation is not supported");
  const requiresProviderBinding = Boolean(
    input.requiredMissionRole ||
    requiredOperations.length ||
    input.requiredModel ||
    input.requireStructuredOutput ||
    input.requireProjectBrainContext ||
    input.requireRepositoryMutation ||
    input.requireVerifiedMissionAgentArtifact,
  );
  const mockValidationAuthorized =
    missionControlRuntimeMode() === "disposable_acceptance" &&
    process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance" &&
    agent.mission_agent_trust_authority === "non_authenticated_candidate_validation";
  if (requiresProviderBinding && !agent.provider_credentials_available && !mockValidationAuthorized)
    reasons.push("Provider credentials are not currently available locally");
  const runtimeBinding = providerRuntimeBindingFor(agent.provider_id as AgentProvider);
  if (
    requiresProviderBinding &&
    (agent.provider_runtime_requirements_id !== runtimeBinding.requirementsId ||
      agent.provider_runtime_requirements_hash !== runtimeBinding.requirementsHash ||
      !agent.provider_runtime_requirements_satisfied)
  )
    reasons.push("Provider runtime requirements are missing, stale, or unsatisfied");
  let selectedRuntimeProfile: ProviderRuntimeProfileBinding | undefined;
  if (
    requiresProviderBinding &&
    (agent.provider_id === "codex" || agent.provider_id === "claude_code") &&
    input.requiredModelRole &&
    requiredOperations.length
  ) {
    try {
      const expected = providerRuntimeProfileFor(agent.provider_id, input.requiredModelRole, requiredOperations);
      selectedRuntimeProfile = expected;
      if (
        !(agent.provider_runtime_profiles ?? []).some(
          (binding) =>
            binding.catalogVersion === selectedRuntimeProfile?.catalogVersion &&
            binding.profileId === selectedRuntimeProfile.profileId &&
            binding.profileHash === selectedRuntimeProfile.profileHash &&
            binding.runtimeBindingHash === selectedRuntimeProfile.runtimeBindingHash,
        )
      )
        reasons.push("Required provider runtime profile is missing or stale");
    } catch {
      reasons.push("No provider runtime profile supports this assignment");
    }
  }
  if (
    requiresProviderBinding &&
    (!agent.capability_attestation_id ||
      !agent.capability_attestation_hash ||
      agent.capability_attestation_hash !== agent.capability_attestation_row_hash ||
      agent.capability_attestation_revoked_at ||
      !agent.capability_attestation_expires_at ||
      !agent.capability_attestation_row_expires_at ||
      agent.capability_attestation_expires_at.getTime() <= Date.now() ||
      agent.capability_attestation_row_expires_at.getTime() <= Date.now())
  )
    reasons.push("Capability attestation is missing, stale, mismatched, or revoked");
  const modelCapability = input.requiredModel
    ? (agent.model_capabilities ?? []).find((item) => item.modelId === input.requiredModel)
    : undefined;
  if (input.requiredModel && !modelCapability) reasons.push(`Model capability is not attested: ${input.requiredModel}`);
  if (modelCapability && input.requiredModelRole && !modelCapability.supportedRoles.includes(input.requiredModelRole))
    reasons.push(`Model ${input.requiredModel} does not support role ${input.requiredModelRole}`);
  for (const operation of requiredOperations)
    if (modelCapability && !modelCapability.supportedOperations.includes(operation))
      reasons.push(`Model ${input.requiredModel} does not support operation ${operation}`);
  if (input.requireStructuredOutput && modelCapability && !modelCapability.structuredOutput)
    reasons.push(`Model ${input.requiredModel} does not support structured output`);
  if (input.requireRepositoryMutation && modelCapability && !modelCapability.repositoryMutation)
    reasons.push(`Model ${input.requiredModel} does not support repository mutation`);
  if (
    input.requireVerifiedMissionAgentArtifact &&
    (agent.mission_agent_checksum_status !== "verified" ||
      !/^0\.(?:[89]|[1-9][0-9])\./.test(agent.mission_agent_version ?? ""))
  )
    reasons.push("Mission Agent 0.8 or later requires a verified approved artifact");
  if (input.requireVerifiedMissionAgentArtifact && missionControlRuntimeMode() === "disposable_acceptance") {
    const trust = runtimeTrustEvidence();
    if (
      agent.mission_agent_runtime_mode !== trust.runtimeMode ||
      agent.mission_agent_trust_authority !== trust.trustAuthority ||
      agent.mission_agent_acceptance_registry_path !== trust.registryPath ||
      agent.mission_agent_acceptance_registry_path_hash !== trust.registryPathHash ||
      agent.mission_agent_acceptance_registry_hash !== trust.registryContentHash
    )
      reasons.push("Disposable acceptance registry trust binding is missing, stale, or mismatched");
  }
  if (
    input.requireVerifiedMissionAgentArtifact &&
    (!agent.mission_agent_capability_expires_at || agent.mission_agent_capability_expires_at.getTime() <= Date.now())
  )
    reasons.push("Mission Agent artifact capability attestation has expired");
  for (const capability of input.requiredCapabilities)
    if (!(agent.capabilities ?? []).includes(capability)) reasons.push(`Missing capability: ${capability}`);
  if (agent.current_executions >= agent.concurrency_limit) reasons.push("Concurrency limit reached");
  for (const resource of input.requiredResources) {
    const permission = await database.query<{ permissions: string[] }>(
      `SELECT permissions FROM agent_resource_permissions WHERE workspace_id=$1 AND agent_id=$2 AND resource_type=$3 AND resource_id=$4 AND revoked_at IS NULL`,
      [input.workspaceId, input.agentId, resource.resourceType, resource.resourceId],
    );
    if (!permission.rows[0]?.permissions.includes(resource.permission))
      reasons.push(`Resource access denied: ${resource.resourceType}/${resource.resourceId}:${resource.permission}`);
  }
  const score = Math.max(
    0,
    100 -
      reasons.length * 25 -
      agent.current_executions * 10 -
      agent.delivery_failures * 5 -
      agent.execution_failures * 5,
  );
  return {
    eligible: reasons.length === 0,
    reasons: [...health.reasons, ...reasons],
    health: health.status,
    score,
    providerId: agent.provider_id,
    modelCapability,
    capabilityAttestationId: agent.capability_attestation_id ?? undefined,
    capabilityAttestationHash: agent.capability_attestation_hash ?? undefined,
    providerRuntimeRequirementsId: agent.provider_runtime_requirements_id ?? undefined,
    providerRuntimeRequirementsHash: agent.provider_runtime_requirements_hash ?? undefined,
    providerRuntimeProfile: selectedRuntimeProfile,
  };
}
export async function grantAgentResource(
  input: {
    workspaceId: string;
    agentId: string;
    resourceType: string;
    resourceId: string;
    permissions: string[];
  },
  database: Pick<Pool | PoolClient, "query"> = getDatabasePool(),
) {
  await database.query(
    `INSERT INTO agent_resource_permissions(workspace_id,agent_id,resource_type,resource_id,permissions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,agent_id,resource_type,resource_id) DO UPDATE SET permissions=EXCLUDED.permissions,revoked_at=NULL`,
    [
      input.workspaceId,
      input.agentId,
      input.resourceType,
      input.resourceId,
      JSON.stringify(Array.from(new Set(input.permissions)).sort()),
    ],
  );
}
