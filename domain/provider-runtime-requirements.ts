import requirements from "@/domain/provider-runtime-requirements.json";
import { canonicalHash } from "@/lib/canonical-json";
import { ValidationFailedError } from "@/lib/application-errors";
import type { AgentProvider, ModelCapability } from "@/domain/agent-provider";
import {
  expectedProviderRuntimeProfileBindings,
  parseProviderRuntimeProfileBindings,
  type ProviderRuntimeProfileBinding,
} from "@/domain/provider-runtime-profiles";

export type ProviderRuntimeRequirement = {
  requirementsId: string;
  executionMode: "local_cli" | "protocol_bridge" | "remote_protocol" | "in_process_test";
  executable: string | null;
  supportedCliVersions: string[];
  authenticationProbe: string[];
  supportedPlatforms: string[];
  isolation: {
    mechanism: string;
    network: string;
    temporaryStorage: string;
    credentialReadScopes: string[];
    planningRepositoryAccess: string;
    implementationRepositoryAccess: string;
    processControl: boolean;
  };
  modelSelection: {
    mechanism: string;
    argument: string | null;
    fallback: string;
    runtimeIdentity: ModelCapability["runtimeModelIdentity"];
  };
  structuredOutput: string;
  requiresCleanPlanningWorktree: boolean;
  diagnosticRedaction: string;
  consensusEligible: boolean;
};

export type ProviderRuntimeBinding = {
  contractVersion: "provider-runtime-requirements/1";
  requirementsId: string;
  requirementsHash: string;
};

export type ProviderRuntimeStatus = ProviderRuntimeBinding & {
  platform: string;
  executableAvailable: boolean;
  providerVersion: string | null;
  authenticationAvailable: boolean;
  isolationMechanism: string;
  isolationAvailable: boolean;
  modelSelectionMechanism: string;
  runtimeModelIdentity: ModelCapability["runtimeModelIdentity"];
  runtimeProfiles: ProviderRuntimeProfileBinding[];
};

const catalog = requirements as {
  contractVersion: "provider-runtime-requirements/1";
  contractScope: "consensus_execution";
  providers: Record<AgentProvider, ProviderRuntimeRequirement>;
};

export const providerRuntimeRequirements = catalog;

export function providerRuntimeRequirementFor(provider: AgentProvider): ProviderRuntimeRequirement {
  const requirement = catalog.providers[provider];
  if (!requirement) throw new ValidationFailedError(`No runtime requirement contract exists for provider ${provider}`);
  return requirement;
}

export function providerRuntimeBindingFor(provider: AgentProvider): ProviderRuntimeBinding {
  const requirement = providerRuntimeRequirementFor(provider);
  return {
    contractVersion: catalog.contractVersion,
    requirementsId: requirement.requirementsId,
    requirementsHash: canonicalHash({
      contractVersion: catalog.contractVersion,
      contractScope: catalog.contractScope,
      provider,
      requirement,
    }),
  };
}

export function parseProviderRuntimeStatus(value: unknown, provider: AgentProvider): ProviderRuntimeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Provider runtime status must be an object");
  const row = value as Record<string, unknown>;
  const binding = providerRuntimeBindingFor(provider);
  const status: ProviderRuntimeStatus = {
    contractVersion: String(row.contractVersion ?? "") as ProviderRuntimeStatus["contractVersion"],
    requirementsId: String(row.requirementsId ?? ""),
    requirementsHash: String(row.requirementsHash ?? ""),
    platform: String(row.platform ?? ""),
    executableAvailable: row.executableAvailable === true,
    providerVersion:
      row.providerVersion === null || row.providerVersion === undefined
        ? null
        : String(row.providerVersion).slice(0, 160),
    authenticationAvailable: row.authenticationAvailable === true,
    isolationMechanism: String(row.isolationMechanism ?? ""),
    isolationAvailable: row.isolationAvailable === true,
    modelSelectionMechanism: String(row.modelSelectionMechanism ?? ""),
    runtimeModelIdentity: String(row.runtimeModelIdentity ?? "") as ModelCapability["runtimeModelIdentity"],
    runtimeProfiles:
      provider === "codex" || provider === "claude_code"
        ? parseProviderRuntimeProfileBindings(row.runtimeProfiles, provider)
        : [],
  };
  if (
    status.contractVersion !== binding.contractVersion ||
    status.requirementsId !== binding.requirementsId ||
    status.requirementsHash !== binding.requirementsHash
  )
    throw new ValidationFailedError("Provider runtime status does not bind the current requirement contract");
  if (!/^[a-z0-9._-]{1,64}$/.test(status.platform))
    throw new ValidationFailedError("Provider runtime status platform is invalid");
  if (!/^[-a-z0-9._/]{1,80}$/.test(status.isolationMechanism))
    throw new ValidationFailedError("Provider runtime isolation mechanism is invalid");
  if (!/^[-a-z0-9._/]{1,80}$/.test(status.modelSelectionMechanism))
    throw new ValidationFailedError("Provider runtime model-selection mechanism is invalid");
  if (!["verified", "reported", "unverifiable"].includes(status.runtimeModelIdentity))
    throw new ValidationFailedError("Provider runtime model identity mode is invalid");
  return status;
}

export function providerRuntimeStatusSatisfies(provider: AgentProvider, status: ProviderRuntimeStatus) {
  const requirement = providerRuntimeRequirementFor(provider);
  if (!requirement.consensusEligible) return false;
  const mockValidation =
    process.env.APP_ENV === "disposable_acceptance" &&
    process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance";
  const reportedVersion = status.providerVersion?.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
  const versionSupported =
    requirement.executionMode !== "local_cli" ||
    (Boolean(reportedVersion) && requirement.supportedCliVersions.includes(reportedVersion!));
  const platformSupported =
    requirement.supportedPlatforms.length === 0 || requirement.supportedPlatforms.includes(status.platform);
  const localCliReady =
    requirement.executionMode !== "local_cli" ||
    (mockValidation &&
      status.executableAvailable &&
      !status.authenticationAvailable &&
      status.isolationAvailable &&
      status.isolationMechanism === "mock-subprocess" &&
      status.modelSelectionMechanism === "deterministic-fixture" &&
      status.runtimeModelIdentity === "unverifiable" &&
      canonicalHash(status.runtimeProfiles) === canonicalHash(expectedProviderRuntimeProfileBindings(provider))) ||
    (status.executableAvailable &&
      status.authenticationAvailable &&
      status.isolationAvailable &&
      status.isolationMechanism === requirement.isolation.mechanism &&
      status.modelSelectionMechanism === requirement.modelSelection.mechanism &&
      status.runtimeModelIdentity === requirement.modelSelection.runtimeIdentity &&
      canonicalHash(status.runtimeProfiles) === canonicalHash(expectedProviderRuntimeProfileBindings(provider)));
  return platformSupported && versionSupported && localCliReady;
}
