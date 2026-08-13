import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedMissionAgentArtifacts,
  verifyMissionAgentArtifact,
} from "../integrations/mission-agent/artifact-manifest.ts";
import { assertRuntimeStartupSafety, runtimeTrustEvidence } from "../lib/runtime-trust.ts";

const approved = approvedMissionAgentArtifacts["0.6.8"].sha256;
const approved072 = approvedMissionAgentArtifacts["0.7.2"].sha256;
test("0.6.8 immutable artifact metadata and approved registry agree", async () => {
  const bytes = await readFile(new URL("../public/mission-agent-0.6.8.mjs", import.meta.url));
  const metadata = JSON.parse(
    await readFile(new URL("../public/mission-agent-0.6.8.mjs.artifact.json", import.meta.url), "utf8"),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, approved);
  assert.equal(metadata.sha256, approved);
  assert.equal(metadata.manifestVersion, "1");
});

test("artifact verification accepts only the approved canonical identity", () => {
  assert.equal(verifyMissionAgentArtifact("0.6.8", { sha256: approved, manifestVersion: "1" }).status, "verified");
  for (const [version, artifact, status] of [
    ["0.6.8", undefined, "missing"],
    ["0.6.8", { sha256: "", manifestVersion: "1" }, "missing"],
    ["0.6.8", { sha256: approved.toUpperCase(), manifestVersion: "1" }, "malformed"],
    ["0.6.8", { sha256: "a".repeat(63), manifestVersion: "1" }, "malformed"],
    ["0.6.8", { sha256: "z".repeat(64), manifestVersion: "1" }, "malformed"],
    ["0.6.8", { sha256: "a".repeat(64), manifestVersion: "1" }, "mismatch"],
    ["0.6.7", { sha256: approved, manifestVersion: "1" }, "unapproved_version"],
    ["9.9.9", { sha256: approved, manifestVersion: "1" }, "unapproved_version"],
  ])
    assert.equal(verifyMissionAgentArtifact(version, artifact).status, status);
});

test("signed 0.7.2 heartbeat identity is approved without weakening v3 signer binding", () => {
  const identity = {
    version: "0.7.2",
    sha256: approved072,
    manifestVersion: "3",
    releaseAuthorityVersion: "v2",
    signingKeyId: "mission-agent-release-2026-01",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  };
  const verified = verifyMissionAgentArtifact("0.7.2", identity);
  assert.equal(verified.status, "verified");
  assert.equal(verified.identityProtocolVersion, "2");
  for (const mutation of [
    { releaseAuthorityVersion: "v1" },
    { signingKeyId: "mission-agent-release-2026-02" },
    { publicKeyFingerprint: `ed25519-spki-sha256:${"0".repeat(64)}` },
    { manifestVersion: "1" },
    { sha256: "0".repeat(64) },
  ])
    assert.equal(verifyMissionAgentArtifact("0.7.2", { ...identity, ...mutation }).status, "mismatch");
});

test("disposable mode accepts only an exact non-writable governed registry entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mission-agent-local-registry-"));
  const path = join(directory, "registry.json");
  const names = [
    "APP_ENV",
    "CONSENSUS_DISPOSABLE_ACCEPTANCE",
    "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY",
    "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256",
    "DISPOSABLE_ACCEPTANCE_DATABASE_NAME",
    "DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS",
    "DATABASE_URL",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const sha256 = "e".repeat(64);
  const packetHashes = Object.fromEntries(
    [
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
    ].map((name, index) => [name, (index.toString(16).slice(-1) || "a").repeat(64)]),
  );
  const registry = {
    registryVersion: "mission-agent-disposable-acceptance/2",
    runtimeMode: "disposable_acceptance",
    authority: "operator_disposable_exact_checksum",
    scope: "consensus_real_provider_acceptance",
    disposable: true,
    productionAuthorityAccepted: false,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    artifacts: {
      "0.8.0": {
        sha256,
        ...packetHashes,
        manifestVersion: "3",
        identityProtocolVersion: "2",
        releaseAuthorityVersion: "v2",
        signingKeyId: "local-acceptance-only",
        publicKeyFingerprint: `ed25519-spki-sha256:${"1".repeat(64)}`,
        sourceCommit: "a".repeat(40),
        modelAllowlist: {
          planner_a: { provider: "claude_code", model: "claude-test-planner" },
          planner_b: { provider: "codex", model: "gpt-test-planner" },
          synthesizer: { provider: "claude_code", model: "claude-test-planner" },
          executor: { provider: "codex", model: "gpt-test-executor" },
        },
        runtimeBindings: {
          "claude-implementation-macos-v2": "2".repeat(64),
          "claude-planning-macos-v2": "1".repeat(64),
          "codex-implementation-macos-v2": "4".repeat(64),
          "codex-planning-macos-v2": "3".repeat(64),
        },
      },
    },
  };
  const writeRegistry = async (value) => {
    await chmod(directory, 0o700);
    await chmod(path, 0o600).catch(() => undefined);
    await writeFile(path, JSON.stringify(value), { mode: 0o400 });
    await chmod(path, 0o400);
    await chmod(directory, 0o500);
    process.env.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  };
  try {
    await writeRegistry(registry);
    process.env.APP_ENV = "disposable_acceptance";
    process.env.CONSENSUS_DISPOSABLE_ACCEPTANCE = "true";
    process.env.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY = path;
    process.env.DISPOSABLE_ACCEPTANCE_DATABASE_NAME = "mc_disposable_acceptance_artifact_test";
    process.env.DATABASE_URL =
      "postgresql://mission_control:test@127.0.0.1:5432/mc_disposable_acceptance_artifact_test";
    process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS = "[]";
    assert.equal(verifyMissionAgentArtifact("0.8.0", { sha256, manifestVersion: "3" }).status, "mismatch");
    const identity = {
      sha256,
      artifactMetadataSha256: packetHashes.artifactMetadataSha256,
      capabilityManifestSha256: packetHashes.capabilityManifestSha256,
      manifestVersion: "3",
      releaseAuthorityVersion: "v2",
      signingKeyId: "local-acceptance-only",
      publicKeyFingerprint: `ed25519-spki-sha256:${"1".repeat(64)}`,
    };
    const verified = verifyMissionAgentArtifact("0.8.0", identity);
    assert.equal(verified.status, "verified");
    assert.equal(verified.runtimeTrust.runtimeMode, "disposable_acceptance");
    assert.equal(verified.runtimeTrust.registryContentHash, process.env.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256);
    assert.equal(runtimeTrustEvidence().trustAuthority, "disposable_exact_checksum_registry");

    await writeRegistry({
      ...registry,
      artifacts: { "0.8.0": { ...registry.artifacts["0.8.0"], sha256: "f".repeat(64) } },
    });
    assert.equal(verifyMissionAgentArtifact("0.8.0", identity).status, "mismatch");
    await writeRegistry(registry);
    process.env.APP_ENV = "production";
    assert.equal(verifyMissionAgentArtifact("0.8.0", identity).status, "unapproved_version");
    assert.throws(() => assertRuntimeStartupSafety(), /rejects disposable acceptance configuration/);
    process.env.APP_ENV = "disposable_acceptance";
    await writeRegistry({ ...registry, expiresAt: new Date(Date.now() - 1).toISOString() });
    assert.throws(() => verifyMissionAgentArtifact("0.8.0", identity), /expiry|entries are invalid/);
    await writeRegistry({ ...registry, authority: "production_signed_registry" });
    assert.throws(() => verifyMissionAgentArtifact("0.8.0", identity), /authority/);
  } finally {
    for (const name of names)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
