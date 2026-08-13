import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function canonicalJsonLocale(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonLocale).join(",")}]`;
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonLocale(value[key])}`)
    .join(",")}}`;
}

const sourceCommitIndex = process.argv.indexOf("--source-commit");
const sourceCommit = sourceCommitIndex >= 0 ? process.argv[sourceCommitIndex + 1] : undefined;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("Provide --source-commit as a full lowercase Git SHA");

const templatePath = resolve("scripts/mission-agent-080.template.mjs");
const targetPath = resolve(
  process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : "public/mission-agent-0.8.0.mjs",
);
const marker = "__MISSION_AGENT_BUILD_SOURCE_COMMIT__";
const acceptanceSourceManifestMarker = "__MISSION_AGENT_ACCEPTANCE_SOURCE_MANIFEST_SHA256__";
const providerRequirementsMarker = "__MISSION_AGENT_PROVIDER_RUNTIME_REQUIREMENTS__";
const providerProfilesMarker = "__MISSION_AGENT_PROVIDER_RUNTIME_PROFILES__";
const template = await readFile(templatePath, "utf8");
if (template.split(marker).length !== 2)
  throw new Error("Mission Agent 0.8.0 template must contain exactly one source-commit marker");
if (template.split(acceptanceSourceManifestMarker).length !== 2)
  throw new Error("Mission Agent 0.8.0 template must contain exactly one acceptance-source-manifest marker");
if (template.split(providerRequirementsMarker).length !== 2)
  throw new Error("Mission Agent 0.8.0 template must contain exactly one provider-requirements marker");
if (template.split(providerProfilesMarker).length !== 2)
  throw new Error("Mission Agent 0.8.0 template must contain exactly one provider-profile marker");

const providerRequirements = JSON.parse(await readFile(resolve("domain/provider-runtime-requirements.json"), "utf8"));
const providerProfiles = JSON.parse(await readFile(resolve("domain/provider-runtime-profiles.proposed.json"), "utf8"));
const runtimeModeDefinition = JSON.parse(await readFile(resolve("domain/runtime-mode-definition.json"), "utf8"));
const runtimeModeDefinitionBytes = await readFile(resolve("domain/runtime-mode-definition.json"));
const disposableRegistrySchema = JSON.parse(
  await readFile(resolve("domain/disposable-acceptance-registry.schema.json"), "utf8"),
);
const repositorySnapshotSchema = JSON.parse(await readFile(resolve("domain/repository-snapshot.schema.json"), "utf8"));
const repositoryAuthoritySchema = JSON.parse(
  await readFile(resolve("domain/repository-authority.schema.json"), "utf8"),
);
execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-consensus-acceptance-contract.mjs", "--check"], {
  cwd: process.cwd(),
  stdio: "pipe",
});
const acceptanceSourceManifest = JSON.parse(
  await readFile(resolve("domain/mission-control-acceptance-source-manifest.json"), "utf8"),
);
const acceptanceSourceManifestSchema = JSON.parse(
  await readFile(resolve("domain/mission-control-acceptance-source-manifest.schema.json"), "utf8"),
);
const acceptanceContractBytes = await readFile(resolve("domain/consensus-real-provider-acceptance-contract.json"));
const acceptanceContract = JSON.parse(acceptanceContractBytes.toString("utf8"));
const acceptanceContractSchemaBytes = await readFile(
  resolve("domain/consensus-real-provider-acceptance-contract.schema.json"),
);
const acceptanceContractSchema = JSON.parse(acceptanceContractSchemaBytes.toString("utf8"));
const acceptanceExecutableRegistryBytes = await readFile(resolve("scripts/consensus-real-acceptance-steps.ts"));
const registrySourceHash = createHash("sha256").update(acceptanceExecutableRegistryBytes).digest("hex");
const seenContractSteps = new Set();
const seenRequirements = new Set();
for (const step of acceptanceContract.steps ?? []) {
  if (
    !step.mandatory ||
    seenContractSteps.has(step.step_id) ||
    seenRequirements.has(step.requirement_id) ||
    step.implementation_module !== "scripts/consensus-real-acceptance-steps.ts" ||
    !Array.isArray(step.bound_source_modules) ||
    !step.bound_source_modules.length
  )
    throw new Error("Acceptance contract executable inventory is invalid");
  const boundSourceHashes = await Promise.all(
    step.bound_source_modules.map(async (sourceModule) => ({
      sourceModule,
      sha256: createHash("sha256")
        .update(await readFile(resolve(sourceModule)))
        .digest("hex"),
    })),
  );
  const validatorSources = [
    "scripts/consensus-real-acceptance-steps.ts",
    "lib/acceptance-requirement-evidence.ts",
    "lib/acceptance-semantic-validation.ts",
  ].map((sourceModule) => ({
    sourceModule,
    sha256:
      sourceModule === "scripts/consensus-real-acceptance-steps.ts"
        ? registrySourceHash
        : boundSourceHashes.find((item) => item.sourceModule === sourceModule)?.sha256,
  }));
  if (validatorSources.some((item) => !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")))
    throw new Error(`Acceptance validator source binding is incomplete: ${step.step_id}`);
  const validatorIdentity = createHash("sha256")
    .update(
      canonicalJson({
        validatorRegistryVersion: acceptanceContract.validator_registry_version,
        validatorSources,
        validatorConfigurationIdentity: step.validator_configuration_identity,
        stepId: step.step_id,
        requirementId: step.requirement_id,
        evidenceSchema: step.evidence_schema,
        requiredFields: step.required_evidence_fields,
        passCriteriaId: step.pass_criteria_id,
        applicableRoles: step.applicable_roles,
        applicableProviders: step.applicable_providers,
        applicableModels: step.applicable_models,
        applicableProfiles: step.applicable_profiles,
      }),
    )
    .digest("hex");
  if (validatorIdentity !== step.validator_identity)
    throw new Error(`Acceptance validator implementation identity changed: ${step.step_id}`);
  const identity = createHash("sha256")
    .update(
      canonicalJson({
        registryVersion: acceptanceContract.registry_version,
        registryHash: registrySourceHash,
        boundSourceHashes,
        stepId: step.step_id,
        category: step.category,
        requirementId: step.requirement_id,
        mandatory: step.mandatory,
        applicableRoles: step.applicable_roles,
        applicableProviders: step.applicable_providers,
        applicableModels: step.applicable_models,
        applicableProfiles: step.applicable_profiles,
        protectedAction: step.protected_action,
        expectedFailureCode: step.expected_failure_code,
        evidenceSchema: step.evidence_schema,
        implementationModule: step.implementation_module,
        executionPhase: step.execution_phase,
        lifecyclePhase: step.lifecycle_phase,
        implementationReference: step.implementation_reference,
        validatorId: step.validator_id,
        validatorIdentity: step.validator_identity,
        requiredFields: step.required_evidence_fields,
        passCriteriaId: step.pass_criteria_id,
        timeoutMs: step.timeout_ms,
      }),
    )
    .digest("hex");
  if (identity !== step.implementation_identity)
    throw new Error(`Acceptance contract implementation identity changed: ${step.step_id}`);
  seenContractSteps.add(step.step_id);
  seenRequirements.add(step.requirement_id);
}
if (!seenContractSteps.size) throw new Error("Acceptance contract has no executable steps");

const artifact = template
  .replace(marker, sourceCommit)
  .replace(
    acceptanceSourceManifestMarker,
    createHash("sha256").update(canonicalJsonLocale(acceptanceSourceManifest)).digest("hex"),
  )
  .replace(providerRequirementsMarker, JSON.stringify(providerRequirements))
  .replace(providerProfilesMarker, JSON.stringify(providerProfiles));
const artifactBytes = Buffer.from(artifact, "utf8");
const sourceTemplateSha256 = createHash("sha256").update(template).digest("hex");
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const metadata = {
  artifactByteLength: artifactBytes.byteLength,
  canonicalizationVersion: "release-manifest-json-v3",
  manifestVersion: "3",
  publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  releaseAuthorityVersion: "v2",
  sha256: artifactSha256,
  signingKeyId: "mission-agent-release-2026-01",
  sourceCommit,
  version: "0.8.0",
};
const capabilities = {
  manifestVersion: "mission-agent-capabilities/1",
  version: "0.8.0",
  artifactSha256,
  sourceCommit,
  sourceTemplateSha256,
  providerRuntimeRequirements: providerRequirements,
  providerRuntimeRequirementsSha256: createHash("sha256").update(canonicalJson(providerRequirements)).digest("hex"),
  providerRuntimeProfiles: providerProfiles,
  providerRuntimeProfilesSha256: createHash("sha256").update(canonicalJson(providerProfiles)).digest("hex"),
  runtimeModeDefinition,
  runtimeModeDefinitionFileSha256: createHash("sha256").update(runtimeModeDefinitionBytes).digest("hex"),
  runtimeModeDefinitionCanonicalSha256: createHash("sha256").update(canonicalJson(runtimeModeDefinition)).digest("hex"),
  disposableAcceptanceRegistrySchema: disposableRegistrySchema.$id,
  disposableAcceptanceRegistrySchemaSha256: createHash("sha256")
    .update(canonicalJson(disposableRegistrySchema))
    .digest("hex"),
  repositorySnapshotSchema: repositorySnapshotSchema.$id,
  repositorySnapshotSchemaSha256: createHash("sha256").update(canonicalJson(repositorySnapshotSchema)).digest("hex"),
  repositoryAuthoritySchema: repositoryAuthoritySchema.$id,
  repositoryAuthoritySchemaSha256: createHash("sha256").update(canonicalJson(repositoryAuthoritySchema)).digest("hex"),
  acceptanceSourceManifest: acceptanceSourceManifest.schemaVersion,
  acceptanceSourceManifestSha256: createHash("sha256")
    .update(canonicalJsonLocale(acceptanceSourceManifest))
    .digest("hex"),
  acceptanceSourceManifestSchema: acceptanceSourceManifestSchema.$id,
  acceptanceSourceManifestSchemaSha256: createHash("sha256")
    .update(canonicalJson(acceptanceSourceManifestSchema))
    .digest("hex"),
  acceptanceContract: acceptanceContract.schema_version,
  acceptanceContractFileSha256: createHash("sha256").update(acceptanceContractBytes).digest("hex"),
  acceptanceContractCanonicalSha256: createHash("sha256").update(canonicalJson(acceptanceContract)).digest("hex"),
  acceptanceContractSchema: acceptanceContractSchema.$id,
  acceptanceContractSchemaSha256: createHash("sha256").update(acceptanceContractSchemaBytes).digest("hex"),
  acceptanceExecutableRegistryFileSha256: createHash("sha256").update(acceptanceExecutableRegistryBytes).digest("hex"),
  acceptanceExecutableRegistryCanonicalSha256: createHash("sha256")
    .update(canonicalJson({ registry_version: acceptanceContract.registry_version, steps: acceptanceContract.steps }))
    .digest("hex"),
  repositoryAuthority: {
    profile: "disposable_local_implementation/1",
    repositoryReadAllowed: true,
    isolatedWorktreeWriteAllowed: true,
    missionAgentLocalCommitAllowed: true,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    binding: "authenticated_owner_command_event_and_immutable_receipt",
    revalidation: [
      "mission_creation",
      "planner_dispatch_claim_renewal",
      "human_approval",
      "child_creation",
      "executor_dispatch_claim_renewal",
      "before_mutation",
      "before_local_commit",
      "terminal_success",
    ],
  },
  providers: ["claude_code", "codex"],
  modelDiscovery: {
    providerEnumeration: "used_when_reliable",
    operatorAllowlistFallback: true,
    allowlistMustBeExplicitValidatedVersionedAndAttested: true,
  },
  roleSpecificModelSelection: ["planner_a", "planner_b", "synthesizer", "executor"],
  reservedUnsupportedRoles: ["implementation_reviewer"],
  invocationBinding: {
    exactProviderModelArgument: true,
    silentFallbackRejectedWhenDetected: true,
    runtimeModelIdentity: "unverifiable",
    limitation:
      "Installed Codex and Claude Code CLIs do not provide an independently verifiable actual-model identity for every invocation.",
  },
  permissions: {
    planning: {
      repository: "read_only",
      tools: [],
      writes: "execution_specific_provider_sandbox_only",
    },
    implementation: {
      repository: "isolated_worktree_write_and_local_commit",
      codexTools: ["provider_internal_editing_without_shell_tool"],
      claudeCodeTools: ["Read", "Edit", "Write", "Grep", "Glob"],
      validation: "owner_governed_repository_local_commands_only",
    },
    prohibited: [
      "git.push",
      "pull_request.create",
      "repository.merge",
      "deployment.execute",
      "transaction.sign",
      "transaction.submit",
      "unrestricted_shell",
      "unrelated_home_or_credential_access",
    ],
  },
  isolation: {
    host: "macos",
    mechanism: "sandbox-exec",
    providerSpecificCredentialReadOnlyAccess: true,
    unrelatedRepositoryAccess: "not_guaranteed_for_os_readable_paths_outside_denied_roots",
    repositoryReadScope: "registered_repository_plus_broad_non_home_runtime_reads",
    failsClosedWhenUnavailable: true,
  },
  disposableAcceptance: {
    runtimeMode: "disposable_acceptance",
    productionTrustRejected: true,
    exactRegistryChecksumRequired: true,
    registryPathAndHashBoundToReadinessEligibilityEventsAndReceipts: true,
    productionResourcesRejectedAtStartup: true,
    repositorySnapshotSchema: "complete_repository_state/3",
    authenticatedRepositoryRegistrationRequired: true,
  },
  evidence: {
    requiredImplementationArtifacts: ["implementation_plan", "git_patch", "validation_results", "change_summary"],
    durableAuthenticatedValidationReceipt: true,
    everyProviderAttemptDiagnostic: true,
    runtimeModelIdentityIndependentlyVerifiable: false,
  },
  leaseAuthority: {
    bearerTokenStorage: "ephemeral_memory_only",
    durableReceiptSchema: "lease-authorization-receipt/1",
    durableFields: ["kind", "leaseId", "tokenFingerprint", "issuedAt", "expiresAt", "fencingToken", "binding"],
    restartBehavior: "fresh_fenced_lease_required",
  },
};
const prettierOptions = { parser: "json", printWidth: 120 };
const capabilityBytes = Buffer.from(await format(JSON.stringify(capabilities), prettierOptions), "utf8");
const capabilityManifestPath = `${targetPath}.capabilities.json`;

await writeFile(targetPath, artifactBytes, { mode: 0o755 });
await chmod(targetPath, 0o755);
await writeFile(`${targetPath}.artifact.json`, await format(JSON.stringify(metadata), prettierOptions), {
  mode: 0o644,
});
await writeFile(capabilityManifestPath, capabilityBytes, { mode: 0o644 });
console.log(
  JSON.stringify({
    artifact: targetPath,
    capabilityManifest: capabilityManifestPath,
    capabilityManifestSha256: createHash("sha256").update(capabilityBytes).digest("hex"),
    sourceTemplateSha256,
    ...metadata,
  }),
);
