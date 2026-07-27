import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { acceptMissionAgentProductionRelease } from "../application/mission-agent-release-selection.ts";
import {
  canonicalReleaseManifestV3 as missionControlCanonicalV3,
  publicKeyFingerprint,
  verifyReleaseManifestV3 as verifyMissionControlV3,
} from "../integrations/mission-agent/release-authority.ts";

const artifactUrl = new URL("../public/mission-agent-0.7.2.mjs", import.meta.url);
const artifactBytes = await readFile(artifactUrl);
const artifactSource = artifactBytes.toString();
const agent = await import(artifactUrl.href);
const manifestText = await readFile(
  new URL("../release/mission-agent-0.7.2/unsigned-manifest-v3.json", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(manifestText);
const productionKeyId = "mission-agent-release-2026-01";
const productionFingerprint = "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b";

test("0.7.0 and 0.7.1 remain immutable while 0.7.2 is distinct", async () => {
  const v070 = await readFile(new URL("../public/mission-agent-0.7.0.mjs", import.meta.url));
  const v071 = await readFile(new URL("../public/mission-agent-0.7.1.mjs", import.meta.url));
  assert.equal(
    createHash("sha256").update(v070).digest("hex"),
    "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e",
  );
  assert.equal(v071.byteLength, 136520);
  assert.equal(
    createHash("sha256").update(v071).digest("hex"),
    "279365e5d1bcd18ce9bd8ac84d4b7e512cd3ff2f7f559e9892cd6fda3bf17803",
  );
  assert.equal(manifest.artifactByteLength, artifactBytes.byteLength);
  assert.equal(manifest.artifactSha256, createHash("sha256").update(artifactBytes).digest("hex"));
});

test("Mission Control and Mission Agent produce identical Manifest v3 canonical bytes", () => {
  assert.equal(manifestText, missionControlCanonicalV3(manifest));
  assert.equal(agent.canonicalReleaseManifestV3(manifest), manifestText);
  assert.deepEqual(agent.parseReleaseManifestV3(manifest), manifest);
});

test("Manifest v3 fixture verifies through both implementations with key and fingerprint binding", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = publicKeyFingerprint(spki.toString("base64"));
  const fixture = { ...manifest, publicKeyFingerprint: fingerprint };
  const signature = sign(null, Buffer.from(agent.canonicalReleaseManifestV3(fixture)), privateKey).toString("base64");
  const agentKey = {
    keyId: productionKeyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: spki.toString("base64"),
    publicKeyFingerprint: fingerprint,
    status: "active",
    purpose: "mission-agent-release",
    activatedAt: manifest.createdAt,
    retiresAt: null,
    revokedAt: null,
  };
  const centralKey = {
    ...agentKey,
    createdAt: manifest.createdAt,
    replacedBy: null,
    historicalVersions: [],
    kms: null,
  };
  assert.equal(
    agent.verifyReleaseManifestV3(
      { ...fixture, signature },
      {
        trustStore: { [productionKeyId]: agentKey },
        allowTestTrustStoreOverride: true,
        now: new Date(manifest.createdAt),
      },
    ).version,
    "0.7.2",
  );
  assert.equal(
    verifyMissionControlV3(
      { ...fixture, signature },
      { keys: { [productionKeyId]: centralKey }, now: new Date(manifest.createdAt) },
    ).releaseVersion,
    "0.7.2",
  );
});

test("real updater requires v3, embedded trust, byte length, and has no v2 fallback", () => {
  assert.match(artifactSource, /verifyReleaseManifestText\(manifestText, \{ allowRollbackVersion \}\)/);
  assert.match(artifactSource, /New production releases require Manifest v3/);
  assert.match(artifactSource, /Update artifact byte-length verification failed/);
  assert.match(artifactSource, /Buffer\.byteLength\(source, "utf8"\)/);
  assert.throws(
    () => agent.verifyReleaseManifest({ ...manifest, signature: Buffer.alloc(64).toString("base64") }),
    /signature verification failed/i,
  );
  assert.throws(
    () =>
      agent.verifyReleaseManifest({ ...manifest, signature: Buffer.alloc(64).toString("base64") }, { trustStore: {} }),
    /override is not authorized/i,
  );
  assert.throws(() => agent.verifyReleaseManifest({ manifestVersion: "2" }), /require Manifest v3/i);
  assert.doesNotThrow(() =>
    agent.assertReleasePlatformEligibility(manifest, {
      nodeMajorVersion: 22,
      operatingSystem: "darwin",
      architecture: "arm64",
    }),
  );
  for (const runtime of [
    { nodeMajorVersion: 24, operatingSystem: "darwin", architecture: "arm64" },
    { nodeMajorVersion: 22, operatingSystem: "win32", architecture: "x64" },
    { nodeMajorVersion: 22, operatingSystem: "linux", architecture: "ia32" },
  ])
    assert.throws(() => agent.assertReleasePlatformEligibility(manifest, runtime), /platform is incompatible/i);
});

test("0.7.2 capability source advertises the complete v3 eligibility contract", () => {
  for (const expected of [
    'authorityVersion: "v2"',
    "manifestVersion: RELEASE_MANIFEST_VERSION",
    "canonicalizationVersion: RELEASE_CANONICALIZATION_VERSION",
    'minimumProductionManifestVersion: "3"',
    'historicalManifestVersions: ["1", "2"]',
    productionKeyId,
    productionFingerprint,
  ])
    assert.ok(artifactSource.includes(expected), `missing capability field: ${expected}`);
});

test("exact production-signed 0.7.2 bundle passes selection and the default updater trust path", async () => {
  const signedManifestText = await readFile(
    new URL("../release/mission-agent-0.7.2/signed-manifest-v3.json", import.meta.url),
    "utf8",
  );
  assert.equal(signedManifestText.at(-1), "}");
  const selected = acceptMissionAgentProductionRelease({
    signedManifestText,
    artifactBytes,
    artifactName: "mission-agent-0.7.2.mjs",
  });
  const updater = agent.verifyReleaseManifestText(signedManifestText);
  assert.equal(selected.releaseVersion, "0.7.2");
  assert.equal(updater.version, "0.7.2");
  assert.equal(updater.manifestVersion, "3");
  assert.equal(updater.artifactByteLength, artifactBytes.byteLength);
  assert.equal(updater.sha256, createHash("sha256").update(artifactBytes).digest("hex"));
});

test("Manifest v3 mutation matrix fails closed in the bundled artifact", () => {
  const mutations = [
    { manifestVersion: "2" },
    { releaseAuthorityVersion: "2" },
    { canonicalizationVersion: "release-manifest-json-v2" },
    { publicKeyFingerprint: "ed25519-spki-sha256:" + "a".repeat(63) },
    { signingKeyId: "unknown" },
    { artifactSha256: "A".repeat(64) },
    { artifactByteLength: -1 },
    { releaseVersion: "0.7.3" },
    { artifactName: "mission-agent-0.7.3.mjs" },
    { build: { ...manifest.build, sourceCommit: "A".repeat(40) } },
    { platform: { ...manifest.platform, runtime: "Node" } },
    { platform: { ...manifest.platform, runtimeMajorVersion: 23 } },
    { platform: { ...manifest.platform, operatingSystem: "darwin" } },
    { platform: { ...manifest.platform, architecture: "arm64" } },
    { platform: { ...manifest.platform, artifactFormat: "cjs" } },
    { provenance: { ...manifest.provenance, nodeVersion: "24.0.0" } },
    { compatibility: { ...manifest.compatibility, identityProtocolVersion: "1" } },
    { compatibility: { ...manifest.compatibility, activationProtocolVersion: "2" } },
    { unknown: true },
  ];
  for (const mutation of mutations) assert.throws(() => agent.parseReleaseManifestV3({ ...manifest, ...mutation }));
  assert.throws(() => agent.verifyReleaseManifestText(`${manifestText}\n`), /canonical|signature/i);
  assert.throws(
    () =>
      agent.verifyReleaseManifestText(
        manifestText.replace('"manifestVersion":"3"', '"manifestVersion":"3","manifestVersion":"3"'),
      ),
    /duplicate/i,
  );
});
