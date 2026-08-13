import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalHash } from "../lib/canonical-json.ts";
import { providerRuntimeProfileBinding } from "../domain/provider-runtime-profiles.ts";
import { runtimeModeDefinitionIdentities } from "../lib/acceptance-packet-identities.ts";
import {
  acceptanceExecutableRegistryIdentity,
  acceptanceValidatorRegistryIdentity,
} from "./consensus-real-acceptance-steps.ts";

const artifactPath = resolve(process.argv[2] ?? "");
const outputPath = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3])
  throw new Error("Usage: generate-non-authenticated-candidate-validation <artifact> <output>");
const bytes = (path) => readFile(resolve(path));
const sha = async (path) =>
  createHash("sha256")
    .update(await bytes(path))
    .digest("hex");
const json = async (path) => JSON.parse((await bytes(path)).toString("utf8"));
const canonicalSha = async (path) => canonicalHash(await json(path));

const metadataPath = `${artifactPath}.artifact.json`;
const capabilityPath = `${artifactPath}.capabilities.json`;
const metadata = await json(metadataPath);
const capability = await json(capabilityPath);
const contract = await json("domain/consensus-real-provider-acceptance-contract.json");
const sourceManifest = await json("domain/mission-control-acceptance-source-manifest.json");
const runtimeModeIdentities = await runtimeModeDefinitionIdentities();
const artifact = {
  sha256: await sha(artifactPath),
  manifestVersion: "3",
  identityProtocolVersion: "2",
  releaseAuthorityVersion: metadata.releaseAuthorityVersion,
  signingKeyId: metadata.signingKeyId,
  publicKeyFingerprint: metadata.publicKeyFingerprint,
  artifactMetadataSha256: await sha(metadataPath),
  capabilityManifestSha256: await sha(capabilityPath),
  sourceCommit: metadata.sourceCommit,
  sourceTemplateSha256: await sha("scripts/mission-agent-080.template.mjs"),
  buildScriptSha256: await sha("scripts/build-mission-agent-080.mjs"),
  providerRequirementsFileSha256: await sha("domain/provider-runtime-requirements.json"),
  providerRequirementsCanonicalSha256: await canonicalSha("domain/provider-runtime-requirements.json"),
  providerProfilesFileSha256: await sha("domain/provider-runtime-profiles.proposed.json"),
  providerProfilesCanonicalSha256: await canonicalSha("domain/provider-runtime-profiles.proposed.json"),
  discoveryHarnessSha256: await sha("scripts/discover-provider-runtime-profiles.mjs"),
  realAcceptanceHarnessSha256: await sha("scripts/run-consensus-real-acceptance.ts"),
  artifactFixtureSha256: await sha("tests/mission-agent-0.8.test.mjs"),
  migrationSha256: await sha("db/migrations/0029_consensus_plan.sql"),
  rollbackSha256: await sha("db/rollbacks/0029_consensus_plan.sql"),
  repositoryAuthorityMigrationSha256: await sha("db/migrations/0030_repository_authority.sql"),
  repositoryAuthorityRollbackSha256: await sha("db/rollbacks/0030_repository_authority.sql"),
  runtimeModeDefinitionFileSha256: runtimeModeIdentities.rawFileSha256,
  disposableRegistrySchemaSha256: await sha("domain/disposable-acceptance-registry.schema.json"),
  repositorySnapshotSchemaSha256: await sha("domain/repository-snapshot.schema.json"),
  repositoryAuthoritySchemaSha256: await sha("domain/repository-authority.schema.json"),
  acceptanceSourceManifestSha256: await sha("domain/mission-control-acceptance-source-manifest.json"),
  acceptanceSourceManifestCanonicalSha256: canonicalHash(sourceManifest),
  acceptanceSourceManifestSchemaSha256: await sha("domain/mission-control-acceptance-source-manifest.schema.json"),
  acceptanceContractFileSha256: await sha("domain/consensus-real-provider-acceptance-contract.json"),
  acceptanceContractCanonicalSha256: canonicalHash(contract),
  acceptanceContractSchemaSha256: await sha("domain/consensus-real-provider-acceptance-contract.schema.json"),
  acceptanceExecutableRegistryFileSha256: await sha("scripts/consensus-real-acceptance-steps.ts"),
  acceptanceExecutableRegistryCanonicalSha256: acceptanceExecutableRegistryIdentity(contract),
  modelAllowlist: {
    planner_a: { provider: "claude_code", model: "claude-fable-5" },
    planner_b: { provider: "codex", model: "gpt-5.6-sol" },
    synthesizer: { provider: "claude_code", model: "claude-fable-5" },
    executor: { provider: "codex", model: "gpt-5.6-luna" },
  },
  runtimeBindings: Object.fromEntries(
    [
      "claude-implementation-macos-v2",
      "claude-planning-macos-v2",
      "codex-implementation-macos-v2",
      "codex-planning-macos-v2",
    ].map((id) => [id, providerRuntimeProfileBinding(id).runtimeBindingHash]),
  ),
};
if (artifact.sha256 !== metadata.sha256 || capability.artifactSha256 !== artifact.sha256)
  throw new Error("Candidate artifact, metadata, and capability identities differ");
const issuedAt = new Date();
const authorization = {
  schemaVersion: "mission-agent-non-authenticated-candidate-validation/1",
  runtimeMode: "mock_provider_acceptance",
  authority: "non_authenticated_candidate_validation",
  scope: "non_authenticated_candidate_validation",
  disposable: true,
  productionAuthority: false,
  authenticatedProviderExecution: false,
  issuedAt: issuedAt.toISOString(),
  expiresAt: new Date(issuedAt.getTime() + 6 * 60 * 60 * 1000 - 1_000).toISOString(),
  acceptanceContractCanonicalSha256: artifact.acceptanceContractCanonicalSha256,
  acceptanceExecutableRegistryCanonicalSha256: artifact.acceptanceExecutableRegistryCanonicalSha256,
  validatorRegistryCanonicalSha256: acceptanceValidatorRegistryIdentity(contract),
  providerRequirementsCanonicalSha256: artifact.providerRequirementsCanonicalSha256,
  providerProfilesCanonicalSha256: artifact.providerProfilesCanonicalSha256,
  mockRuntimeSha256: await sha("scripts/mock-provider-runtime.mjs"),
  acceptanceSourceManifestSha256: artifact.acceptanceSourceManifestCanonicalSha256,
  artifact,
};
await writeFile(outputPath, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o400 });
console.log(
  JSON.stringify({
    event: "non_authenticated_candidate_validation_generated",
    outputPath,
    authorizationSha256: await sha(outputPath),
    expiresAt: authorization.expiresAt,
  }),
);
