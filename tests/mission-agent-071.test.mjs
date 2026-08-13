import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalJson as missionControlCanonicalJson,
  parseCanonicalReleaseManifestJson,
  verifyReleaseManifestV2 as verifyMissionControlManifest,
} from "../integrations/mission-agent/release-authority.ts";

const artifactUrl = new URL("../public/mission-agent-0.7.1.mjs", import.meta.url);
const artifactBytes = await readFile(artifactUrl);
const artifactSource = artifactBytes.toString();
const agent = await import(artifactUrl.href);
const manifest = JSON.parse(
  await readFile(new URL("../release/mission-agent-0.7.1/unsigned-manifest-v2.json", import.meta.url), "utf8"),
);
const productionKeyId = "mission-agent-release-2026-01";
const productionFingerprint = "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b";
const productionSpki = "MCowBQYDK2VwAyEAvSkEoddFoGfJn2PauL+KEl4ykZ+5WM5B2PklJOZOAKE=";

test("0.7.0 remains immutable and 0.7.1 is a distinct deterministic artifact", async () => {
  const v070 = await readFile(new URL("../public/mission-agent-0.7.0.mjs", import.meta.url));
  assert.equal(
    createHash("sha256").update(v070).digest("hex"),
    "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e",
  );
  assert.equal(
    createHash("sha256").update(artifactBytes).digest("hex"),
    "279365e5d1bcd18ce9bd8ac84d4b7e512cd3ff2f7f559e9892cd6fda3bf17803",
  );
  assert.equal((await agent.artifactIdentity()).sourceCommit, "3227a1210462d2e4061d5e04fdcfc9f8fe6218cd");
});

test("stored unsigned manifest is the exact canonical signing input", async () => {
  const text = await readFile(
    new URL("../release/mission-agent-0.7.1/unsigned-manifest-v2.json", import.meta.url),
    "utf8",
  );
  assert.deepEqual(parseCanonicalReleaseManifestJson(text), manifest);
  assert.equal(Buffer.byteLength(text.trim()), 497);
  assert.equal(
    createHash("sha256").update(text.trim()).digest("hex"),
    "8fc90fb63b1b6440e590a58e7c3eda5318b2fbd7c96c41a6cb97636bc9882275",
  );
  assert.throws(
    () =>
      agent.verifyReleaseManifestText(
        agent.canonicalJson({ ...manifest, signature: Buffer.alloc(64).toString("base64") }),
      ),
    /signature verification failed/,
  );
});

test("default trust embeds only the approved production bootstrap key", () => {
  assert.match(artifactSource, new RegExp(productionKeyId));
  assert.match(artifactSource, new RegExp(productionFingerprint));
  assert.match(artifactSource, new RegExp(productionSpki.replace(/[+/=]/g, "\\$&")));
  assert.match(artifactSource, /status: "active"/);
  assert.match(artifactSource, /bootstrap: "production-trust-root-0\.7\.1"/);
  assert.equal(
    createPublicKey({ key: Buffer.from(productionSpki, "base64"), format: "der", type: "spki" }).asymmetricKeyType,
    "ed25519",
  );
  assert.equal(
    "ed25519-spki-sha256:" + createHash("sha256").update(Buffer.from(productionSpki, "base64")).digest("hex"),
    productionFingerprint,
  );

  assert.throws(
    () => agent.verifyReleaseManifest({ ...manifest, signature: Buffer.alloc(64).toString("base64") }),
    /signature verification failed/,
  );
});

test("real update path uses embedded trust and rejects silent external override", () => {
  assert.match(artifactSource, /verifyReleaseManifestText\(manifestText, \{ allowRollbackVersion \}\)/);
  assert.doesNotMatch(artifactSource, /verifyReleaseManifestText\(manifestText, \{[^}]*trustStore/);
  assert.throws(
    () =>
      agent.verifyReleaseManifest({ ...manifest, signature: Buffer.alloc(64).toString("base64") }, { trustStore: {} }),
    /override is not authorized/,
  );
  assert.throws(
    () =>
      agent.verifyReleaseManifest(
        { ...manifest, signature: Buffer.alloc(64).toString("base64") },
        { trustStore: {}, allowTestTrustStoreOverride: true },
      ),
    /not active/,
  );
});

test("explicit test fixture proves Mission Control and Mission Agent canonical signed-byte agreement", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = "ed25519-spki-sha256:" + createHash("sha256").update(spki).digest("hex");
  const key = {
    keyId: productionKeyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: spki.toString("base64"),
    publicKeyFingerprint: fingerprint,
    status: "active",
    purpose: "mission-agent-release",
    activatedAt: "2026-07-27T16:00:31.000Z",
    retiresAt: null,
    revokedAt: null,
  };
  const canonical = agent.canonicalJson(manifest);
  assert.equal(canonical, missionControlCanonicalJson(manifest));
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64");
  const centralKey = {
    ...key,
    createdAt: key.activatedAt,
    replacedBy: null,
    historicalVersions: [],
    kms: null,
  };
  assert.equal(
    verifyMissionControlManifest(
      { ...manifest, signature },
      { keys: { [productionKeyId]: centralKey }, now: new Date("2026-07-28T00:00:00.000Z") },
    ).agentVersion,
    "0.7.1",
  );
  assert.equal(
    agent.verifyReleaseManifest(
      { ...manifest, signature },
      { trustStore: { [productionKeyId]: key }, allowTestTrustStoreOverride: true },
    ).version,
    "0.7.1",
  );

  for (const changed of [
    { ...manifest, artifactSha256: "a".repeat(64) },
    { ...manifest, sourceCommit: "a".repeat(40) },
    { ...manifest, agentVersion: "0.7.2", artifactPath: "/mission-agent-0.7.2.mjs" },
    { ...manifest, identityProtocolVersion: "1" },
    { ...manifest, activationProtocolVersion: "2" },
    { ...manifest, signingKeyId: "mission-agent-release-2099-99" },
  ])
    assert.throws(() =>
      agent.verifyReleaseManifest(
        { ...changed, signature },
        { trustStore: { [productionKeyId]: key }, allowTestTrustStoreOverride: true },
      ),
    );
});

test("trust and manifest mutation matrix fails closed", () => {
  const production = {
    keyId: productionKeyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: productionSpki,
    publicKeyFingerprint: productionFingerprint,
    status: "active",
    purpose: "mission-agent-release",
    activatedAt: "2026-07-27T16:00:31.000Z",
    retiresAt: null,
    revokedAt: null,
  };
  for (const changed of [
    { ...production, status: "pending", activatedAt: null },
    { ...production, status: "retired", retiresAt: "2026-07-27T16:00:32.000Z" },
    { ...production, status: "revoked", revokedAt: "2026-07-27T16:00:32.000Z" },
  ]) {
    assert.doesNotThrow(() => agent.validateReleaseTrustStore({ [productionKeyId]: changed }));
    assert.throws(
      () =>
        agent.verifyReleaseManifest(
          { ...manifest, signature: Buffer.alloc(64).toString("base64") },
          { trustStore: { [productionKeyId]: changed }, allowTestTrustStoreOverride: true },
        ),
      /not active|retired/,
    );
  }
  for (const changed of [
    { ...production, publicKeyFingerprint: "ed25519-spki-sha256:" + "a".repeat(64) },
    { ...production, publicKeySpkiBase64: "AA==" },
  ])
    assert.throws(() => agent.validateReleaseTrustStore({ [productionKeyId]: changed }));

  assert.throws(() =>
    agent.validateReleaseTrustStore({
      [productionKeyId]: production,
      "mission-agent-release-2099-99": { ...production, keyId: "mission-agent-release-2099-99" },
    }),
  );
  for (const changed of [
    { ...manifest, extra: true },
    { ...manifest, sourceCommit: undefined },
    { ...manifest, artifactSha256: "A".repeat(64) },
    { ...manifest, identityProtocolVersion: "1" },
    { ...manifest, canonicalizationVersion: "2" },
    { ...manifest, platform: "different" },
  ])
    assert.throws(() => agent.parseReleaseManifestV2(changed));
  assert.throws(() =>
    agent.verifyReleaseManifestText(
      JSON.stringify({ ...manifest, signature: Buffer.alloc(63).toString("base64") }, null, 2),
    ),
  );
  assert.throws(() =>
    agent.verifyReleaseManifestText(JSON.stringify({ ...manifest, signature: Buffer.alloc(65).toString("base64") })),
  );
  assert.throws(() =>
    agent.verifyReleaseManifestText('{"activationProtocolVersion":"1","activationProtocolVersion":"2"}'),
  );
});
