import profiles from "@/domain/provider-runtime-profiles.proposed.json";
import { createHash } from "node:crypto";
import { canonicalHash } from "@/lib/canonical-json";
import { ValidationFailedError } from "@/lib/application-errors";
import type { AgentOperation, AgentProvider, ModelCapabilityRole } from "@/domain/agent-provider";

export type ProviderRuntimeProfile = {
  provider: "codex" | "claude_code";
  providerInvocation: {
    mode: "direct_native_binary" | "direct_executable";
    relativeExecutableFromInstallationRoot: string;
  };
  approvedRuntimeBinding: {
    providerExecutableSha256: string;
    resolvedExecutableIdentitySha256: string;
    invokedExecutableSha256: string;
    invokedExecutableIdentitySha256: string;
    installationRootIdentitySha256: string;
    lexicalRuntimeRootIdentitySha256: string;
    agentRuntimeRootIdentitySha256: string;
    providerCredentialIdentitySha256: string | null;
    keychainIdentitySha256: string | null;
    keychainAccountIdentitySha256: string | null;
  };
  supportedCliVersions: string[];
  supportedMissionRoles: ModelCapabilityRole[];
  supportedOperations: AgentOperation[];
  filesystemReadScope: string[];
  filesystemWriteScope: string[];
  temporaryDirectoryScope: string;
  providerCredentialScope: string;
  keychainScope: string;
  networkPolicy: string;
  loopbackPolicy: string;
  unixSocketPolicy: string;
  childProcessPolicy: string;
  gitPolicy: string;
  shellPolicy: string;
  environmentAllowlist: string[];
  timeoutSecondsMaximum: number;
  outputBytesMaximum: number;
  diagnosticPolicy: string;
  cancellationBehavior: string;
  processTreeTerminationBehavior: string;
  cleanWorktreeRequirement: boolean;
  snapshotBindingRequirement: string;
  runtimeHashInputs: string[];
  knownPlatformLimitations: string[];
};

type Catalog = {
  catalogVersion: "provider-runtime-profiles/2";
  status: "proposed_for_disposable_acceptance";
  platform: "darwin";
  sandboxPolicyTemplate: string;
  profiles: Record<string, ProviderRuntimeProfile>;
};

const catalog = profiles as Catalog;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const proposedProviderRuntimeProfiles = catalog;

export type ProviderRuntimeProfileBinding = {
  catalogVersion: Catalog["catalogVersion"];
  profileId: string;
  profileHash: string;
  runtimeBindingHash: string;
  providerCliVersion: string;
  providerExecutableSha256: string;
  resolvedExecutableIdentitySha256: string;
  invokedExecutableSha256: string;
  invokedExecutableIdentitySha256: string;
  installationRootIdentitySha256: string;
  lexicalRuntimeRootIdentitySha256: string;
  agentRuntimeRootIdentitySha256: string;
  providerCredentialIdentitySha256: string | null;
  keychainIdentitySha256: string | null;
  keychainAccountIdentitySha256: string | null;
  sandboxPolicySha256: string;
};

export function providerRuntimeProfileBinding(profileId: string): ProviderRuntimeProfileBinding {
  const profile = catalog.profiles[profileId];
  if (!profile) throw new ValidationFailedError(`Unknown provider runtime profile ${profileId}`);
  const profileHash = canonicalHash({
    catalogVersion: catalog.catalogVersion,
    profileId,
    profile,
    sandboxPolicyTemplate: catalog.sandboxPolicyTemplate,
  });
  const runtimeEvidence = {
    providerCliVersion: profile.supportedCliVersions[0],
    ...profile.approvedRuntimeBinding,
    sandboxPolicySha256: sha256(catalog.sandboxPolicyTemplate),
  };
  return {
    catalogVersion: catalog.catalogVersion,
    profileId,
    profileHash,
    ...runtimeEvidence,
    runtimeBindingHash: canonicalHash({ profileHash, ...runtimeEvidence }),
  };
}

export function providerRuntimeProfileFor(
  provider: AgentProvider,
  role: ModelCapabilityRole,
  operations: AgentOperation[],
) {
  const matches = Object.entries(catalog.profiles).filter(([, profile]) => {
    return (
      profile.provider === provider &&
      profile.supportedMissionRoles.includes(role) &&
      operations.every((operation) => profile.supportedOperations.includes(operation))
    );
  });
  if (matches.length !== 1)
    throw new ValidationFailedError(
      `Provider ${provider} requires exactly one runtime profile for ${role}/${operations.join(",")}`,
    );
  const [profileId, profile] = matches[0];
  return { ...providerRuntimeProfileBinding(profileId), profile };
}

export function expectedProviderRuntimeProfileBindings(provider: AgentProvider) {
  return Object.entries(catalog.profiles)
    .filter(([, profile]) => profile.provider === provider)
    .map(([profileId]) => providerRuntimeProfileBinding(profileId))
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
}

export function parseProviderRuntimeProfileBindings(value: unknown, provider: AgentProvider) {
  if (!Array.isArray(value)) throw new ValidationFailedError("Provider runtime profiles must be an array");
  const expected = expectedProviderRuntimeProfileBindings(provider);
  const parsed = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ValidationFailedError("Provider runtime profile binding must be an object");
    const row = item as Record<string, unknown>;
    const binding = {
      catalogVersion: String(row.catalogVersion ?? ""),
      profileId: String(row.profileId ?? ""),
      profileHash: String(row.profileHash ?? ""),
      runtimeBindingHash: String(row.runtimeBindingHash ?? ""),
      providerCliVersion: String(row.providerCliVersion ?? ""),
      providerExecutableSha256: String(row.providerExecutableSha256 ?? ""),
      resolvedExecutableIdentitySha256: String(row.resolvedExecutableIdentitySha256 ?? ""),
      invokedExecutableSha256: String(row.invokedExecutableSha256 ?? ""),
      invokedExecutableIdentitySha256: String(row.invokedExecutableIdentitySha256 ?? ""),
      installationRootIdentitySha256: String(row.installationRootIdentitySha256 ?? ""),
      lexicalRuntimeRootIdentitySha256: String(row.lexicalRuntimeRootIdentitySha256 ?? ""),
      agentRuntimeRootIdentitySha256: String(row.agentRuntimeRootIdentitySha256 ?? ""),
      providerCredentialIdentitySha256:
        row.providerCredentialIdentitySha256 === null ? null : String(row.providerCredentialIdentitySha256 ?? ""),
      keychainIdentitySha256: row.keychainIdentitySha256 === null ? null : String(row.keychainIdentitySha256 ?? ""),
      keychainAccountIdentitySha256:
        row.keychainAccountIdentitySha256 === null ? null : String(row.keychainAccountIdentitySha256 ?? ""),
      sandboxPolicySha256: String(row.sandboxPolicySha256 ?? ""),
    };
    if (
      !/^[-a-z0-9._/]{1,128}$/.test(binding.profileId) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(binding.providerCliVersion) ||
      [
        binding.profileHash,
        binding.runtimeBindingHash,
        binding.providerExecutableSha256,
        binding.resolvedExecutableIdentitySha256,
        binding.invokedExecutableSha256,
        binding.invokedExecutableIdentitySha256,
        binding.installationRootIdentitySha256,
        binding.lexicalRuntimeRootIdentitySha256,
        binding.agentRuntimeRootIdentitySha256,
        binding.sandboxPolicySha256,
      ].some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
      [binding.keychainIdentitySha256, binding.keychainAccountIdentitySha256].some(
        (hash) => hash !== null && !/^[a-f0-9]{64}$/.test(hash),
      ) ||
      (binding.providerCredentialIdentitySha256 !== null &&
        !/^[a-f0-9]{64}$/.test(binding.providerCredentialIdentitySha256))
    )
      throw new ValidationFailedError("Provider runtime profile binding is malformed");
    return binding;
  });
  if (canonicalHash(parsed) !== canonicalHash(expected))
    throw new ValidationFailedError("Provider runtime profile bindings do not match the proposed catalog");
  return expected;
}
