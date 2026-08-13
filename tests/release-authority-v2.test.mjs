import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalJson,
  parseCanonicalReleaseManifestJson,
  parseReleaseManifestV2,
  publicKeyFingerprint,
  trustedReleaseKeys,
  validatePendingReleaseKey,
  validateTrustStore,
  verifyNewProductionReleaseManifest,
  verifyReleaseManifestV2,
} from "../integrations/mission-agent/release-authority.ts";

const base = {
  activationProtocolVersion: "1",
  agentVersion: "0.6.9",
  artifactPath: "/mission-agent-0.6.9.mjs",
  artifactSha256: "a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af",
  buildId: "mission-agent-0.6.9-1c8aee7",
  createdAt: "2026-07-25T16:00:00.000Z",
  expiresAt: "2026-08-01T16:00:00.000Z",
  identityProtocolVersion: "2",
  manifestVersion: "2",
  minimumMissionControlVersion: "0.1.0",
  signingKeyId: "mission-agent-release-2026-01",
  sourceCommit: "1c8aee72eda931f45f2dfae3db2c0f7798a67400",
};

test("old trust root is a valid Ed25519 public key retained for historical 0.6.8 verification", () => {
  validateTrustStore();
  const old = trustedReleaseKeys["mission-agent-release-2026-00"];
  assert.equal(
    createPublicKey({ key: Buffer.from(old.publicKeySpkiBase64, "base64"), format: "der", type: "spki" })
      .asymmetricKeyType,
    "ed25519",
  );
  assert.equal(publicKeyFingerprint(old.publicKeySpkiBase64), old.publicKeyFingerprint);
  assert.deepEqual(old.historicalVersions, ["0.6.8"]);
  assert.equal(old.status, "retiring");
});

test("pending replacement key insertion rejects incomplete or activated records", () => {
  const base = {
    keyId: "mission-agent-release-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: trustedReleaseKeys["mission-agent-release-2026-00"].publicKeySpkiBase64,
    publicKeyFingerprint: trustedReleaseKeys["mission-agent-release-2026-00"].publicKeyFingerprint,
    status: "pending",
    purpose: "mission-agent-release",
    createdAt: "2026-07-25T18:01:20.000Z",
    activatedAt: null,
    retiresAt: null,
    revokedAt: null,
    replacedBy: null,
    historicalVersions: [],
    kms: {
      provider: "aws-kms",
      accountId: "123456789012",
      region: "us-east-1",
      keyArn: "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111",
      keyId: "11111111-1111-1111-1111-111111111111",
      keySpec: "ECC_NIST_EDWARDS25519",
      keyUsage: "SIGN_VERIFY",
      signingAlgorithm: "ED25519_SHA_512",
      origin: "AWS_KMS",
      keyManager: "CUSTOMER",
      multiRegion: false,
    },
  };
  assert.deepEqual(validatePendingReleaseKey(base), base);
  assert.throws(() => validatePendingReleaseKey({ ...base, publicKeySpkiBase64: "" }));
  assert.throws(() =>
    validatePendingReleaseKey({ ...base, publicKeyFingerprint: "ed25519-spki-sha256:" + "a".repeat(64) }),
  );
  assert.throws(() => validatePendingReleaseKey({ ...base, status: "active", activatedAt: base.createdAt }));
});

test("production KMS replacement key is complete and active while Manifest v2 remains ineligible for new releases", async () => {
  const active = trustedReleaseKeys["mission-agent-release-2026-01"];
  assert.equal(active.status, "active");
  assert.equal(active.activatedAt, "2026-07-27T16:58:06.000Z");
  assert.equal(
    active.publicKeyFingerprint,
    "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  );
  assert.equal(active.kms.keyArn, "arn:aws:kms:us-east-1:661452835066:key/cd9ebd3d-f2c6-44cb-83d6-fd4893008fee");
  assert.throws(
    () => verifyNewProductionReleaseManifest({ ...base, signature: "AA==" }, { now: new Date(base.createdAt) }),
    /require Manifest v3/,
  );

  const builder = await readFile(new URL("../scripts/build-mission-agent-070.mjs", import.meta.url), "utf8");
  const existingUnsignedArtifact = await readFile(
    new URL("../public/mission-agent-0.7.0.mjs", import.meta.url),
    "utf8",
  );
  assert.match(builder, new RegExp(active.publicKeyFingerprint));
  assert.doesNotMatch(existingUnsignedArtifact, new RegExp(active.publicKeyFingerprint));
});

test("v2 canonicalization is deterministic across field insertion order", () => {
  const reversed = Object.fromEntries(Object.entries(base).reverse());
  assert.equal(canonicalJson(parseReleaseManifestV2(base)), canonicalJson(parseReleaseManifestV2(reversed)));
  assert.equal(
    createHash("sha256").update(canonicalJson(base)).digest("hex"),
    createHash("sha256").update(canonicalJson(reversed)).digest("hex"),
  );
});

test("v2 rejects missing, duplicate-after-parse, unknown, and modified identity fields", () => {
  for (const candidate of [
    { ...base, signingKeyId: undefined },
    { ...base, extra: "not-allowed" },
    { ...base, manifestVersion: "1" },
    { ...base, artifactSha256: "A".repeat(64) },
    { ...base, artifactPath: "/mission-agent-0.6.8.mjs" },
    { ...base, sourceCommit: "a".repeat(39) },
    { ...base, signingKeyId: "unknown" },
    { ...base, expiresAt: base.createdAt },
  ])
    assert.throws(() => parseReleaseManifestV2(candidate));
  const duplicate = '{"agentVersion":"0.6.9","agentVersion":"9.9.9"}';
  assert.throws(() => parseCanonicalReleaseManifestJson(duplicate), /schema|canonical/);
  assert.throws(
    () => parseCanonicalReleaseManifestJson(JSON.stringify(Object.fromEntries(Object.entries(base).reverse()))),
    /canonical/,
  );
  assert.throws(() => parseCanonicalReleaseManifestJson(JSON.stringify(base, null, 2)), /canonical/);
});

test("unknown, pending, retired, revoked, and invalid signatures fail closed", () => {
  for (const [status, error] of [
    ["pending", /pending/],
    ["retiring", /retiring/],
    ["retired", /retired/],
    ["revoked", /revoked/],
  ]) {
    const key = {
      ...trustedReleaseKeys["mission-agent-release-2026-00"],
      keyId: base.signingKeyId,
      status,
      activatedAt: null,
      revokedAt: status === "revoked" ? base.createdAt : null,
    };
    assert.throws(
      () =>
        verifyReleaseManifestV2(
          { ...base, signature: "AA==" },
          { now: new Date(base.createdAt), keys: { [base.signingKeyId]: key } },
        ),
      error,
    );
  }
  assert.throws(
    () => verifyReleaseManifestV2({ ...base, signature: "AA==" }, { now: new Date(base.createdAt), keys: {} }),
    /unknown/,
  );
});

test("0.6.8 artifact remains byte-for-byte valid after the published pointer advances", async () => {
  const bytes = await readFile(new URL("../public/mission-agent-0.6.8.mjs", import.meta.url));
  const published = JSON.parse(await readFile(new URL("../public/mission-agent-latest.json", import.meta.url), "utf8"));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
  );
  assert.equal(published.releaseVersion, "0.7.2");
  assert.equal(published.manifestVersion, "3");
});

test("the preserved unsigned 0.6.9 candidate is not falsely represented as v2-capable", async () => {
  const bytes = await readFile(new URL("../public/mission-agent-0.6.9.mjs", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), base.artifactSha256);
  assert.match(bytes.toString(), /manifestVersion !== "1"/);
  assert.doesNotMatch(bytes.toString(), /mission-agent-release-2026-01/);
});
