import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceCommitIndex = process.argv.indexOf("--source-commit");
const sourceCommit = sourceCommitIndex >= 0 ? process.argv[sourceCommitIndex + 1] : undefined;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("Provide --source-commit as a full lowercase Git SHA");

const sourcePath = resolve("public/mission-agent-0.6.9.mjs");
const targetPath = resolve(
  process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : "public/mission-agent-0.7.0.mjs",
);
let source = await readFile(sourcePath, "utf8");

source = source.replace(
  'const VERSION = "0.6.9";',
  `const VERSION = "0.7.0";
const BUILD_SOURCE_COMMIT = "${sourceCommit}";
const RELEASE_AUTHORITY_VERSION = "2";
const RELEASE_MANIFEST_VERSION = "2";
const RELEASE_TRUST_STORE = Object.freeze({
  "mission-agent-release-2026-00": Object.freeze({
    keyId: "mission-agent-release-2026-00",
    algorithm: "Ed25519",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEAkJJvbXaL3hnwifCZ/nyTD9z3oNWyJRCjxxfjXMWhVwo=",
    publicKeyFingerprint: "ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a",
    status: "retiring",
    purpose: "mission-agent-release",
    activatedAt: "2026-07-25T12:14:48.000Z",
    retiresAt: null,
    revokedAt: null,
  }),
  // RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT
});`,
);

const legacyVerifierStart = source.indexOf("const RELEASE_PUBLIC_KEY = createPublicKey({");
const legacyVerifierEnd = source.indexOf("\nconst exec =", legacyVerifierStart);
if (legacyVerifierStart < 0 || legacyVerifierEnd < 0) throw new Error("Mission Agent 0.6.9 release verifier changed");
source =
  source.slice(0, legacyVerifierStart) +
  String.raw`const LEGACY_RELEASE_PUBLIC_KEY = createPublicKey({
  key: Buffer.from("MCowBQYDK2VwAyEAkJJvbXaL3hnwifCZ/nyTD9z3oNWyJRCjxxfjXMWhVwo=", "base64"),
  format: "der",
  type: "spki",
});
const RELEASE_MANIFEST_V2_FIELDS = [
  "activationProtocolVersion", "agentVersion", "artifactPath", "artifactSha256", "buildId", "createdAt",
  "expiresAt", "identityProtocolVersion", "manifestVersion", "minimumMissionControlVersion",
  "signingKeyId", "sourceCommit",
];
function releasePublicKeyFingerprint(spkiBase64) {
  return "ed25519-spki-sha256:" + sha256(Buffer.from(spkiBase64, "base64"));
}
function validateReleaseTrustStore(store = RELEASE_TRUST_STORE) {
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("Release trust store is malformed.");
  const fingerprints = new Set();
  for (const [keyId, key] of Object.entries(store)) {
    if (keyId !== key?.keyId || !/^mission-agent-release-\d{4}-\d{2}$/.test(keyId) ||
        key.algorithm !== "Ed25519" || key.purpose !== "mission-agent-release" ||
        !["pending", "active", "retiring", "retired", "revoked"].includes(key.status))
      throw new Error("Release trust store is malformed.");
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519" ||
        releasePublicKeyFingerprint(key.publicKeySpkiBase64) !== key.publicKeyFingerprint ||
        fingerprints.has(key.publicKeyFingerprint) ||
        (key.status === "active" && !key.activatedAt) || (key.status === "revoked" && !key.revokedAt))
      throw new Error("Release trust store is malformed.");
    fingerprints.add(key.publicKeyFingerprint);
  }
  return store;
}
function parseReleaseManifestV2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release manifest v2 is malformed.");
  const keys = Object.keys(value).sort();
  if (keys.join("\n") !== [...RELEASE_MANIFEST_V2_FIELDS].sort().join("\n"))
    throw new Error("Release manifest v2 fields are malformed.");
  if (value.manifestVersion !== "2" || !/^\d+\.\d+\.\d+$/.test(value.agentVersion) ||
      value.artifactPath !== "/mission-agent-" + value.agentVersion + ".mjs" ||
      !/^[a-f0-9]{64}$/.test(value.artifactSha256) || !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
      !/^mission-agent-release-\d{4}-\d{2}$/.test(value.signingKeyId) ||
      value.identityProtocolVersion !== "2" || value.activationProtocolVersion !== "1" ||
      !/^\d+\.\d+\.\d+$/.test(value.minimumMissionControlVersion) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.buildId) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt))
    throw new Error("Release manifest v2 is malformed.");
  return value;
}
function verifyReleaseManifestV2(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("Signed release manifest is malformed.");
  const { signature, ...unsigned } = bundle;
  const manifest = parseReleaseManifestV2(unsigned);
  const store = validateReleaseTrustStore(options.trustStore);
  const key = store[manifest.signingKeyId];
  if (!key || key.status !== "active") throw new Error("Release signing key is not active.");
  const now = options.now ?? new Date();
  if (key.activatedAt && Date.parse(key.activatedAt) > now.getTime()) throw new Error("Release signing key is not active.");
  if (key.retiresAt && Date.parse(key.retiresAt) <= now.getTime()) throw new Error("Release signing key is retired.");
  if (Date.parse(manifest.expiresAt) <= now.getTime()) throw new Error("Release manifest is expired.");
  if (typeof signature !== "string") throw new Error("Release manifest signature is malformed.");
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature)
    throw new Error("Release manifest signature is not canonical Ed25519 base64.");
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
  if (!verifySignature(null, Buffer.from(canonicalJson(manifest)), publicKey, signatureBytes))
    throw new Error("Release manifest signature verification failed.");
  return {
    version: manifest.agentVersion, path: manifest.artifactPath, sha256: manifest.artifactSha256,
    manifestVersion: manifest.manifestVersion, signingKeyId: manifest.signingKeyId,
    releaseAuthorityVersion: RELEASE_AUTHORITY_VERSION, sourceCommit: manifest.sourceCommit,
    identityProtocolVersion: manifest.identityProtocolVersion,
    activationProtocolVersion: manifest.activationProtocolVersion,
  };
}
function verifyLegacyReleaseManifest(manifest, allowRollbackVersion) {
  const signed = { version: manifest?.version, path: manifest?.path, sha256: manifest?.sha256, manifestVersion: manifest?.manifestVersion };
  if (allowRollbackVersion !== "0.6.8" || signed.version !== "0.6.8" ||
      signed.path !== "/mission-agent-0.6.8.mjs" ||
      signed.sha256 !== "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d" ||
      signed.manifestVersion !== "1" || typeof manifest.signature !== "string" ||
      !verifySignature(null, Buffer.from(canonicalJson(signed)), LEGACY_RELEASE_PUBLIC_KEY, Buffer.from(manifest.signature, "base64")))
    throw new Error("Governed legacy rollback manifest verification failed.");
  return signed;
}
function verifyReleaseManifestText(text, options = {}) {
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error("Update manifest JSON is invalid."); }
  if (bundle?.manifestVersion === "1") return verifyLegacyReleaseManifest(bundle, options.allowRollbackVersion);
  if (text.trim() !== canonicalJson(bundle)) throw new Error("Release manifest is not canonical.");
  return verifyReleaseManifestV2(bundle, options);
}
function verifyReleaseManifest(manifest, options = {}) {
  if (manifest?.manifestVersion === "1") return verifyLegacyReleaseManifest(manifest, options.allowRollbackVersion);
  return verifyReleaseManifestV2(manifest, options);
}` +
  source.slice(legacyVerifierEnd);

source = source.replace(
  `metadata?.manifestVersion !== "1" ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.sha256 ?? ""))`,
  `metadata?.manifestVersion !== "2" ||
    metadata?.releaseAuthorityVersion !== "2" ||
    metadata?.signingKeyId !== "mission-agent-release-2026-01" ||
    metadata?.sourceCommit !== BUILD_SOURCE_COMMIT ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.sha256 ?? ""))`,
);
source = source.replace(
  `    manifestVersion: metadata.manifestVersion,
  };`,
  `    manifestVersion: metadata.manifestVersion,
    signingKeyId: metadata.signingKeyId,
    releaseAuthorityVersion: metadata.releaseAuthorityVersion,
    sourceCommit: metadata.sourceCommit,
  };`,
);

source = source.replace(
  `    artifact,
    repositoryIdentity: {`,
  `    artifact,
    release: {
      authorityVersion: RELEASE_AUTHORITY_VERSION,
      manifestVersion: RELEASE_MANIFEST_VERSION,
      signingKeyId: artifact.signingKeyId,
      sourceCommit: BUILD_SOURCE_COMMIT,
    },
    repositoryIdentity: {`,
);

const repositoryLookup = `  const repository = config.repositories?.[request.repositoryId];
  if (`;
source = source.replace(
  repositoryLookup,
  `  const repository = config.repositories?.[request.repositoryId];
  if (config.repositoryIdentityMigrations?.[request.repositoryId] || repository?.identityTransition?.status)
    throw new Error("Repository identity transition dispatch barrier is active.");
  if (`,
);
source = source.replace(
  `  if (!repository) throw new Error("The assignment repository is not registered on this Mission Agent.");`,
  `  if (!repository) throw new Error("The assignment repository is not registered on this Mission Agent.");
  if (config.repositoryIdentityMigrations?.[resource.resourceId] || repository.identityTransition?.status)
    throw new Error("Repository identity transition dispatch barrier is active.");`,
);
source = source.replaceAll(
  `repository.localActivation = { requestId: request.requestId, activatedAt: new Date().toISOString(),`,
  `repository.identityTransition = { status: "activating", migrationId: pending.migrationId, requestId: request.requestId };
  repository.localActivation = { requestId: request.requestId, activatedAt: new Date().toISOString(),`,
);
source = source.replace(
  `  await registerRepository(config, repository.path);
  delete config.repositoryIdentityMigrations[repositoryId];`,
  `  if (acknowledgement.status !== "accepted") throw new Error("Stable identity activation acknowledgement was not accepted.");
  delete repository.identityTransition;
  await registerRepository(config, repository.path);
  delete config.repositoryIdentityMigrations[repositoryId];`,
);

source = source.replace(
  `  const manifest = await response.json();
  const verifiedManifest = verifyReleaseManifest(manifest, true);
  if (verifiedManifest.version === VERSION) return console.log(\`Mission Agent \${VERSION} is current.\`);`,
  `  const manifestText = await response.text();
  const allowRollbackVersion = option("--allow-rollback-version");
  const verifiedManifest = verifyReleaseManifestText(manifestText, { allowRollbackVersion });
  if (verifiedManifest.version === VERSION) return console.log(\`Mission Agent \${VERSION} is current.\`);
  const next = verifiedManifest.version.split(".").map(Number);
  const current = VERSION.split(".").map(Number);
  const newer = next.some((part, index) => part > current[index] && next.slice(0, index).every((value, prior) => value === current[prior]));
  if (!newer && verifiedManifest.version !== allowRollbackVersion)
    throw new Error("Release manifest downgrade requires an explicit governed rollback version.");`,
);
source = source.replace(
  `    verifiedManifest.manifestVersion !== "1" ||
    !/^[a-f0-9]{64}$/.test(String(verifiedManifest.sha256 ?? ""))`,
  `    !["1", "2"].includes(verifiedManifest.manifestVersion) ||
    !/^[a-f0-9]{64}$/.test(String(verifiedManifest.sha256 ?? ""))`,
);
source = source.replace(
  `      manifestVersion: verifiedManifest.manifestVersion,
    })`,
  `      manifestVersion: verifiedManifest.manifestVersion,
      ...(verifiedManifest.manifestVersion === "2" ? {
        signingKeyId: verifiedManifest.signingKeyId,
        releaseAuthorityVersion: verifiedManifest.releaseAuthorityVersion,
        sourceCommit: verifiedManifest.sourceCommit,
      } : {}),
    })`,
);

source = source.replace(
  `  verifyReleaseManifest,`,
  `  parseReleaseManifestV2,
  validateReleaseTrustStore,
  verifyReleaseManifest,
  verifyReleaseManifestText,
  verifyReleaseManifestV2,`,
);

if (source.includes('const VERSION = "0.6.9";') || !source.includes("RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT"))
  throw new Error("Mission Agent 0.7.0 transformation was incomplete");
await writeFile(targetPath, source, { mode: 0o700 });
