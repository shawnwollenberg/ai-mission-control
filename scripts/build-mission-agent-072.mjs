import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceCommitIndex = process.argv.indexOf("--source-commit");
const sourceCommit = sourceCommitIndex >= 0 ? process.argv[sourceCommitIndex + 1] : undefined;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("Provide --source-commit as a full lowercase Git SHA");

const sourcePath = resolve("public/mission-agent-0.7.1.mjs");
const targetPath = resolve(
  process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : "public/mission-agent-0.7.2.mjs",
);
let source = await readFile(sourcePath, "utf8");

source = source
  .replace('const VERSION = "0.7.1";', 'const VERSION = "0.7.2";')
  .replace(/const BUILD_SOURCE_COMMIT = "[a-f0-9]{40}";/, `const BUILD_SOURCE_COMMIT = "${sourceCommit}";`)
  .replace(
    'const RELEASE_MANIFEST_VERSION = "2";',
    `const RELEASE_MANIFEST_VERSION = "3";
const RELEASE_CANONICALIZATION_VERSION = "release-manifest-json-v3";`,
  )
  .replace(
    'manifestVersion: "2",\n    bootstrap: "production-trust-root-0.7.1"',
    `manifestVersion: "3",
    bootstrap: "production-trust-root-0.7.2"`,
  );

source = source
  .replace(
    `    metadata?.manifestVersion !== "2" ||
    metadata?.releaseAuthorityVersion !== "2" ||
    metadata?.signingKeyId !== "mission-agent-release-2026-01" ||
    metadata?.sourceCommit !== BUILD_SOURCE_COMMIT ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.sha256 ?? ""))`,
    `    metadata?.manifestVersion !== "3" ||
    metadata?.releaseAuthorityVersion !== "v2" ||
    metadata?.canonicalizationVersion !== RELEASE_CANONICALIZATION_VERSION ||
    metadata?.signingKeyId !== "mission-agent-release-2026-01" ||
    metadata?.publicKeyFingerprint !== RELEASE_TRUST_STORE["mission-agent-release-2026-01"].publicKeyFingerprint ||
    metadata?.sourceCommit !== BUILD_SOURCE_COMMIT ||
    !Number.isSafeInteger(metadata?.artifactByteLength) ||
    metadata.artifactByteLength <= 0 ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.sha256 ?? ""))`,
  )
  .replace(
    `  if (sha256(await readFile(sourceArtifactPath)) !== metadata.sha256)
    throw new Error("Mission Agent executable does not match immutable artifact metadata.");`,
    `  const artifactBytes = await readFile(sourceArtifactPath);
  if (artifactBytes.byteLength !== metadata.artifactByteLength || sha256(artifactBytes) !== metadata.sha256)
    throw new Error("Mission Agent executable does not match immutable artifact metadata.");`,
  )
  .replace(
    `    signingKeyId: metadata.signingKeyId,
    releaseAuthorityVersion: metadata.releaseAuthorityVersion,
    sourceCommit: metadata.sourceCommit,`,
    `    artifactByteLength: metadata.artifactByteLength,
    signingKeyId: metadata.signingKeyId,
    publicKeyFingerprint: metadata.publicKeyFingerprint,
    releaseAuthorityVersion: metadata.releaseAuthorityVersion,
    canonicalizationVersion: metadata.canonicalizationVersion,
    sourceCommit: metadata.sourceCommit,`,
  );

const insertionPoint = "\nfunction verifyLegacyReleaseManifest(manifest, allowRollbackVersion) {";
const v3Verifier = String.raw`
const RELEASE_MANIFEST_V3_FIELDS = [
  "artifactByteLength", "artifactName", "artifactSha256", "build", "canonicalizationVersion",
  "compatibility", "createdAt", "expiresAt", "manifestVersion", "platform",
  "provenance", "publicKeyFingerprint", "releaseAuthorityVersion", "releaseVersion", "signingKeyId",
];
const RELEASE_MANIFEST_V3_BUILD_FIELDS = ["buildId", "sourceCommit"];
const RELEASE_MANIFEST_V3_COMPATIBILITY_FIELDS = [
  "activationProtocolVersion", "identityProtocolVersion", "minimumMissionControlVersion",
];
const RELEASE_MANIFEST_V3_PLATFORM_FIELDS = [
  "architecture", "artifactFormat", "operatingSystem", "runtime", "runtimeMajorVersion",
];
const RELEASE_MANIFEST_V3_PROVENANCE_FIELDS = [
  "builderSha256", "containerImageDigest", "manifestSchemaSha256", "nodeVersion",
  "packageLockSha256", "reproducibilityEvidenceSha256",
];
function exactReleaseFields(record, fields) {
  return Object.keys(record).sort().join("\n") === [...fields].sort().join("\n");
}
function assertCanonicalReleaseUnicode(value) {
  if (typeof value === "string" && value.normalize("NFC") !== value)
    throw new Error("Release manifest strings must use Unicode NFC.");
  if (Array.isArray(value)) for (const item of value) assertCanonicalReleaseUnicode(item);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key.normalize("NFC") !== key) throw new Error("Release manifest keys must use Unicode NFC.");
      assertCanonicalReleaseUnicode(item);
    }
}
function assertNoDuplicateReleaseJsonKeys(text) {
  const stack = [];
  let index = 0;
  let expectingKey = false;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index++;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        if (!escaped && current === '"') break;
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
        index++;
      }
      if (index >= text.length) throw new Error("Release manifest JSON string is unterminated.");
      const literal = text.slice(start, index + 1);
      let after = index + 1;
      while (/\s/.test(text[after] ?? "")) after++;
      if (expectingKey && text[after] === ":") {
        const key = JSON.parse(literal);
        const keys = stack.at(-1);
        if (!(keys instanceof Set) || keys.has(key)) throw new Error("Release manifest contains a duplicate field.");
        keys.add(key);
        expectingKey = false;
      }
      index++;
      continue;
    }
    if (character === "{") { stack.push(new Set()); expectingKey = true; }
    else if (character === "[") { stack.push(null); expectingKey = false; }
    else if (character === "}" || character === "]") { stack.pop(); expectingKey = false; }
    else if (character === "," && stack.at(-1) instanceof Set) expectingKey = true;
    index++;
  }
}
function parseReleaseManifestV3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactReleaseFields(value, RELEASE_MANIFEST_V3_FIELDS) ||
      !value.build || typeof value.build !== "object" || Array.isArray(value.build) ||
      !value.compatibility || typeof value.compatibility !== "object" || Array.isArray(value.compatibility) ||
      !value.platform || typeof value.platform !== "object" || Array.isArray(value.platform) ||
      !value.provenance || typeof value.provenance !== "object" || Array.isArray(value.provenance) ||
      !exactReleaseFields(value.build, RELEASE_MANIFEST_V3_BUILD_FIELDS) ||
      !exactReleaseFields(value.compatibility, RELEASE_MANIFEST_V3_COMPATIBILITY_FIELDS) ||
      !exactReleaseFields(value.platform, RELEASE_MANIFEST_V3_PLATFORM_FIELDS) ||
      !exactReleaseFields(value.provenance, RELEASE_MANIFEST_V3_PROVENANCE_FIELDS))
    throw new Error("Release manifest v3 fields are malformed.");
  if (value.manifestVersion !== "3" || value.releaseAuthorityVersion !== "v2" ||
      value.canonicalizationVersion !== RELEASE_CANONICALIZATION_VERSION ||
      !/^\d+\.\d+\.\d+$/.test(value.releaseVersion) ||
      value.artifactName !== "mission-agent-" + value.releaseVersion + ".mjs" ||
      !/^[a-f0-9]{64}$/.test(value.artifactSha256) ||
      !Number.isSafeInteger(value.artifactByteLength) || value.artifactByteLength <= 0 ||
      !/^[a-f0-9]{40}$/.test(value.build.sourceCommit) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.build.buildId) ||
      !/^mission-agent-release-\d{4}-\d{2}$/.test(value.signingKeyId) ||
      !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(value.publicKeyFingerprint) ||
      value.platform.runtime !== "node" || value.platform.runtimeMajorVersion !== 22 ||
      value.platform.operatingSystem !== "darwin-linux" || value.platform.architecture !== "universal" ||
      value.platform.artifactFormat !== "esm" ||
      value.compatibility.identityProtocolVersion !== "2" ||
      value.compatibility.activationProtocolVersion !== "1" ||
      value.compatibility.minimumMissionControlVersion !== "0.1.0" ||
      !/^[a-f0-9]{64}$/.test(value.provenance.builderSha256) ||
      !/^node@sha256:[a-f0-9]{64}$/.test(value.provenance.containerImageDigest) ||
      !/^[a-f0-9]{64}$/.test(value.provenance.manifestSchemaSha256) ||
      value.provenance.nodeVersion !== "22.22.0" ||
      !/^[a-f0-9]{64}$/.test(value.provenance.packageLockSha256) ||
      !/^[a-f0-9]{64}$/.test(value.provenance.reproducibilityEvidenceSha256) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt))
    throw new Error("Release manifest v3 is malformed.");
  assertCanonicalReleaseUnicode(value);
  return value;
}
function assertReleasePlatformEligibility(manifest, runtime = {
  nodeMajorVersion: Number(process.versions.node.split(".")[0]),
  operatingSystem: platform(),
  architecture: process.arch,
}) {
  if (runtime.nodeMajorVersion !== manifest.platform.runtimeMajorVersion ||
      !manifest.platform.operatingSystem.split("-").includes(runtime.operatingSystem) ||
      !["arm64", "x64"].includes(runtime.architecture) ||
      manifest.platform.architecture !== "universal")
    throw new Error("Release platform is incompatible with this Mission Agent runtime.");
}
function canonicalReleaseManifestV3(value) {
  return canonicalJson(parseReleaseManifestV3(value));
}
function verifyReleaseManifestV3(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    throw new Error("Signed release manifest v3 is malformed.");
  const { signature, ...unsigned } = bundle;
  if (typeof signature !== "string" || !signature) throw new Error("Release manifest signature is required.");
  const manifest = parseReleaseManifestV3(unsigned);
  assertReleasePlatformEligibility(manifest);
  if (options.trustStore && options.allowTestTrustStoreOverride !== true)
    throw new Error("External release trust-store override is not authorized.");
  const store = validateReleaseTrustStore(
    options.allowTestTrustStoreOverride === true ? options.trustStore : undefined,
  );
  const key = store[manifest.signingKeyId];
  if (!key || key.keyId !== manifest.signingKeyId || key.status !== "active")
    throw new Error("Release signing key is not active.");
  const derivedFingerprint = releasePublicKeyFingerprint(key.publicKeySpkiBase64);
  if (key.publicKeyFingerprint !== manifest.publicKeyFingerprint ||
      derivedFingerprint !== manifest.publicKeyFingerprint)
    throw new Error("Release signing key fingerprint mismatch.");
  const now = options.now ?? new Date();
  if (key.activatedAt && Date.parse(key.activatedAt) > now.getTime())
    throw new Error("Release signing key is not active.");
  if (key.retiresAt && Date.parse(key.retiresAt) <= now.getTime())
    throw new Error("Release signing key is retired.");
  if (Date.parse(manifest.expiresAt) <= now.getTime()) throw new Error("Release manifest is expired.");
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature)
    throw new Error("Release manifest signature is not canonical Ed25519 base64.");
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, "base64"), format: "der", type: "spki",
  });
  if (!verifySignature(null, Buffer.from(canonicalReleaseManifestV3(manifest), "utf8"), publicKey, signatureBytes))
    throw new Error("Release manifest signature verification failed.");
  return {
    version: manifest.releaseVersion,
    path: "/" + manifest.artifactName,
    sha256: manifest.artifactSha256,
    artifactByteLength: manifest.artifactByteLength,
    manifestVersion: manifest.manifestVersion,
    signingKeyId: manifest.signingKeyId,
    publicKeyFingerprint: manifest.publicKeyFingerprint,
    releaseAuthorityVersion: manifest.releaseAuthorityVersion,
    canonicalizationVersion: manifest.canonicalizationVersion,
    sourceCommit: manifest.build.sourceCommit,
    identityProtocolVersion: manifest.compatibility.identityProtocolVersion,
    activationProtocolVersion: manifest.compatibility.activationProtocolVersion,
    platform: manifest.platform,
  };
}
`;
if (!source.includes(insertionPoint)) throw new Error("Mission Agent 0.7.1 verifier insertion point changed");
source = source.replace(insertionPoint, `${v3Verifier}${insertionPoint}`);

const oldTextRouter = `function verifyReleaseManifestText(text, options = {}) {
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error("Update manifest JSON is invalid."); }
  if (bundle?.manifestVersion === "1") return verifyLegacyReleaseManifest(bundle, options.allowRollbackVersion);
  if (text.trim() !== canonicalJson(bundle)) throw new Error("Release manifest is not canonical.");
  return verifyReleaseManifestV2(bundle, options);
}
function verifyReleaseManifest(manifest, options = {}) {
  if (manifest?.manifestVersion === "1") return verifyLegacyReleaseManifest(manifest, options.allowRollbackVersion);
  return verifyReleaseManifestV2(manifest, options);
}`;
const newTextRouter = `function verifyReleaseManifestText(text, options = {}) {
  assertNoDuplicateReleaseJsonKeys(text);
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error("Update manifest JSON is invalid."); }
  if (bundle?.manifestVersion === "1") return verifyLegacyReleaseManifest(bundle, options.allowRollbackVersion);
  if (bundle?.manifestVersion === "2") {
    if (options.allowHistoricalManifestV2 !== true)
      throw new Error("New production releases require Manifest v3.");
    if (text !== canonicalJson(bundle)) throw new Error("Historical release manifest is not canonical.");
    return verifyReleaseManifestV2(bundle, options);
  }
  if (bundle?.manifestVersion !== "3") throw new Error("Unsupported release manifest version.");
  if (text !== canonicalJson(bundle)) throw new Error("Release manifest v3 is not canonical.");
  return verifyReleaseManifestV3(bundle, options);
}
function verifyReleaseManifest(manifest, options = {}) {
  if (manifest?.manifestVersion === "1") return verifyLegacyReleaseManifest(manifest, options.allowRollbackVersion);
  if (manifest?.manifestVersion === "2") {
    if (options.allowHistoricalManifestV2 !== true)
      throw new Error("New production releases require Manifest v3.");
    return verifyReleaseManifestV2(manifest, options);
  }
  if (manifest?.manifestVersion !== "3") throw new Error("Unsupported release manifest version.");
  return verifyReleaseManifestV3(manifest, options);
}`;
if (!source.includes(oldTextRouter)) throw new Error("Mission Agent 0.7.1 release router changed");
source = source.replace(oldTextRouter, newTextRouter);

source = source
  .replace(
    `    release: {
      authorityVersion: RELEASE_AUTHORITY_VERSION,
      manifestVersion: RELEASE_MANIFEST_VERSION,
      signingKeyId: artifact.signingKeyId,
      sourceCommit: BUILD_SOURCE_COMMIT,
    },`,
    `    release: {
      authorityVersion: "v2",
      manifestVersion: RELEASE_MANIFEST_VERSION,
      canonicalizationVersion: RELEASE_CANONICALIZATION_VERSION,
      minimumProductionManifestVersion: "3",
      historicalManifestVersions: ["1", "2"],
      signingKeyId: artifact.signingKeyId,
      publicKeyFingerprint: RELEASE_TRUST_STORE["mission-agent-release-2026-01"].publicKeyFingerprint,
      sourceCommit: BUILD_SOURCE_COMMIT,
    },`,
  )
  .replace(
    `  if (sha256(source) !== verifiedManifest.sha256) throw new Error("Update checksum verification failed.");`,
    `  if (verifiedManifest.manifestVersion === "3" &&
      Buffer.byteLength(source, "utf8") !== verifiedManifest.artifactByteLength)
    throw new Error("Update artifact byte-length verification failed.");
  if (sha256(source) !== verifiedManifest.sha256) throw new Error("Update checksum verification failed.");`,
  )
  .replace(
    `    !["1", "2"].includes(verifiedManifest.manifestVersion) ||`,
    `    !["1", "3"].includes(verifiedManifest.manifestVersion) ||`,
  )
  .replace(
    `      ...(verifiedManifest.manifestVersion === "2" ? {
        signingKeyId: verifiedManifest.signingKeyId,
        releaseAuthorityVersion: verifiedManifest.releaseAuthorityVersion,
        sourceCommit: verifiedManifest.sourceCommit,
      } : {}),`,
    `      ...(verifiedManifest.manifestVersion === "3" ? {
        artifactByteLength: verifiedManifest.artifactByteLength,
        signingKeyId: verifiedManifest.signingKeyId,
        publicKeyFingerprint: verifiedManifest.publicKeyFingerprint,
        releaseAuthorityVersion: verifiedManifest.releaseAuthorityVersion,
        canonicalizationVersion: verifiedManifest.canonicalizationVersion,
        sourceCommit: verifiedManifest.sourceCommit,
        platform: verifiedManifest.platform,
      } : {}),`,
  )
  .replace(
    `  verifyReleaseManifestV2,`,
    `  verifyReleaseManifestV2,
  verifyReleaseManifestV3,
  parseReleaseManifestV3,
  canonicalReleaseManifestV3,
  assertReleasePlatformEligibility,`,
  );

if (
  source.includes('const VERSION = "0.7.1";') ||
  !source.includes('const VERSION = "0.7.2";') ||
  !source.includes('const RELEASE_MANIFEST_VERSION = "3";') ||
  !source.includes("production-trust-root-0.7.2") ||
  !source.includes("function verifyReleaseManifestV3") ||
  !source.includes("New production releases require Manifest v3.") ||
  !source.includes("Update artifact byte-length verification failed.")
)
  throw new Error("Mission Agent 0.7.2 transformation was incomplete");

await writeFile(targetPath, source, { mode: 0o700 });
