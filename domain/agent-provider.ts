import { ValidationFailedError } from "@/lib/application-errors";
import { providerRuntimeBindingFor, type ProviderRuntimeBinding } from "@/domain/provider-runtime-requirements";

export const agentProviders = ["codex", "claude_code", "hermes", "generic", "mock"] as const;
export type AgentProvider = (typeof agentProviders)[number];

export const missionRoles = ["planner", "reviewer", "executor"] as const;
export type MissionRole = (typeof missionRoles)[number];

export const modelCapabilityRoles = ["planner", "synthesizer", "executor", "implementation_reviewer"] as const;
export type ModelCapabilityRole = (typeof modelCapabilityRoles)[number];

export const modelCapabilitySources = ["provider_discovery", "operator_allowlist", "hybrid"] as const;
export type ModelCapabilitySource = (typeof modelCapabilitySources)[number];

export const agentOperations = [
  "inspect_repository",
  "prepare_project_brain_context",
  "generate_structured_plan",
  "critique_plan",
  "revise_plan",
  "review_canonical_plan",
  "implement_change",
  "review_implementation",
] as const;
export type AgentOperation = (typeof agentOperations)[number];

export type AgentProviderProfile = {
  provider: AgentProvider;
  agentVersion: string;
  supportedMissionRoles: MissionRole[];
  supportedOperations: AgentOperation[];
  supportedModels: string[];
  structuredOutput: boolean;
  projectBrainContext: boolean;
  repositoryMutation: boolean;
  modelCapabilities: ModelCapability[];
  capabilityAttestationVersion: number;
  capabilitySource: ModelCapabilitySource;
  runtimeRequirements?: ProviderRuntimeBinding;
};

export type ModelCapability = {
  modelId: string;
  displayName: string;
  provider: AgentProvider;
  supportedRoles: ModelCapabilityRole[];
  supportedOperations: AgentOperation[];
  structuredOutput: boolean;
  repositoryRead: boolean;
  repositoryMutation: boolean;
  planMode: boolean;
  runtimeModelIdentity: "verified" | "reported" | "unverifiable";
};

const identifier = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

function stringList<T extends string>(value: unknown, name: string, allowed?: readonly T[], maximum = 32): T[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string"))
    throw new ValidationFailedError(`${name} must be a bounded string list`);
  const normalized = Array.from(new Set(value.map((item) => String(item).trim()))).filter(Boolean);
  if (normalized.some((item) => !identifier.test(item)))
    throw new ValidationFailedError(`${name} contains an invalid identifier`);
  if (allowed && normalized.some((item) => !allowed.includes(item as T)))
    throw new ValidationFailedError(`${name} contains an unsupported value`);
  return normalized.sort() as T[];
}

function parseModelCapability(value: unknown, provider: AgentProvider): ModelCapability {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Model capability must be an object");
  const row = value as Record<string, unknown>;
  const modelId = String(row.model_id ?? row.modelId ?? "").trim();
  const displayName = String(row.display_name ?? row.displayName ?? modelId).trim();
  const declaredProvider = String(row.provider ?? provider) as AgentProvider;
  const runtimeModelIdentity = String(
    row.runtime_model_identity ?? row.runtimeModelIdentity ?? "unverifiable",
  ) as ModelCapability["runtimeModelIdentity"];
  if (!identifier.test(modelId)) throw new ValidationFailedError("Model capability has an invalid model identifier");
  if (!displayName || displayName.length > 160 || /[\u0000-\u001f\u007f]/.test(displayName))
    throw new ValidationFailedError("Model capability has an invalid display name");
  if (declaredProvider !== provider) throw new ValidationFailedError("Model capability provider does not match agent");
  if (!["verified", "reported", "unverifiable"].includes(runtimeModelIdentity))
    throw new ValidationFailedError("Model capability runtime identity mode is invalid");
  const capability: ModelCapability = {
    modelId,
    displayName,
    provider,
    supportedRoles: stringList(
      row.supported_roles ?? row.supportedRoles,
      "Model supported roles",
      modelCapabilityRoles,
      modelCapabilityRoles.length,
    ),
    supportedOperations: stringList(
      row.supported_operations ?? row.supportedOperations,
      "Model supported operations",
      agentOperations,
      agentOperations.length,
    ),
    structuredOutput: row.structured_output === true || row.structuredOutput === true,
    repositoryRead: row.repository_read === true || row.repositoryRead === true,
    repositoryMutation: row.repository_mutation === true || row.repositoryMutation === true,
    planMode: row.plan_mode === true || row.planMode === true,
    runtimeModelIdentity,
  };
  if (!capability.supportedRoles.length || !capability.supportedOperations.length)
    throw new ValidationFailedError("Model capability requires at least one role and operation");
  if (capability.repositoryMutation && !capability.supportedOperations.includes("implement_change"))
    throw new ValidationFailedError("Model repository mutation requires implement_change support");
  if (capability.supportedRoles.includes("planner") && (!capability.structuredOutput || !capability.repositoryRead))
    throw new ValidationFailedError("Planner models require structured output and repository read support");
  if (capability.supportedRoles.includes("executor") && !capability.repositoryMutation)
    throw new ValidationFailedError("Executor models require repository mutation support");
  return capability;
}

export function parseAgentProviderProfile(value: unknown): AgentProviderProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Agent provider profile must be an object");
  const row = value as Record<string, unknown>;
  const provider = String(row.provider ?? "") as AgentProvider;
  const agentVersion = String(row.agent_version ?? row.agentVersion ?? "").trim();
  if (!agentProviders.includes(provider)) throw new ValidationFailedError("Unsupported agent provider");
  if (!agentVersion || agentVersion.length > 80 || /[\u0000-\u001f\u007f]/.test(agentVersion))
    throw new ValidationFailedError("Agent version is invalid");
  const supportedModels = stringList<string>(
    row.supported_models ?? row.supportedModels,
    "Supported models",
    undefined,
    24,
  );
  if (!supportedModels.length) throw new ValidationFailedError("At least one provider model is required");
  const rawModelCapabilities = row.model_capabilities ?? row.modelCapabilities;
  if (!Array.isArray(rawModelCapabilities) || rawModelCapabilities.length > 24)
    throw new ValidationFailedError("Model capabilities must be a bounded explicit list");
  const modelCapabilities = rawModelCapabilities.map((item) => parseModelCapability(item, provider));
  if (new Set(modelCapabilities.map((item) => item.modelId)).size !== modelCapabilities.length)
    throw new ValidationFailedError("Model capabilities contain duplicate model identifiers");
  if (
    modelCapabilities.some((capability) => !supportedModels.includes(capability.modelId)) ||
    supportedModels.some((model) => !modelCapabilities.some((capability) => capability.modelId === model))
  )
    throw new ValidationFailedError("Supported models and model capabilities must describe the same identifiers");
  const capabilityAttestationVersion = Number(
    row.capability_attestation_version ?? row.capabilityAttestationVersion ?? 0,
  );
  const capabilitySource = String(row.capability_source ?? row.capabilitySource ?? "") as ModelCapabilitySource;
  if (!Number.isSafeInteger(capabilityAttestationVersion) || capabilityAttestationVersion < 1)
    throw new ValidationFailedError("Capability attestation version must be a positive integer");
  if (!modelCapabilitySources.includes(capabilitySource))
    throw new ValidationFailedError("Capability source must be provider discovery, operator allowlist, or hybrid");
  const profile: AgentProviderProfile = {
    provider,
    agentVersion,
    supportedMissionRoles: stringList(
      row.supported_mission_roles ?? row.supportedMissionRoles,
      "Supported mission roles",
      missionRoles,
    ),
    supportedOperations: stringList(
      row.supported_operations ?? row.supportedOperations,
      "Supported operations",
      agentOperations,
    ),
    supportedModels,
    structuredOutput: row.structured_output === true || row.structuredOutput === true,
    projectBrainContext: row.project_brain_context === true || row.projectBrainContext === true,
    repositoryMutation: row.repository_mutation === true || row.repositoryMutation === true,
    modelCapabilities,
    capabilityAttestationVersion,
    capabilitySource,
    runtimeRequirements: providerRuntimeBindingFor(provider),
  };
  if (profile.repositoryMutation && !profile.supportedOperations.includes("implement_change"))
    throw new ValidationFailedError("Repository mutation requires implement_change support");
  if (
    profile.modelCapabilities.some((capability) =>
      capability.supportedOperations.some((operation) => !profile.supportedOperations.includes(operation)),
    )
  )
    throw new ValidationFailedError("Model capabilities cannot exceed the agent provider operation profile");
  return profile;
}

export function modelCapabilityFor(
  profile: AgentProviderProfile,
  modelId: string,
  role: ModelCapabilityRole,
  operations: AgentOperation[],
) {
  const capability = profile.modelCapabilities.find((candidate) => candidate.modelId === modelId);
  if (!capability) return undefined;
  if (!capability.supportedRoles.includes(role)) return undefined;
  if (operations.some((operation) => !capability.supportedOperations.includes(operation))) return undefined;
  return capability;
}

export function supportsAgentOperation(
  profile: AgentProviderProfile,
  role: MissionRole,
  operation: AgentOperation,
  model?: string,
) {
  const modelRole: ModelCapabilityRole = role === "reviewer" ? "planner" : role;
  const capability = model ? modelCapabilityFor(profile, model, modelRole, [operation]) : undefined;
  return (
    profile.supportedMissionRoles.includes(role) &&
    profile.supportedOperations.includes(operation) &&
    profile.structuredOutput &&
    (!model || Boolean(capability))
  );
}
