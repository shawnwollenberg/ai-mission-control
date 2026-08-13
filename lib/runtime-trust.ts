import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { canonicalJson } from "./canonical-json";

export type MissionControlRuntimeMode = "local" | "test" | "production" | "disposable_acceptance";
export type DisposableModelAssignment = { provider: "codex" | "claude_code"; model: string };
export type DisposableAcceptanceArtifact = {
  sha256: string;
  manifestVersion: "3";
  identityProtocolVersion: "2";
  releaseAuthorityVersion: "v2";
  signingKeyId: string;
  publicKeyFingerprint: string;
  artifactMetadataSha256: string;
  capabilityManifestSha256: string;
  sourceCommit: string;
  sourceTemplateSha256: string;
  buildScriptSha256: string;
  providerRequirementsFileSha256: string;
  providerRequirementsCanonicalSha256: string;
  providerProfilesFileSha256: string;
  providerProfilesCanonicalSha256: string;
  discoveryHarnessSha256: string;
  realAcceptanceHarnessSha256: string;
  artifactFixtureSha256: string;
  migrationSha256: string;
  rollbackSha256: string;
  repositoryAuthorityMigrationSha256: string;
  repositoryAuthorityRollbackSha256: string;
  runtimeModeDefinitionFileSha256: string;
  disposableRegistrySchemaSha256: string;
  repositorySnapshotSchemaSha256: string;
  repositoryAuthoritySchemaSha256: string;
  acceptanceSourceManifestSha256: string;
  acceptanceSourceManifestCanonicalSha256: string;
  acceptanceSourceManifestSchemaSha256: string;
  acceptanceContractFileSha256: string;
  acceptanceContractCanonicalSha256: string;
  acceptanceContractSchemaSha256: string;
  acceptanceExecutableRegistryFileSha256: string;
  acceptanceExecutableRegistryCanonicalSha256: string;
  modelAllowlist: {
    planner_a: DisposableModelAssignment;
    planner_b: DisposableModelAssignment;
    synthesizer: DisposableModelAssignment;
    executor: DisposableModelAssignment;
  };
  runtimeBindings: Record<string, string>;
};
export type DisposableAcceptanceRegistry = {
  registryVersion: "mission-agent-disposable-acceptance/2";
  runtimeMode: "disposable_acceptance";
  authority: "operator_disposable_exact_checksum";
  scope: "consensus_real_provider_acceptance";
  disposable: true;
  productionAuthorityAccepted: false;
  issuedAt: string;
  expiresAt: string;
  artifacts: Record<string, DisposableAcceptanceArtifact>;
};
export type RuntimeTrustEvidence = {
  schemaVersion: "mission-control-runtime-trust/1";
  runtimeMode: MissionControlRuntimeMode;
  disposable: boolean;
  trustAuthority:
    | "production_signed_registry"
    | "disposable_exact_checksum_registry"
    | "non_authenticated_candidate_validation"
    | "non_release_runtime";
  registryPath: string | null;
  registryPathHash: string | null;
  registryContentHash: string | null;
  registryVersion: string | null;
  registryScope: string | null;
  registryExpiresAt: string | null;
  databaseIdentity: string | null;
  productionResourcesAllowed: boolean;
};

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const MODEL = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const DISPOSABLE_ENVIRONMENT_NAMES = [
  "CONSENSUS_DISPOSABLE_ACCEPTANCE",
  "CONSENSUS_ACCEPTANCE_ROOT",
  "CONSENSUS_ACCEPTANCE_URL",
  "CONSENSUS_ACCEPTANCE_ARTIFACT",
  "CONSENSUS_ACCEPTANCE_EVIDENCE",
  "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY",
  "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256",
  "MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION",
  "MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION_SHA256",
  "CONSENSUS_PROVIDER_RUNTIME_MODE",
  "DISPOSABLE_ACCEPTANCE_DATABASE_NAME",
  "DISPOSABLE_ACCEPTANCE_ROOT",
  "DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS",
  "DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS",
] as const;
const LEGACY_DISPOSABLE_AUTHORITY_NAMES = [
  "CONSENSUS_ACCEPTANCE_ARTIFACT_SHA256",
  "CONSENSUS_ACCEPTANCE_ARTIFACT_METADATA_SHA256",
  "CONSENSUS_ACCEPTANCE_CAPABILITY_MANIFEST_SHA256",
  "CONSENSUS_ACCEPTANCE_SOURCE_COMMIT",
  "CONSENSUS_ACCEPTANCE_SOURCE_TEMPLATE_SHA256",
  "CONSENSUS_ACCEPTANCE_BUILD_SCRIPT_SHA256",
  "CONSENSUS_ACCEPTANCE_PROVIDER_REQUIREMENTS_FILE_SHA256",
  "CONSENSUS_ACCEPTANCE_PROVIDER_REQUIREMENTS_CANONICAL_SHA256",
  "CONSENSUS_ACCEPTANCE_PROVIDER_PROFILES_FILE_SHA256",
  "CONSENSUS_ACCEPTANCE_PROVIDER_PROFILES_CANONICAL_SHA256",
  "CONSENSUS_ACCEPTANCE_DISCOVERY_HARNESS_SHA256",
  "CONSENSUS_ACCEPTANCE_HARNESS_SHA256",
  "CONSENSUS_ACCEPTANCE_ARTIFACT_TEST_SHA256",
  "CONSENSUS_ACCEPTANCE_MIGRATION_SHA256",
  "CONSENSUS_ACCEPTANCE_ROLLBACK_SHA256",
  "CONSENSUS_ACCEPTANCE_RUNTIME_MODE_DEFINITION_SHA256",
  "CONSENSUS_ACCEPTANCE_DISPOSABLE_REGISTRY_SCHEMA_SHA256",
  "CONSENSUS_ACCEPTANCE_REPOSITORY_SNAPSHOT_SCHEMA_SHA256",
  "CONSENSUS_ACCEPTANCE_REPOSITORY_AUTHORITY_SCHEMA_SHA256",
  "CONSENSUS_ACCEPTANCE_CODEX_MODEL_ID",
  "CONSENSUS_ACCEPTANCE_CODEX_EXECUTOR_MODEL_ID",
  "CONSENSUS_ACCEPTANCE_CLAUDE_MODEL_ID",
] as const;
const PRODUCTION_ONLY_CREDENTIAL_NAMES = [
  "ALLOW_PRODUCTION_MIGRATIONS",
  "PRODUCTION_CONFIRMATION",
  "PRODUCTION_DATABASE_URL",
  "ARTIFACT_S3_ACCESS_KEY_ID",
  "ARTIFACT_S3_BUCKET",
  "ARTIFACT_S3_ENDPOINT",
  "ARTIFACT_S3_FORCE_PATH_STYLE",
  "ARTIFACT_S3_REGION",
  "ARTIFACT_S3_SECRET_ACCESS_KEY",
  "ARTIFACT_S3_USE_IAM_ROLE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HERMES_AGENT_SECRET",
  "HERMES_ENDPOINT",
  "VERCEL_TOKEN",
  "DEPLOYMENT_TOKEN",
  "PRODUCTION_MISSION_AGENT_REGISTRY",
] as const;
const packetHashFields = [
  "sha256",
  "artifactMetadataSha256",
  "capabilityManifestSha256",
  "sourceTemplateSha256",
  "buildScriptSha256",
  "providerRequirementsFileSha256",
  "providerRequirementsCanonicalSha256",
  "providerProfilesFileSha256",
  "providerProfilesCanonicalSha256",
  "discoveryHarnessSha256",
  "realAcceptanceHarnessSha256",
  "artifactFixtureSha256",
  "migrationSha256",
  "rollbackSha256",
  "repositoryAuthorityMigrationSha256",
  "repositoryAuthorityRollbackSha256",
  "runtimeModeDefinitionFileSha256",
  "disposableRegistrySchemaSha256",
  "repositorySnapshotSchemaSha256",
  "repositoryAuthoritySchemaSha256",
  "acceptanceSourceManifestSha256",
  "acceptanceSourceManifestCanonicalSha256",
  "acceptanceSourceManifestSchemaSha256",
  "acceptanceContractFileSha256",
  "acceptanceContractCanonicalSha256",
  "acceptanceContractSchemaSha256",
  "acceptanceExecutableRegistryFileSha256",
  "acceptanceExecutableRegistryCanonicalSha256",
] as const;
export const disposableRuntimeBindingIds = [
  "claude-implementation-macos-v2",
  "claude-planning-macos-v2",
  "codex-implementation-macos-v2",
  "codex-planning-macos-v2",
] as const;

type NonAuthenticatedCandidateValidation = {
  schemaVersion: "mission-agent-non-authenticated-candidate-validation/1";
  runtimeMode: "mock_provider_acceptance";
  authority: "non_authenticated_candidate_validation";
  scope: "non_authenticated_candidate_validation";
  disposable: true;
  productionAuthority: false;
  authenticatedProviderExecution: false;
  issuedAt: string;
  expiresAt: string;
  acceptanceContractCanonicalSha256: string;
  acceptanceExecutableRegistryCanonicalSha256: string;
  validatorRegistryCanonicalSha256: string;
  providerRequirementsCanonicalSha256: string;
  providerProfilesCanonicalSha256: string;
  mockRuntimeSha256: string;
  acceptanceSourceManifestSha256: string;
  artifact: DisposableAcceptanceArtifact;
};

function sha256(value: string | Buffer) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : Uint8Array.from(value))
    .digest("hex");
}
function configured(name: string) {
  return typeof process.env[name] === "string" && process.env[name]!.length > 0;
}
export function missionControlRuntimeMode(): MissionControlRuntimeMode {
  const value = process.env.APP_ENV ?? "local";
  if (!(["local", "test", "production", "disposable_acceptance"] as const).includes(value as never))
    throw new Error("APP_ENV must be local, test, production, or disposable_acceptance");
  return value as MissionControlRuntimeMode;
}
function validateAssignment(value: unknown): value is DisposableModelAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 2 &&
    ["codex", "claude_code"].includes(String(row.provider)) &&
    MODEL.test(String(row.model ?? ""))
  );
}
function validateArtifact(value: unknown): value is DisposableAcceptanceArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const expectedFields = [
    ...packetHashFields,
    "manifestVersion",
    "identityProtocolVersion",
    "releaseAuthorityVersion",
    "signingKeyId",
    "publicKeyFingerprint",
    "sourceCommit",
    "modelAllowlist",
    "runtimeBindings",
  ].sort();
  if (
    Object.keys(row).sort().join(",") !== expectedFields.join(",") ||
    packetHashFields.some((field) => !SHA256.test(String(row[field] ?? ""))) ||
    !SOURCE_COMMIT.test(String(row.sourceCommit ?? "")) ||
    row.manifestVersion !== "3" ||
    row.identityProtocolVersion !== "2" ||
    row.releaseAuthorityVersion !== "v2" ||
    typeof row.signingKeyId !== "string" ||
    !row.signingKeyId ||
    typeof row.publicKeyFingerprint !== "string" ||
    !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(row.publicKeyFingerprint)
  )
    return false;
  const allowlist = row.modelAllowlist as Record<string, unknown> | undefined;
  if (
    !allowlist ||
    Object.keys(allowlist).sort().join(",") !== "executor,planner_a,planner_b,synthesizer" ||
    Object.values(allowlist).some((assignment) => !validateAssignment(assignment))
  )
    return false;
  const runtimeBindings = row.runtimeBindings;
  return (
    !!runtimeBindings &&
    typeof runtimeBindings === "object" &&
    !Array.isArray(runtimeBindings) &&
    Object.keys(runtimeBindings).sort().join(",") === [...disposableRuntimeBindingIds].sort().join(",") &&
    Object.values(runtimeBindings).every((hash) => SHA256.test(String(hash)))
  );
}
function parseRegistry(bytes: Buffer): DisposableAcceptanceRegistry {
  let registry: DisposableAcceptanceRegistry;
  try {
    registry = JSON.parse(bytes.toString("utf8")) as DisposableAcceptanceRegistry;
  } catch {
    throw new Error("Disposable acceptance registry is not valid JSON");
  }
  const issuedAt = Date.parse(registry.issuedAt);
  const expiresAt = Date.parse(registry.expiresAt);
  const expectedRegistryFields = [
    "registryVersion",
    "runtimeMode",
    "authority",
    "scope",
    "disposable",
    "productionAuthorityAccepted",
    "issuedAt",
    "expiresAt",
    "artifacts",
  ].sort();
  if (
    Object.keys(registry).sort().join(",") !== expectedRegistryFields.join(",") ||
    registry.registryVersion !== "mission-agent-disposable-acceptance/2" ||
    registry.runtimeMode !== "disposable_acceptance" ||
    registry.authority !== "operator_disposable_exact_checksum" ||
    registry.scope !== "consensus_real_provider_acceptance" ||
    registry.disposable !== true ||
    registry.productionAuthorityAccepted !== false ||
    !Number.isFinite(issuedAt) ||
    issuedAt > Date.now() + 60_000 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 24 * 60 * 60 * 1000 ||
    expiresAt <= issuedAt ||
    !registry.artifacts ||
    typeof registry.artifacts !== "object" ||
    Array.isArray(registry.artifacts) ||
    Object.keys(registry.artifacts).length === 0 ||
    Object.values(registry.artifacts).some((artifact) => !validateArtifact(artifact))
  )
    throw new Error("Disposable acceptance registry authority, scope, expiry, or packet entries are invalid");
  return registry;
}
function isWithin(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function validateProviderWritableRootBindings(acceptanceRoot: string) {
  let roots: unknown;
  let bindings: unknown;
  try {
    roots = JSON.parse(process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS ?? "");
    bindings = JSON.parse(process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS ?? "");
  } catch {
    throw new Error("Provider-writable roots and bindings must be explicit JSON arrays");
  }
  if (!Array.isArray(roots) || !Array.isArray(bindings) || roots.length !== bindings.length)
    throw new Error("Provider-writable root bindings are incomplete");
  const byPath = new Map(
    bindings.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("Provider-writable root binding is invalid");
      const binding = row as Record<string, unknown>;
      if (
        typeof binding.resourceId !== "string" ||
        typeof binding.acceptanceRunId !== "string" ||
        typeof binding.rootPurpose !== "string" ||
        typeof binding.canonicalPath !== "string" ||
        !SHA256.test(String(binding.filesystemAuthorityIdentity ?? ""))
      )
        throw new Error("Provider-writable root binding is invalid");
      return [binding.canonicalPath, binding] as const;
    }),
  );
  for (const lexicalRoot of roots) {
    if (typeof lexicalRoot !== "string" || !isAbsolute(lexicalRoot))
      throw new Error("Provider-writable root is invalid");
    const info = lstatSync(lexicalRoot);
    const canonicalPath = realpathSync(lexicalRoot);
    const binding = byPath.get(canonicalPath);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (info.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      !isWithin(acceptanceRoot, canonicalPath) ||
      !binding ||
      binding.intendedPath !== lexicalRoot ||
      binding.filesystemAuthorityIdentity !==
        sha256(
          canonicalJson({
            acceptanceRunId: binding.acceptanceRunId,
            resourceId: binding.resourceId,
            canonicalPath,
            purpose: binding.rootPurpose,
          }),
        )
    )
      throw new Error("provider-writable root changed after governed bootstrap");
  }
}
export function loadDisposableAcceptanceRegistry() {
  if (missionControlRuntimeMode() !== "disposable_acceptance")
    throw new Error("Disposable acceptance registry is unavailable outside disposable_acceptance mode");
  if (process.env.CONSENSUS_DISPOSABLE_ACCEPTANCE !== "true")
    throw new Error("Disposable acceptance requires explicit operator selection");
  const lexicalPath = process.env.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY;
  const expectedHash = process.env.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256;
  if (!lexicalPath || !isAbsolute(lexicalPath) || !SHA256.test(expectedHash ?? ""))
    throw new Error("Disposable acceptance requires an absolute registry path and exact content hash");
  const info = lstatSync(lexicalPath);
  const parentInfo = lstatSync(dirname(lexicalPath));
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0)
    throw new Error("Disposable acceptance registry must be a non-writable regular file");
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o222) !== 0)
    throw new Error("Disposable acceptance registry directory must be non-writable");
  const registryPath = realpathSync(lexicalPath);
  const bytes = readFileSync(registryPath);
  const registryContentHash = sha256(bytes);
  if (registryContentHash !== expectedHash) throw new Error("Disposable acceptance registry content hash changed");
  let writableRoots: unknown;
  try {
    writableRoots = JSON.parse(process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS ?? "");
  } catch {
    throw new Error("Provider-writable roots must be an explicit JSON array");
  }
  if (!Array.isArray(writableRoots) || writableRoots.some((root) => typeof root !== "string" || !isAbsolute(root)))
    throw new Error("Provider-writable roots must be an explicit JSON array of absolute paths");
  const resolvedWritableRoots = writableRoots.map((root) => realpathSync(String(root)));
  if (resolvedWritableRoots.some((root) => isWithin(root, registryPath)))
    throw new Error("Disposable acceptance registry is inside a provider-writable root");
  return { registry: parseRegistry(bytes), registryPath, registryContentHash };
}
function loadNonAuthenticatedCandidateValidation() {
  if (missionControlRuntimeMode() !== "disposable_acceptance")
    throw new Error("Non-authenticated candidate validation is unavailable outside disposable acceptance");
  if (process.env.CONSENSUS_PROVIDER_RUNTIME_MODE !== "mock_provider_acceptance")
    throw new Error("Mock provider acceptance requires explicit runtime selection");
  const lexicalPath = process.env.MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION;
  const expectedHash = process.env.MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION_SHA256;
  if (!lexicalPath || !isAbsolute(lexicalPath) || !SHA256.test(expectedHash ?? ""))
    throw new Error("Mock provider acceptance requires an absolute authorization path and exact hash");
  const info = lstatSync(lexicalPath);
  const parentInfo = lstatSync(dirname(lexicalPath));
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0)
    throw new Error("Candidate validation authorization must be a non-writable regular file");
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o222) !== 0)
    throw new Error("Candidate validation authorization directory must be non-writable");
  const authorizationPath = realpathSync(lexicalPath);
  const bytes = readFileSync(authorizationPath);
  const authorizationContentHash = sha256(bytes);
  if (authorizationContentHash !== expectedHash) throw new Error("Candidate validation authorization changed");
  let writableRoots: unknown;
  try {
    writableRoots = JSON.parse(process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS ?? "");
  } catch {
    throw new Error("Provider-writable roots must be an explicit JSON array");
  }
  if (
    !Array.isArray(writableRoots) ||
    writableRoots.some((root) => typeof root !== "string" || !isAbsolute(root)) ||
    writableRoots.map((root) => String(root)).some((root) => isWithin(root, authorizationPath))
  )
    throw new Error("Candidate validation authorization must be outside every provider-writable root");
  const authorization = JSON.parse(bytes.toString("utf8")) as NonAuthenticatedCandidateValidation;
  const expectedFields = [
    "schemaVersion",
    "runtimeMode",
    "authority",
    "scope",
    "disposable",
    "productionAuthority",
    "authenticatedProviderExecution",
    "issuedAt",
    "expiresAt",
    "acceptanceContractCanonicalSha256",
    "acceptanceExecutableRegistryCanonicalSha256",
    "validatorRegistryCanonicalSha256",
    "providerRequirementsCanonicalSha256",
    "providerProfilesCanonicalSha256",
    "mockRuntimeSha256",
    "acceptanceSourceManifestSha256",
    "artifact",
  ].sort();
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (
    Object.keys(authorization).sort().join(",") !== expectedFields.join(",") ||
    authorization.schemaVersion !== "mission-agent-non-authenticated-candidate-validation/1" ||
    authorization.runtimeMode !== "mock_provider_acceptance" ||
    authorization.authority !== "non_authenticated_candidate_validation" ||
    authorization.scope !== "non_authenticated_candidate_validation" ||
    authorization.disposable !== true ||
    authorization.productionAuthority !== false ||
    authorization.authenticatedProviderExecution !== false ||
    !Number.isFinite(issuedAt) ||
    issuedAt > Date.now() + 60_000 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 6 * 60 * 60 * 1000 ||
    expiresAt <= issuedAt ||
    !validateArtifact(authorization.artifact) ||
    [
      authorization.acceptanceContractCanonicalSha256,
      authorization.acceptanceExecutableRegistryCanonicalSha256,
      authorization.validatorRegistryCanonicalSha256,
      authorization.providerRequirementsCanonicalSha256,
      authorization.providerProfilesCanonicalSha256,
      authorization.mockRuntimeSha256,
      authorization.acceptanceSourceManifestSha256,
    ].some((value) => !SHA256.test(value)) ||
    authorization.acceptanceContractCanonicalSha256 !== authorization.artifact.acceptanceContractCanonicalSha256 ||
    authorization.acceptanceExecutableRegistryCanonicalSha256 !==
      authorization.artifact.acceptanceExecutableRegistryCanonicalSha256 ||
    authorization.providerRequirementsCanonicalSha256 !== authorization.artifact.providerRequirementsCanonicalSha256 ||
    authorization.providerProfilesCanonicalSha256 !== authorization.artifact.providerProfilesCanonicalSha256 ||
    authorization.acceptanceSourceManifestSha256 !== authorization.artifact.acceptanceSourceManifestCanonicalSha256
  )
    throw new Error("Non-authenticated candidate validation authority or bindings are invalid");
  const artifactPath = process.env.CONSENSUS_ACCEPTANCE_ARTIFACT;
  const mockRuntimePath = process.env.MISSION_AGENT_MOCK_RUNTIME_PATH;
  if (
    !artifactPath ||
    !mockRuntimePath ||
    sha256(readFileSync(realpathSync(artifactPath))) !== authorization.artifact.sha256 ||
    sha256(readFileSync(realpathSync(mockRuntimePath))) !== authorization.mockRuntimeSha256
  )
    throw new Error("Candidate validation artifact or mock runtime bytes changed");
  return { authorization, authorizationPath, authorizationContentHash };
}
function disposableDatabaseIdentity() {
  const expectedName = process.env.DISPOSABLE_ACCEPTANCE_DATABASE_NAME;
  if (!expectedName || !/^mc_disposable_acceptance_[a-z0-9_]{1,80}$/.test(expectedName))
    throw new Error("Disposable acceptance database name is not explicitly governed");
  let database: URL;
  try {
    database = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new Error("Disposable acceptance database URL is invalid");
  }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  if (
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(database.hostname) ||
    databaseName !== expectedName ||
    database.searchParams.get("sslmode") === "require"
  )
    throw new Error("Disposable acceptance database must be the exact loopback disposable target");
  return sha256(`${database.hostname}:${database.port || "5432"}/${databaseName}`);
}
export function runtimeTrustEvidence(): RuntimeTrustEvidence {
  const runtimeMode = missionControlRuntimeMode();
  if (runtimeMode === "disposable_acceptance") {
    if (process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance") {
      const { authorization, authorizationPath, authorizationContentHash } = loadNonAuthenticatedCandidateValidation();
      return {
        schemaVersion: "mission-control-runtime-trust/1",
        runtimeMode,
        disposable: true,
        trustAuthority: "non_authenticated_candidate_validation",
        registryPath: authorizationPath,
        registryPathHash: sha256(authorizationPath),
        registryContentHash: authorizationContentHash,
        registryVersion: authorization.schemaVersion,
        registryScope: authorization.scope,
        registryExpiresAt: authorization.expiresAt,
        databaseIdentity: disposableDatabaseIdentity(),
        productionResourcesAllowed: false,
      };
    }
    const { registry, registryPath, registryContentHash } = loadDisposableAcceptanceRegistry();
    return {
      schemaVersion: "mission-control-runtime-trust/1",
      runtimeMode,
      disposable: true,
      trustAuthority: "disposable_exact_checksum_registry",
      registryPath,
      registryPathHash: sha256(registryPath),
      registryContentHash,
      registryVersion: registry.registryVersion,
      registryScope: registry.scope,
      registryExpiresAt: registry.expiresAt,
      databaseIdentity: disposableDatabaseIdentity(),
      productionResourcesAllowed: false,
    };
  }
  return {
    schemaVersion: "mission-control-runtime-trust/1",
    runtimeMode,
    disposable: false,
    trustAuthority: runtimeMode === "production" ? "production_signed_registry" : "non_release_runtime",
    registryPath: null,
    registryPathHash: null,
    registryContentHash: null,
    registryVersion: null,
    registryScope: null,
    registryExpiresAt: null,
    databaseIdentity: null,
    productionResourcesAllowed: runtimeMode === "production",
  };
}
export function runtimeTrustReceiptBinding() {
  const evidence = runtimeTrustEvidence();
  return {
    schemaVersion: evidence.schemaVersion,
    runtimeMode: evidence.runtimeMode,
    disposable: evidence.disposable,
    trustAuthority: evidence.trustAuthority,
    registryPath: evidence.registryPath,
    registryPathHash: evidence.registryPathHash,
    registryContentHash: evidence.registryContentHash,
    registryVersion: evidence.registryVersion,
    registryScope: evidence.registryScope,
  };
}
export function assertRuntimeStartupSafety() {
  const runtimeMode = missionControlRuntimeMode();
  if (runtimeMode === "production") {
    const configuredDisposable = [...DISPOSABLE_ENVIRONMENT_NAMES, ...LEGACY_DISPOSABLE_AUTHORITY_NAMES].filter(
      configured,
    );
    if (configuredDisposable.length)
      throw new Error(
        `Production mode rejects disposable acceptance configuration: ${configuredDisposable.join(", ")}`,
      );
    return runtimeTrustEvidence();
  }
  if (runtimeMode !== "disposable_acceptance") return runtimeTrustEvidence();
  const forbidden = PRODUCTION_ONLY_CREDENTIAL_NAMES.filter(configured);
  if (forbidden.length)
    throw new Error(`Disposable acceptance rejects production credentials or authority: ${forbidden.join(", ")}`);
  const legacyAuthority = LEGACY_DISPOSABLE_AUTHORITY_NAMES.filter(configured);
  if (legacyAuthority.length)
    throw new Error(
      `Disposable acceptance rejects legacy environment approval inputs; the registry is sole authority: ${legacyAuthority.join(", ")}`,
    );
  if (process.env.ARTIFACT_STORAGE_PROVIDER !== "local")
    throw new Error("Disposable acceptance requires local artifact storage");
  const origin = new URL(process.env.PUBLIC_APP_URL ?? "invalid:");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname) || origin.protocol !== "http:")
    throw new Error("Disposable acceptance public origin must be explicit loopback HTTP");
  for (const name of [
    "CONSENSUS_ACCEPTANCE_URL",
    "MISSION_CONTROL_HEALTH_URL",
    "MISSION_CONTROL_PROTOCOL_URL",
    "MISSION_CONTROL_PUBLIC_URL",
  ]) {
    if (!configured(name)) continue;
    const endpoint = new URL(process.env[name]!);
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname) || endpoint.protocol !== "http:")
      throw new Error(`Disposable acceptance endpoint ${name} must be loopback HTTP`);
  }
  const acceptanceRoot = process.env.DISPOSABLE_ACCEPTANCE_ROOT;
  const artifactRoot = process.env.ARTIFACT_STORAGE_ROOT;
  if (!acceptanceRoot || !artifactRoot || !isAbsolute(acceptanceRoot) || !isAbsolute(artifactRoot))
    throw new Error("Disposable acceptance and artifact roots must be explicit absolute paths");
  if (!isWithin(realpathSync(acceptanceRoot), realpathSync(artifactRoot)))
    throw new Error("Disposable artifact storage must remain inside the acceptance root");
  validateProviderWritableRootBindings(realpathSync(acceptanceRoot));
  return runtimeTrustEvidence();
}
export function assertDisposableAcceptanceHarnessSafety() {
  const evidence = assertRuntimeStartupSafety();
  if (evidence.runtimeMode !== "disposable_acceptance" || !evidence.disposable || evidence.productionResourcesAllowed)
    throw new Error("Acceptance harness requires fail-closed disposable runtime trust");
  const harnessRoot = process.env.CONSENSUS_ACCEPTANCE_ROOT;
  const disposableRoot = process.env.DISPOSABLE_ACCEPTANCE_ROOT;
  if (!harnessRoot || !disposableRoot || !isAbsolute(harnessRoot) || !isAbsolute(disposableRoot))
    throw new Error("Acceptance harness and disposable roots must be explicit absolute paths");
  const resolvedHarnessRoot = realpathSync(harnessRoot);
  const resolvedDisposableRoot = realpathSync(disposableRoot);
  if (resolvedHarnessRoot !== resolvedDisposableRoot)
    throw new Error("Acceptance harness root must equal the governed disposable acceptance root");
  return { evidence, acceptanceRoot: resolvedHarnessRoot };
}
export function disposableArtifactApproval(version: string) {
  if (process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance") {
    if (version !== "0.8.0") throw new Error(`Candidate validation does not authorize Mission Agent ${version}`);
    const { authorization, authorizationPath, authorizationContentHash } = loadNonAuthenticatedCandidateValidation();
    return {
      artifact: authorization.artifact,
      registry: authorization,
      evidence: {
        ...runtimeTrustReceiptBinding(),
        registryPath: authorizationPath,
        registryContentHash: authorizationContentHash,
      },
    };
  }
  const { registry, registryPath, registryContentHash } = loadDisposableAcceptanceRegistry();
  if (Object.keys(registry.artifacts).length !== 1)
    throw new Error("Disposable acceptance requires exactly one approved artifact entry");
  const artifact = registry.artifacts[version];
  if (!artifact) throw new Error(`Disposable acceptance registry does not approve Mission Agent ${version}`);
  return {
    artifact,
    registry,
    evidence: {
      ...runtimeTrustReceiptBinding(),
      registryPath,
      registryContentHash,
    },
  };
}
export function disposableApprovedAssignment(
  role: "planner_a" | "planner_b" | "synthesizer" | "executor",
): DisposableModelAssignment | undefined {
  if (missionControlRuntimeMode() !== "disposable_acceptance") return undefined;
  if (process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance")
    return loadNonAuthenticatedCandidateValidation().authorization.artifact.modelAllowlist[role];
  const { registry } = loadDisposableAcceptanceRegistry();
  const entries = Object.values(registry.artifacts);
  if (entries.length !== 1) throw new Error("Disposable acceptance requires exactly one approved artifact entry");
  return entries[0].modelAllowlist[role];
}
