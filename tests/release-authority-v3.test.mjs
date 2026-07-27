import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { acceptMissionAgentProductionRelease } from "../application/mission-agent-release-selection.ts";
import {
  canonicalReleaseManifestV3,
  canonicalJson,
  parseCanonicalReleaseManifestV3Json,
  parseReleaseManifestV3,
  publicKeyFingerprint,
  supportsManifestV3ProductionRelease,
  verifyNewProductionReleaseManifest,
  verifyReleaseManifestV3,
} from "../integrations/mission-agent/release-authority.ts";

const keyId = "mission-agent-release-2026-01";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" });
const fingerprint = publicKeyFingerprint(spki.toString("base64"));
const key = {
  keyId,
  algorithm: "Ed25519",
  publicKeySpkiBase64: spki.toString("base64"),
  publicKeyFingerprint: fingerprint,
  status: "active",
  purpose: "mission-agent-release",
  createdAt: "2026-07-27T16:00:31.000Z",
  activatedAt: "2026-07-27T16:00:31.000Z",
  retiresAt: null,
  revokedAt: null,
  replacedBy: null,
  historicalVersions: [],
  kms: null,
};
const manifest = {
  artifactByteLength: 140000,
  artifactName: "mission-agent-0.7.2.mjs",
  artifactSha256: "a".repeat(64),
  build: { buildId: "mission-agent-0.7.2-test", sourceCommit: "b".repeat(40) },
  canonicalizationVersion: "release-manifest-json-v3",
  compatibility: {
    activationProtocolVersion: "1",
    identityProtocolVersion: "2",
    minimumMissionControlVersion: "0.1.0",
  },
  createdAt: "2026-07-27T16:00:31.000Z",
  expiresAt: "2026-08-26T16:00:31.000Z",
  manifestVersion: "3",
  platform: {
    architecture: "universal",
    artifactFormat: "esm",
    operatingSystem: "darwin-linux",
    runtime: "node",
    runtimeMajorVersion: 22,
  },
  provenance: {
    builderSha256: "c".repeat(64),
    containerImageDigest: "node@sha256:" + "d".repeat(64),
    manifestSchemaSha256: "e".repeat(64),
    nodeVersion: "22.22.0",
    packageLockSha256: "f".repeat(64),
    reproducibilityEvidenceSha256: "1".repeat(64),
  },
  publicKeyFingerprint: fingerprint,
  releaseAuthorityVersion: "v2",
  releaseVersion: "0.7.2",
  signingKeyId: keyId,
};

function signed(value = manifest) {
  return {
    ...value,
    signature: sign(null, Buffer.from(canonicalReleaseManifestV3(value)), privateKey).toString("base64"),
  };
}

test("Manifest v3 canonicalization and signature bind the complete release identity", () => {
  const canonical = canonicalReleaseManifestV3(manifest);
  assert.equal(canonicalReleaseManifestV3(Object.fromEntries(Object.entries(manifest).reverse())), canonical);
  assert.deepEqual(parseCanonicalReleaseManifestV3Json(canonical), manifest);
  assert.deepEqual(
    verifyNewProductionReleaseManifest(signed(), {
      keys: { [keyId]: key },
      now: new Date("2026-07-28T00:00:00.000Z"),
    }),
    manifest,
  );
  assert.match(createHash("sha256").update(canonical).digest("hex"), /^[a-f0-9]{64}$/);
});

test("Manifest v3 rejects noncanonical and duplicate JSON before verification", () => {
  const canonical = canonicalReleaseManifestV3(manifest);
  assert.throws(() => parseCanonicalReleaseManifestV3Json(`${canonical}\n`), /trailing newline/);
  assert.throws(() => parseCanonicalReleaseManifestV3Json(JSON.stringify(manifest, null, 2)), /not canonical/);
  assert.throws(
    () =>
      parseCanonicalReleaseManifestV3Json(
        canonical.replace('"manifestVersion":"3"', '"manifestVersion":"3","manifestVersion":"3"'),
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseCanonicalReleaseManifestV3Json(
        canonical.replace('"releaseVersion":"0.7.2"', '"releaseVersion":"\\u0030.7.2"'),
      ),
    /not canonical/,
  );
});

test("Manifest v3 schema and trust mutation matrix fails closed", () => {
  const mutations = [
    { manifestVersion: "2" },
    { releaseAuthorityVersion: "2" },
    { canonicalizationVersion: "release-manifest-json-v2" },
    { artifactByteLength: 0 },
    { artifactSha256: "A".repeat(64) },
    { artifactName: "mission-agent.mjs" },
    { releaseVersion: "0.7.3" },
    { signingKeyId: "unknown" },
    { publicKeyFingerprint: "ed25519-spki-sha256:" + "c".repeat(63) },
    { platform: { ...manifest.platform, runtime: "Node" } },
    { platform: { ...manifest.platform, runtimeMajorVersion: 23 } },
    { platform: { ...manifest.platform, operatingSystem: "macos" } },
    { platform: { ...manifest.platform, architecture: "arm64" } },
    { platform: { ...manifest.platform, artifactFormat: "commonjs" } },
    { provenance: { ...manifest.provenance, nodeVersion: "24.0.0" } },
    { provenance: { ...manifest.provenance, builderSha256: "C".repeat(64) } },
    { compatibility: { ...manifest.compatibility, identityProtocolVersion: "1" } },
    { compatibility: { ...manifest.compatibility, activationProtocolVersion: "2" } },
    { build: { ...manifest.build, sourceCommit: "C".repeat(40) } },
    { extra: true },
  ];
  for (const mutation of mutations) assert.throws(() => parseReleaseManifestV3({ ...manifest, ...mutation }));
  for (const field of Object.keys(manifest)) {
    const changed = { ...manifest };
    delete changed[field];
    assert.throws(() => parseReleaseManifestV3(changed));
  }
  for (const status of ["pending", "retiring", "retired", "revoked"])
    assert.throws(() =>
      verifyReleaseManifestV3(signed(), {
        keys: {
          [keyId]: {
            ...key,
            status,
            activatedAt: status === "pending" ? null : key.activatedAt,
            retiresAt: status === "retired" ? "2026-07-27T23:00:00.000Z" : null,
            revokedAt: status === "revoked" ? "2026-07-27T23:00:00.000Z" : null,
          },
        },
        now: new Date("2026-07-28T00:00:00.000Z"),
      }),
    );
});

test("new production release verification rejects Manifest v1/v2 downgrade", () => {
  assert.throws(() => verifyNewProductionReleaseManifest({ manifestVersion: "1" }), /require Manifest v3/);
  assert.throws(() => verifyNewProductionReleaseManifest({ manifestVersion: "2" }), /require Manifest v3/);
  assert.throws(() => verifyNewProductionReleaseManifest({ manifestVersion: "4" }), /require Manifest v3/);
});

test("Mission Control eligibility requires the complete Manifest v3 capability", () => {
  const capability = {
    authorityVersion: "v2",
    manifestVersion: "3",
    canonicalizationVersion: "release-manifest-json-v3",
    minimumProductionManifestVersion: "3",
    signingKeyId: keyId,
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  };
  assert.equal(supportsManifestV3ProductionRelease(capability), true);
  for (const field of Object.keys(capability))
    assert.equal(supportsManifestV3ProductionRelease({ ...capability, [field]: "unsupported" }), false);
  assert.equal(supportsManifestV3ProductionRelease(null), false);
});

test("Mission Control production selection enforces v3 signature, compatibility, name, length, and checksum", () => {
  const artifactBytes = Buffer.from("manifest-v3-production-selection-fixture");
  const selectedManifest = {
    ...manifest,
    artifactByteLength: artifactBytes.byteLength,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
  };
  const bundle = signed(selectedManifest);
  const accepted = acceptMissionAgentProductionRelease({
    signedManifestText: canonicalJson(bundle),
    artifactBytes,
    artifactName: selectedManifest.artifactName,
    keys: { [keyId]: key },
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(accepted.releaseVersion, "0.7.2");
  assert.throws(() =>
    acceptMissionAgentProductionRelease({
      signedManifestText: canonicalJson(bundle),
      artifactBytes: Buffer.from("different bytes with same-ish length"),
      artifactName: selectedManifest.artifactName,
      keys: { [keyId]: key },
      now: new Date("2026-07-28T00:00:00.000Z"),
    }),
  );
});
