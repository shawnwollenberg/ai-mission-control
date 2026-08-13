import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertDisposableAcceptanceHarnessSafety,
  assertRuntimeStartupSafety,
  disposableApprovedAssignment,
  loadDisposableAcceptanceRegistry,
} from "../lib/runtime-trust.ts";
import { verifyMissionControlAcceptanceSource } from "../lib/disposable-acceptance-source.ts";
import { canonicalHash } from "../lib/canonical-json.ts";

const managedNames = [
  "APP_ENV",
  "CONSENSUS_DISPOSABLE_ACCEPTANCE",
  "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY",
  "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256",
  "DISPOSABLE_ACCEPTANCE_DATABASE_NAME",
  "DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS",
  "DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS",
  "DISPOSABLE_ACCEPTANCE_ROOT",
  "CONSENSUS_ACCEPTANCE_ROOT",
  "CONSENSUS_ACCEPTANCE_URL",
  "CONSENSUS_ACCEPTANCE_ARTIFACT_SHA256",
  "DATABASE_URL",
  "ARTIFACT_STORAGE_PROVIDER",
  "ARTIFACT_STORAGE_ROOT",
  "PUBLIC_APP_URL",
  "AWS_ACCESS_KEY_ID",
];

function packet() {
  const hashes = [
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
  ];
  return {
    ...Object.fromEntries(hashes.map((key, index) => [key, (index % 10).toString().repeat(64)])),
    manifestVersion: "3",
    identityProtocolVersion: "2",
    releaseAuthorityVersion: "v2",
    signingKeyId: "disposable-only",
    publicKeyFingerprint: `ed25519-spki-sha256:${"a".repeat(64)}`,
    sourceCommit: "b".repeat(40),
    modelAllowlist: {
      planner_a: { provider: "claude_code", model: "claude-fable-5" },
      planner_b: { provider: "codex", model: "gpt-5.6-sol" },
      synthesizer: { provider: "claude_code", model: "claude-fable-5" },
      executor: { provider: "codex", model: "gpt-5.6-luna" },
    },
    runtimeBindings: {
      "claude-implementation-macos-v2": "d".repeat(64),
      "claude-planning-macos-v2": "c".repeat(64),
      "codex-implementation-macos-v2": "f".repeat(64),
      "codex-planning-macos-v2": "e".repeat(64),
    },
  };
}

test("Mission Control disposable acceptance source is manifest-bound and fails closed on changed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-control-source-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "domain"));
  await mkdir(join(root, "application"));
  const sourcePath = join(root, "application", "authority.ts");
  const schemaPath = join(root, "domain", "mission-control-acceptance-source-manifest.schema.json");
  const manifestPath = join(root, "domain", "mission-control-acceptance-source-manifest.json");
  const sourceBytes = "export const authority = 'narrow';\n";
  const schemaBytes = '{"$id":"mission-control-acceptance-source-manifest/1"}\n';
  await writeFile(sourcePath, sourceBytes);
  await writeFile(schemaPath, schemaBytes);
  const manifest = {
    schemaVersion: "mission-control-acceptance-source-manifest/1",
    scope: "disposable_consensus_acceptance_security_boundary",
    sourceBase: "b".repeat(40),
    includedRoots: ["application", "domain"],
    includedFiles: [],
    excludedFiles: ["domain/mission-control-acceptance-source-manifest.json"],
    files: {
      "application/authority.ts": createHash("sha256").update(sourceBytes).digest("hex"),
      "domain/mission-control-acceptance-source-manifest.schema.json": createHash("sha256")
        .update(schemaBytes)
        .digest("hex"),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const approved = {
    ...packet(),
    acceptanceSourceManifestSha256: createHash("sha256")
      .update(await readFile(manifestPath))
      .digest("hex"),
    acceptanceSourceManifestCanonicalSha256: canonicalHash(manifest),
    acceptanceSourceManifestSchemaSha256: createHash("sha256").update(schemaBytes).digest("hex"),
  };
  const verified = verifyMissionControlAcceptanceSource(approved, root);
  assert.deepEqual(verified.files, manifest.files);
  await writeFile(sourcePath, "export const authority = 'expanded';\n");
  assert.throws(() => verifyMissionControlAcceptanceSource(approved, root), /ACCEPTANCE SOURCE CLOSURE FAILURE/);
  await writeFile(sourcePath, sourceBytes);
  const unexpectedPath = join(root, "application", "unexpected.ts");
  await writeFile(unexpectedPath, "export const unexpected = true;\n");
  assert.throws(() => verifyMissionControlAcceptanceSource(approved, root), /ACCEPTANCE SOURCE CLOSURE FAILURE/);
  await rm(unexpectedPath);
  await rm(sourcePath);
  assert.throws(() => verifyMissionControlAcceptanceSource(approved, root), /ACCEPTANCE SOURCE CLOSURE FAILURE/);
});

test("disposable startup is explicit, checksum-bound, isolated, and cannot be mistaken for production", async (t) => {
  const previous = Object.fromEntries(managedNames.map((name) => [name, process.env[name]]));
  const root = await mkdtemp(join(tmpdir(), "mission-control-disposable-trust-"));
  const registryDirectory = join(root, "authority");
  const providerRoot = join(root, "provider");
  const artifactRoot = join(root, "artifacts");
  const registryPath = join(registryDirectory, "registry.json");
  await mkdir(registryDirectory);
  await mkdir(providerRoot, { mode: 0o700 });
  await mkdir(artifactRoot);
  const testAuthorityIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        acceptanceRunId: "runtime-trust-test",
        canonicalPath: await realpath(providerRoot),
        purpose: "test",
        resourceId: "provider-writable-root-test",
      }),
    )
    .digest("hex");
  const writeRegistry = async (registry) => {
    await chmod(registryDirectory, 0o700);
    await chmod(registryPath, 0o600).catch(() => undefined);
    await writeFile(registryPath, JSON.stringify(registry), { mode: 0o400 });
    await chmod(registryPath, 0o400);
    await chmod(registryDirectory, 0o500);
    process.env.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256 = createHash("sha256")
      .update(await readFile(registryPath))
      .digest("hex");
  };
  t.after(async () => {
    for (const name of managedNames)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    await chmod(registryDirectory, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const registry = {
    registryVersion: "mission-agent-disposable-acceptance/2",
    runtimeMode: "disposable_acceptance",
    authority: "operator_disposable_exact_checksum",
    scope: "consensus_real_provider_acceptance",
    disposable: true,
    productionAuthorityAccepted: false,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    artifacts: { "0.8.0": packet() },
  };
  await writeRegistry(registry);
  Object.assign(process.env, {
    APP_ENV: "disposable_acceptance",
    CONSENSUS_DISPOSABLE_ACCEPTANCE: "true",
    MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY: registryPath,
    DISPOSABLE_ACCEPTANCE_DATABASE_NAME: "mc_disposable_acceptance_runtime_test",
    DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS: JSON.stringify([providerRoot]),
    DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS: JSON.stringify([
      {
        resourceId: "provider-writable-root-test",
        acceptanceRunId: "runtime-trust-test",
        rootPurpose: "test",
        intendedPath: providerRoot,
        canonicalPath: await realpath(providerRoot),
        filesystemAuthorityIdentity: testAuthorityIdentity,
      },
    ]),
    DISPOSABLE_ACCEPTANCE_ROOT: root,
    CONSENSUS_ACCEPTANCE_ROOT: root,
    CONSENSUS_ACCEPTANCE_URL: "http://127.0.0.1:4317",
    DATABASE_URL: "postgresql://local:test@127.0.0.1:5432/mc_disposable_acceptance_runtime_test",
    ARTIFACT_STORAGE_PROVIDER: "local",
    ARTIFACT_STORAGE_ROOT: artifactRoot,
    PUBLIC_APP_URL: "http://127.0.0.1:4317",
  });

  const trust = assertRuntimeStartupSafety();
  assert.equal(trust.runtimeMode, "disposable_acceptance");
  assert.equal(trust.productionResourcesAllowed, false);
  assert.equal(loadDisposableAcceptanceRegistry().registryPath, await realpath(registryPath));
  assert.deepEqual(disposableApprovedAssignment("executor"), { provider: "codex", model: "gpt-5.6-luna" });
  assert.equal(assertDisposableAcceptanceHarnessSafety().acceptanceRoot, await realpath(root));

  process.env.CONSENSUS_ACCEPTANCE_ROOT = providerRoot;
  assert.throws(() => assertDisposableAcceptanceHarnessSafety(), /must equal the governed disposable acceptance root/);
  process.env.CONSENSUS_ACCEPTANCE_ROOT = root;
  process.env.CONSENSUS_ACCEPTANCE_URL = "https://production.example.invalid";
  assert.throws(() => assertDisposableAcceptanceHarnessSafety(), /must be loopback HTTP/);
  process.env.CONSENSUS_ACCEPTANCE_URL = "http://127.0.0.1:4317";
  process.env.CONSENSUS_ACCEPTANCE_ARTIFACT_SHA256 = "f".repeat(64);
  assert.throws(() => assertDisposableAcceptanceHarnessSafety(), /registry is sole authority/);
  delete process.env.CONSENSUS_ACCEPTANCE_ARTIFACT_SHA256;

  process.env.APP_ENV = "production";
  assert.throws(() => assertRuntimeStartupSafety(), /rejects disposable acceptance configuration/);
  process.env.APP_ENV = "disposable_acceptance";

  process.env.DATABASE_URL = "postgresql://user:secret@production.example/db";
  assert.throws(() => assertRuntimeStartupSafety(), /exact loopback disposable target/);
  process.env.DATABASE_URL = "postgresql://local:test@127.0.0.1:5432/mc_disposable_acceptance_runtime_test";
  process.env.AWS_ACCESS_KEY_ID = "not-a-real-key";
  assert.throws(() => assertRuntimeStartupSafety(), /rejects production credentials/);
  delete process.env.AWS_ACCESS_KEY_ID;

  process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS = JSON.stringify([root]);
  assert.throws(() => assertRuntimeStartupSafety(), /provider-writable root/);
  process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS = JSON.stringify([providerRoot]);

  const approvedBindings = process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS;
  process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS = approvedBindings.replace(
    testAuthorityIdentity,
    "b".repeat(64),
  );
  assert.throws(() => assertRuntimeStartupSafety(), /changed after governed bootstrap/);
  process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS = approvedBindings;
  await rm(providerRoot, { recursive: true });
  assert.throws(() => assertRuntimeStartupSafety(), /ENOENT/);
  await writeFile(providerRoot, "not-a-directory");
  assert.throws(() => assertRuntimeStartupSafety(), /changed after governed bootstrap/);
  await rm(providerRoot);
  await symlink(artifactRoot, providerRoot);
  assert.throws(() => assertRuntimeStartupSafety(), /changed after governed bootstrap/);
  await rm(providerRoot);
  await mkdir(providerRoot, { mode: 0o700 });

  await writeRegistry({ ...registry, expiresAt: new Date(Date.now() - 1).toISOString() });
  assert.throws(() => assertRuntimeStartupSafety(), /expiry|entries are invalid/);
  await writeRegistry({ ...registry, authority: "production_signed_registry" });
  assert.throws(() => assertRuntimeStartupSafety(), /authority/);
});
