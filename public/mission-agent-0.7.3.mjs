#!/usr/bin/env node
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.7.3";
const BUILD_SOURCE_COMMIT = "f6ffb3a5702e6a9bc4e4f3ca3c4055427d14fafd";
const RELEASE_AUTHORITY_VERSION = "2";
const RELEASE_MANIFEST_VERSION = "3";
const RELEASE_CANONICALIZATION_VERSION = "release-manifest-json-v3";
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
  "mission-agent-release-2026-01": Object.freeze({
    keyId: "mission-agent-release-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEAvSkEoddFoGfJn2PauL+KEl4ykZ+5WM5B2PklJOZOAKE=",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
    status: "active",
    purpose: "mission-agent-release",
    signingAlgorithm: "ED25519_SHA_512",
    releaseAuthorityVersion: "2",
    manifestVersion: "3",
    bootstrap: "production-trust-root-0.7.2",
    activatedAt: "2026-07-27T16:00:31.000Z",
    retiresAt: null,
    revokedAt: null,
  }),
  // RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT
});
const root = process.env.MISSION_AGENT_HOME ?? join(homedir(), ".mission-agent");
const configPath = join(root, "config.json");
const statePath = join(root, "state.json");
const scriptPath = join(root, `mission-agent-${VERSION}.mjs`);
const artifactMetadataPath = `${scriptPath}.artifact.json`;
const sourceArtifactPath = fileURLToPath(import.meta.url);
const sourceArtifactMetadataPath = `${sourceArtifactPath}.artifact.json`;
const binDirectory = process.env.MISSION_AGENT_BIN_DIR ?? join(homedir(), ".local", "bin");
const launcherPath = join(binDirectory, "mission-agent");
const command = process.argv[2] ?? "status";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const equalChecksum = (left, right) =>
  /^[a-f0-9]{64}$/.test(String(left)) &&
  /^[a-f0-9]{64}$/.test(String(right)) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const LEGACY_RELEASE_PUBLIC_KEY = createPublicKey({
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
        (key.status === "pending" && (key.activatedAt || key.retiresAt || key.revokedAt)) ||
        (key.status === "active" && (!key.activatedAt || key.revokedAt)) ||
        (key.status === "retiring" && (!key.activatedAt || key.revokedAt)) ||
        (key.status === "retired" && (!key.activatedAt || !key.retiresAt || key.revokedAt)) ||
        (key.status === "revoked" && !key.revokedAt))
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
  if (options.trustStore && options.allowTestTrustStoreOverride !== true)
    throw new Error("External release trust-store override is not authorized.");
  const store = validateReleaseTrustStore(
    options.allowTestTrustStoreOverride === true ? options.trustStore : undefined,
  );
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
}
const exec = (binary, args, cwd) => {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    if (binary === "git" && result.error?.code === "ENOENT") {
      throw new Error("Git is not installed or is not available on PATH.");
    }
    if (binary === "git" && /not a git repository/i.test(result.stderr ?? "")) {
      throw new Error(
        "No Git repository was found. Run this command from inside a Git repository or provide --repository /absolute/path/to/repository.",
      );
    }
    throw new Error(`${binary} returned an error${result.stderr?.trim() ? `: ${result.stderr.trim()}` : "."}`);
  }
  return result.stdout.trim();
};

async function protectedJson(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`Unsafe permissions on ${path}; expected 0600.`);
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path, value) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
async function artifactIdentity(path = sourceArtifactMetadataPath) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Mission Agent immutable artifact metadata is missing.");
  }
  if (
    metadata?.version !== VERSION ||
    metadata?.manifestVersion !== "3" ||
    metadata?.releaseAuthorityVersion !== "v2" ||
    metadata?.canonicalizationVersion !== RELEASE_CANONICALIZATION_VERSION ||
    metadata?.signingKeyId !== "mission-agent-release-2026-01" ||
    metadata?.publicKeyFingerprint !== RELEASE_TRUST_STORE["mission-agent-release-2026-01"].publicKeyFingerprint ||
    metadata?.sourceCommit !== BUILD_SOURCE_COMMIT ||
    !Number.isSafeInteger(metadata?.artifactByteLength) ||
    metadata.artifactByteLength <= 0 ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.sha256 ?? ""))
  )
    throw new Error("Mission Agent immutable artifact metadata is invalid.");
  const artifactBytes = await readFile(sourceArtifactPath);
  if (artifactBytes.byteLength !== metadata.artifactByteLength || sha256(artifactBytes) !== metadata.sha256)
    throw new Error("Mission Agent executable does not match immutable artifact metadata.");
  return {
    sha256: metadata.sha256,
    manifestVersion: metadata.manifestVersion,
    artifactByteLength: metadata.artifactByteLength,
    signingKeyId: metadata.signingKeyId,
    publicKeyFingerprint: metadata.publicKeyFingerprint,
    releaseAuthorityVersion: metadata.releaseAuthorityVersion,
    canonicalizationVersion: metadata.canonicalizationVersion,
    sourceCommit: metadata.sourceCommit,
  };
}
function keychainSecret(agentId) {
  const result = spawnSync("security", ["find-generic-password", "-a", agentId, "-s", "Mission Agent", "-w"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("Mission Agent credential is missing from macOS Keychain.");
  return result.stdout.trim();
}
async function loadConfig() {
  const config = await protectedJson(configPath);
  config.secret = config.secretStorage === "keychain" ? keychainSecret(config.agentId) : config.secret;
  if (!config.secret) throw new Error("Mission Agent credential is missing.");
  return config;
}
let stateMutationQueue = Promise.resolve();
async function updateState(patch) {
  const mutation = stateMutationQueue.then(async () => {
    let current = {};
    try {
      current = await protectedJson(statePath);
    } catch {}
    await save(statePath, { ...current, ...patch, updatedAt: new Date().toISOString(), version: VERSION });
  });
  stateMutationQueue = mutation.catch(() => undefined);
  return mutation;
}
async function markProjectBrainReceiptAcknowledged(idempotencyKey) {
  const current = await protectedJson(statePath);
  const receipt = current.projectBrainReceipts?.[idempotencyKey];
  if (!receipt) return;
  await updateState({
    projectBrainReceipts: {
      ...(current.projectBrainReceipts ?? {}),
      [idempotencyKey]: { ...receipt, centralAcknowledged: true },
    },
  });
}

function envelope(config, messageType, payload, execution) {
  const messageId = randomUUID();
  return {
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: `${messageType}:${messageId}`,
    agentId: config.agentId,
    workspaceId: config.workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: execution?.missionId ?? config.agentId,
    ...(execution
      ? {
          missionId: execution.missionId,
          taskId: execution.taskId,
          executionId: execution.executionId,
          attempt: execution.attempt,
        }
      : {}),
    payload,
  };
}
async function signedRequest(config, path, messageType, payload = {}, execution, lease) {
  const message = envelope(config, messageType, payload, execution);
  const body = JSON.stringify(message);
  const checksum = sha256(body);
  const nonce = randomBytes(18).toString("base64url");
  const signingKey = sha256(config.secret);
  const signature = createHmac("sha256", signingKey)
    .update(["POST", path, message.sentAt, nonce, message.messageId, checksum, "1.0"].join("\n"))
    .digest("hex");
  const response = await fetch(`${config.missionControlUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(messageType === "AgentAssignmentPullRequested" ? 25_000 : 15_000),
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": config.agentId,
      "x-mc-credential-id": config.credentialId,
      "x-mc-timestamp": message.sentAt,
      "x-mc-nonce": nonce,
      "x-mc-message-id": message.messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": checksum,
      "x-mc-signature": signature,
      ...(lease
        ? {
            "x-mc-assignment-id": lease.assignmentId,
            "x-mc-lease-owner": lease.leaseOwner,
            "x-mc-lease-token": lease.leaseToken,
          }
        : {}),
    },
    body,
  });
  if (response.status === 204) return undefined;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? `Mission Control returned ${response.status}.`);
  return result;
}
function callbackConfirmsTerminal(response, messageType) {
  const status = response?.result?.status ?? response?.result?.result?.status;
  return status === (messageType === "RemoteProjectBrainOperationSucceeded" ? "succeeded" : "failed");
}

async function heartbeat(config) {
  const projectBrain = projectBrainCapabilities(config);
  const artifact = await artifactIdentity();
  await signedRequest(config, "/api/agent-protocol/v1/messages", "AgentHeartbeat", {
    status: "ready",
    assignmentPull: true,
    missionAgentVersion: VERSION,
    adapter: config.adapter,
    platform: platform(),
    capabilities: config.capabilities,
    artifact,
    release: {
      authorityVersion: "v2",
      manifestVersion: RELEASE_MANIFEST_VERSION,
      canonicalizationVersion: RELEASE_CANONICALIZATION_VERSION,
      minimumProductionManifestVersion: "3",
      historicalManifestVersions: ["1", "2"],
      signingKeyId: artifact.signingKeyId,
      publicKeyFingerprint: RELEASE_TRUST_STORE["mission-agent-release-2026-01"].publicKeyFingerprint,
      sourceCommit: BUILD_SOURCE_COMMIT,
    },
    repositoryIdentity: {
      supportedVersions: ["legacy-v1", "stable-v2"],
      stableProtocolVersion: "2",
      activationAcknowledgementVersion: "1",
      repositories: Object.entries(config.repositories ?? {}).map(([repositoryId, repository]) => ({
        repositoryId,
        identityVersion: repository.identityVersion ?? "legacy-v1",
        fingerprint: repository.fingerprint,
        transitionStatus: repository.identityTransition?.status ?? null,
      })),
    },
    ...(projectBrain ? { projectBrain } : {}),
  });
  await updateState({ connected: true, pullReady: true, lastHeartbeatAt: new Date().toISOString(), lastError: null });
}
const projectBrainOperations = [
  "detect_repository",
  "initialize_repository",
  "validate_repository",
  "get_summary",
  "prepare_context",
  "read_context",
  "record_closure",
  "propose_learning",
  "evaluate_learning",
  "get_curation",
  "list_knowledge",
  "get_health",
  "diagnostics",
];
const projectBrainWriteOperations = [
  "initialize_repository",
  "prepare_context",
  "record_closure",
  "propose_learning",
  "evaluate_learning",
];
function validRemoteProjectBrainRequestShape(request) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sha = /^[a-f0-9]{40,64}$/;
  const requestedAt = Date.parse(String(request.requestedAt ?? ""));
  const expiresAt = Date.parse(String(request.expiresAt ?? ""));
  return (
    request.protocolVersion === "1.0" &&
    [request.requestId, request.operationId, request.workspaceId, request.agentId, request.repositoryId].every(
      (value) => typeof value === "string" && uuid.test(value),
    ) &&
    [request.missionId, request.executionId, request.approvalId].every(
      (value) => value === null || (typeof value === "string" && uuid.test(value)),
    ) &&
    typeof request.repositoryLocator === "string" &&
    /^mission-agent:\/\/[a-f0-9]{64}$/.test(request.repositoryLocator) &&
    typeof request.repositoryFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(request.repositoryFingerprint) &&
    typeof request.startingSha === "string" &&
    sha.test(request.startingSha) &&
    request.arguments &&
    typeof request.arguments === "object" &&
    !Array.isArray(request.arguments) &&
    typeof request.requiredProjectBrainVersion === "string" &&
    typeof request.requiredContractVersion === "string" &&
    Array.isArray(request.requiredSchemaVersions) &&
    request.requiredSchemaVersions.every((value) => typeof value === "string") &&
    Array.isArray(request.requestedArtifactTypes) &&
    request.requestedArtifactTypes.every((value) => typeof value === "string") &&
    Number.isInteger(request.timeoutMs) &&
    request.timeoutMs > 0 &&
    request.timeoutMs <= 3_600_000 &&
    Number.isInteger(request.maxOutputBytes) &&
    request.maxOutputBytes > 0 &&
    request.maxOutputBytes <= 10_000_000 &&
    request.policyDecision &&
    typeof request.policyDecision === "object" &&
    request.authorization &&
    typeof request.authorization === "object" &&
    typeof request.artifactVersioning === "boolean" &&
    Number.isFinite(requestedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > requestedAt &&
    expiresAt - requestedAt <= 3_600_000 &&
    typeof request.nonce === "string" &&
    request.nonce.length >= 16 &&
    request.nonce.length <= 200
  );
}
const projectBrainArtifactKinds = {
  initialize_repository: ["project_brain_initialization"],
  prepare_context: ["context_pack"],
  read_context: ["context_pack"],
  record_closure: ["mission_result"],
  propose_learning: ["proposed_learning"],
  evaluate_learning: ["knowledge_evaluation"],
};
function projectBrainCapabilities(config) {
  const executable = config.projectBrainExecutable;
  if (!executable || !isAbsolute(executable))
    return {
      installed: false,
      coreVersion: "",
      contractVersions: [],
      schemaVersions: [],
      operations: [],
      readOperations: [],
      writeOperations: [],
      maxRequestBytes: 1_000_000,
      maxResultBytes: 5_000_000,
      artifactTransferModes: ["inline_base64"],
      runtimeReady: false,
      diagnosticsStatus: "not_configured",
    };
  const result = spawnSync(executable, ["capabilities", "--json"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  try {
    const parsed = JSON.parse(result.stdout);
    const available = Object.keys(parsed.operations ?? {}).filter((operation) => projectBrainOperations.includes(operation));
    return {
      installed: result.status === 0,
      coreVersion: String(parsed.core_version ?? ""),
      contractVersions: parsed.consumer_contract_versions ?? [],
      schemaVersions: parsed.supported_artifact_schema_versions ?? [],
      operations: available,
      readOperations: available.filter(
        (operation) => !projectBrainWriteOperations.includes(operation) || operation === "prepare_context",
      ),
      writeOperations: available.filter((operation) => projectBrainWriteOperations.includes(operation)),
      maxRequestBytes: 1_000_000,
      maxResultBytes: 5_000_000,
      artifactTransferModes: ["inline_base64"],
      runtimeReady: result.status === 0,
      diagnosticsStatus: result.status === 0 ? "ready" : "failed",
    };
  } catch {
    return {
      installed: false,
      coreVersion: "",
      contractVersions: [],
      schemaVersions: [],
      operations: [],
      readOperations: [],
      writeOperations: [],
      maxRequestBytes: 1_000_000,
      maxResultBytes: 5_000_000,
      artifactTransferModes: ["inline_base64"],
      runtimeReady: false,
      diagnosticsStatus: "invalid_capabilities",
    };
  }
}
function validateRemoteProjectBrainAuthoritySnapshot(config, request, state = {}, now = Date.now()) {
  if (!validRemoteProjectBrainRequestShape(request))
    throw new Error("Remote Project Brain request structure is invalid.");
  const unsigned = { ...request };
  for (const key of [
    "assignmentId",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt",
    "requestChecksum",
    "missionControlSignature",
  ])
    delete unsigned[key];
  if (!equalChecksum(sha256(canonicalJson(unsigned)), request.requestChecksum))
    throw new Error("Remote Project Brain request checksum is invalid.");
  if (
    !equalChecksum(
      createHmac("sha256", sha256(config.secret)).update(request.requestChecksum).digest("hex"),
      request.missionControlSignature,
    )
  )
    throw new Error("Remote Project Brain request signature is invalid.");
  if (
    request.workspaceId !== config.workspaceId ||
    request.agentId !== config.agentId ||
    request.idempotencyKey !== `project-brain:${request.operationId}` ||
    !projectBrainOperations.includes(request.operation)
  )
    throw new Error("Remote Project Brain request identity or operation is invalid.");
  const repository = config.repositories?.[request.repositoryId];
  if (config.repositoryIdentityMigrations?.[request.repositoryId] || repository?.identityTransition?.status)
    throw new Error("Repository identity transition dispatch barrier is active.");
  if (
    !repository ||
    request.repositoryLocator !== `mission-agent://${repository.fingerprint}` ||
    request.repositoryFingerprint !== repository.fingerprint
  )
    throw new Error("Remote Project Brain repository registration does not match.");
  const cached = state.projectBrainReceipts?.[request.idempotencyKey];
  const recovered =
    state.projectBrainInFlight?.requestId === request.requestId &&
    state.projectBrainInFlight?.requestChecksum === request.requestChecksum;
  const historical = (cached && cached.requestChecksum === request.requestChecksum) || recovered;
  if (Date.parse(request.expiresAt) <= now && !historical)
    throw new Error("Remote Project Brain request expiry is invalid.");
  const writing =
    request.operation === "prepare_context"
      ? request.arguments?.write === true
      : projectBrainWriteOperations.includes(request.operation);
  const approvalFingerprint = sha256(
    canonicalJson({
      repositoryId: request.repositoryId,
      missionId: request.missionId,
      executionId: request.executionId,
      agentId: request.agentId,
      operation: request.operation,
      arguments: request.arguments ?? {},
      startingSha: request.startingSha,
      locationMode: "mission_agent",
      expectedWriteScope: request.requestedArtifactTypes,
      timeoutMs: Number(request.timeoutMs),
      maxOutputBytes: Number(request.maxOutputBytes),
      requiredProjectBrainVersion: request.requiredProjectBrainVersion,
      requiredContractVersion: request.requiredContractVersion,
      artifactVersioning: request.artifactVersioning,
    }),
  );
  const authorization = request.authorization ?? {};
  const policyDecision = request.policyDecision ?? {};
  if (
    authorization.allowedAgent !== true ||
    policyDecision.outcome !== "allowed" ||
    policyDecision.action !== (writing ? "project_brain.repository_write" : "project_brain.read") ||
    authorization.repositoryReadAllowed !== true ||
    authorization.resourcePermission !== true ||
    authorization.requiredPermission !== (writing ? "write" : "read") ||
    (writing &&
      (authorization.repositoryWriteAllowed !== true ||
        authorization.repositoryCommitAllowed !== true ||
        request.artifactVersioning !== true ||
        repository.projectBrainWriteAllowed !== true ||
        !request.approvalId ||
        request.approvalFingerprint !== approvalFingerprint))
  )
    throw new Error("Remote Project Brain authorization snapshot is not permitted.");
  if (
    writing &&
    !historical &&
    authorization.approvalExpiresAt &&
    Date.parse(authorization.approvalExpiresAt) <= now
  )
    throw new Error("Remote Project Brain approval expired.");
  if ((state.projectBrainNonces ?? []).includes(request.nonce) && !historical)
    throw new Error("Remote Project Brain request nonce was replayed.");
  return { repository, writing, approvalFingerprint, historical: Boolean(historical) };
}
function canonicalizeRepositoryRemote(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("A Git remote URL is required.");
  let host;
  let pathname;
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error("The Git remote URL is not canonicalizable."); }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol))
      throw new Error("The Git remote protocol is unsupported.");
    const defaults = { "http:": "80", "https:": "443", "ssh:": "22", "git:": "9418" };
    host = parsed.hostname + (parsed.port && parsed.port !== defaults[parsed.protocol] ? ":" + parsed.port : "");
    pathname = parsed.pathname;
  }
  const cleanPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !cleanPath || cleanPath.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("The Git remote identity is ambiguous.");
  return host.toLowerCase() + "/" + cleanPath.normalize("NFC");
}
function deriveStableRepositoryIdentity(remotes, repositoryName) {
  const origin = remotes.filter((remote) => remote.name === "origin");
  const selected = origin.length === 1 ? origin[0] : origin.length === 0 && remotes.length === 1 ? remotes[0] : undefined;
  if (!selected) throw new Error(remotes.length ? "Repository remotes are ambiguous." : "Local-only repositories are not stable-v2 eligible.");
  const canonicalRemoteUrl = canonicalizeRepositoryRemote(selected.url);
  const name = String(repositoryName ?? "").trim().normalize("NFC");
  if (!name || canonicalRemoteUrl.slice(canonicalRemoteUrl.lastIndexOf("/") + 1) !== name)
    throw new Error("Repository name does not exactly match the selected canonical remote.");
  return { identityVersion: "stable-v2", selectedRemote: selected.name, canonicalRemoteUrl, repositoryName: name,
    fingerprint: sha256(canonicalRemoteUrl + "\n" + name) };
}
function inspectRepository(path) {
  if (!path) throw new Error("Provide a repository path, for example: mission-agent repository add .");
  const top = exec("git", ["rev-parse", "--show-toplevel"], path);
  const resolved = exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], path);
  if (top !== resolved) throw new Error("Repository path could not be resolved safely.");
  const commit = exec("git", ["rev-parse", "HEAD"], resolved);
  const branch = exec("git", ["branch", "--show-current"], resolved) || "detached";
  const names = exec("git", ["remote"], resolved).split(/\r?\n/).filter(Boolean);
  const remotes = names.map((name) => ({ name, url: exec("git", ["remote", "get-url", name], resolved) }));
  const stable = deriveStableRepositoryIdentity(remotes, basename(resolved));
  const origin = remotes.find((remote) => remote.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
  return { path: resolved, name: basename(resolved), commit, branch, remotes, remoteUrl: origin?.url,
    legacyFingerprint: sha256((origin?.url ?? "local:" + resolved) + "\n" + basename(resolved)),
    ...stable };
}
function normalizedRemote(remoteUrl) {
  if (!remoteUrl) return "local repository";
  return remoteUrl
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\/(?:[^/@]+@)?/, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/\.git$/, "");
}
async function registerRepository(config, path) {
  const repository = inspectRepository(path);
  const response = await signedRequest(config, "/api/agent-protocol/v1/repositories", "AgentRepositoryRegistered", {
    name: repository.name,
    fingerprint: repository.fingerprint,
    defaultBranch: repository.branch,
    remoteUrl: repository.remoteUrl,
    commit: repository.commit,
    identityVersion: "stable-v2",
    canonicalRemoteUrl: repository.canonicalRemoteUrl,
    selectedRemote: repository.selectedRemote,
    remotes: repository.remotes,
  });
  const registered = response.repository;
  const existingRegistration = config.repositories?.[registered.repository_id];
  config.repositories = {
    ...(config.repositories ?? {}),
    [registered.repository_id]: {
      ...(existingRegistration ?? {}),
      path: repository.path,
      fingerprint: repository.fingerprint,
      identityVersion: "stable-v2",
      canonicalRemoteUrl: repository.canonicalRemoteUrl,
      name: repository.name,
      remoteUrl: repository.remoteUrl,
      branch: repository.branch,
      commit: repository.commit,
      projectBrainWriteAllowed: existingRegistration?.projectBrainWriteAllowed === true,
    },
  };
  await persistConfig(config);
  return registered;
}
async function installLauncher() {
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  await chmod(launcherPath, 0o755);
}
async function installCurrentVersion() {
  await loadConfig();
  await writeFile(scriptPath, await readFile(new URL(import.meta.url), "utf8"), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  await writeFile(artifactMetadataPath, `${JSON.stringify({ version: VERSION, ...(await artifactIdentity()) })}\n`, {
    mode: 0o600,
  });
  await installLauncher();
  console.log(`Mission Agent ${VERSION} installed without changing credentials or repository registrations.`);
}
async function persistConfig(config) {
  const stored = { ...config };
  if (stored.secretStorage === "keychain") delete stored.secret;
  await save(configPath, stored);
}

async function installService() {
  const servicePath = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const xmlPath = servicePath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (platform() === "darwin") {
    const directory = join(homedir(), "Library", "LaunchAgents");
    const plist = join(directory, "com.wallyweb.mission-agent.plist");
    await mkdir(directory, { recursive: true });
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.wallyweb.mission-agent</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${scriptPath}</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>MISSION_AGENT_HOME</key><string>${root}</string><key>PATH</key><string>${xmlPath}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${join(root, "mission-agent.log")}</string><key>StandardErrorPath</key><string>${join(root, "mission-agent-error.log")}</string></dict></plist>\n`,
      { mode: 0o600 },
    );
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
    const loaded = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
    return loaded.status === 0;
  }
  if (platform() === "linux" && spawnSync("systemctl", ["--user", "--version"], { stdio: "ignore" }).status === 0) {
    const directory = join(homedir(), ".config", "systemd", "user");
    const unit = join(directory, "mission-agent.service");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      unit,
      `[Unit]\nDescription=Mission Agent\nAfter=network-online.target\n\n[Service]\nExecStart=${process.execPath} ${scriptPath} run\nEnvironment=MISSION_AGENT_HOME=${root}\nEnvironment=PATH=${servicePath}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    const loaded = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", "mission-agent.service"], { stdio: "ignore" });
    return loaded.status === 0 && enabled.status === 0;
  }
  return false;
}

async function connect(encoded) {
  if (!encoded) throw new Error("Use the connection command generated by Mission Control.");
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  config.adapter =
    config.agentType === "claude_code"
      ? "claude-code"
      : config.agentType === "generic_remote"
        ? "generic"
        : config.agentType;
  config.leaseOwner = `${platform()}-${randomUUID()}`;
  config.repositories = {};
  if (
    platform() === "darwin" &&
    process.env.MISSION_AGENT_SECRET_STORE !== "file" &&
    spawnSync("security", ["help"], { stdio: "ignore" }).status === 0
  ) {
    const result = spawnSync(
      "security",
      ["add-generic-password", "-a", config.agentId, "-s", "Mission Agent", "-w", config.secret, "-U"],
      { stdio: "ignore" },
    );
    if (result.status !== 0) throw new Error("Could not store the credential in macOS Keychain.");
    config.secretStorage = "keychain";
  } else config.secretStorage = "file-0600";
  await persistConfig(config);
  await registerRepository(config, option("--repository") ?? process.cwd());
  await heartbeat(config);
  await writeFile(scriptPath, await readFile(new URL(import.meta.url), "utf8"), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  await installLauncher();
  if (!process.argv.includes("--no-start")) {
    const serviceStarted = await installService().catch(() => false);
    if (!serviceStarted) {
      const child = spawn(process.execPath, [scriptPath, "run"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MISSION_AGENT_HOME: root },
      });
      child.unref();
    }
  }
  console.log(
    `\nMission Agent connected.\n\nAgent: ${config.agentName}\nWorkspace: ${config.workspaceName}\nMission Control: ${config.missionControlUrl}\nHeartbeat: received\nAssignment polling: active\nRepositories: ${Object.keys(config.repositories).length}\n\nYour Mission Agent can manage multiple repositories from this computer.\nAdd another with: mission-agent repository add /path/to/repository\n${process.env.PATH?.split(":").includes(binDirectory) ? "" : `\nAdd ${binDirectory} to PATH to use the stable mission-agent command.\n`}`,
  );
}

async function protocolMessage(config, assignment, type, payload) {
  let acknowledgement = await signedRequest(
    config,
    "/api/agent-protocol/v1/messages",
    type,
    payload,
    assignment,
    assignment,
  );
  for (let depth = 0; depth < 2; depth += 1) {
    if (!acknowledgement?.result || typeof acknowledgement.result !== "object") break;
    acknowledgement = acknowledgement.result;
  }
  return acknowledgement;
}
async function assignmentAction(config, assignment, action, type) {
  const path = `/api/agent-protocol/v1/assignments/${assignment.assignmentId}/${action}`;
  return signedRequest(
    config,
    path,
    type,
    { leaseOwner: assignment.leaseOwner, leaseToken: assignment.leaseToken },
    assignment,
    assignment,
  );
}
async function progress(config, assignment, stage, summary, percent, evidence = {}) {
  await protocolMessage(config, assignment, "ExecutionProgressReported", {
    stage,
    summary,
    progressPercent: percent,
    ...evidence,
  });
  await executionHeartbeat(config, assignment, stage, summary, percent);
  await updateState({ activeAssignment: assignment, stage, leaseExpiresAt: assignment.leaseExpiresAt });
}
function verifiedProjectBrainContext(assignment, startingSha) {
  const context = assignment.projectBrainContext;
  if (!context) return undefined;
  if (context.startingSha !== startingSha) {
    const error = new Error("Project Brain context is stale because the repository HEAD changed.");
    error.classification = "project_brain_context_stale";
    error.expectedStartingSha = context.startingSha;
    error.observedStartingSha = startingSha;
    throw error;
  }
  if (
    context.verificationRequired !== true ||
    typeof context.contentBase64 !== "string" ||
    !/^[a-f0-9]{64}$/.test(String(context.checksum ?? "")) ||
    context.contractVersion !== "1.0"
  )
    throw new Error("Project Brain context binding is invalid or stale.");
  const bytes = Buffer.from(context.contentBase64, "base64");
  if (bytes.byteLength !== Number(context.contextBytes) || sha256(bytes) !== context.checksum)
    throw new Error("Project Brain context artifact checksum verification failed.");
  return {
    content: bytes.toString("utf8"),
    evidence: {
      receivedContextChecksum: context.checksum,
      verifiedContextChecksum: context.checksum,
      contextVerificationOutcome: "verified",
      startingSha,
    },
  };
}
async function verifiedRemoteProjectBrainArtifact(
  checkout,
  artifact,
  allowedKinds,
  requiredSchemas,
  currentBytes,
  maximumBytes,
) {
  const artifactPath = String(artifact.path ?? "");
  if (!allowedKinds.includes(String(artifact.kind)))
    throw new Error("Remote Project Brain returned an artifact kind outside the operation allowlist.");
  if (!requiredSchemas.includes(String(artifact.schema_version ?? "")))
    throw new Error("Remote Project Brain returned an unsupported artifact schema.");
  if (!artifactPath || artifactPath.startsWith("/") || artifactPath.split("/").includes(".."))
    throw new Error("Remote Project Brain returned an unsafe artifact path.");
  const absolute = await realpath(join(checkout, artifactPath));
  if (absolute !== checkout && !absolute.startsWith(`${checkout}/`))
    throw new Error("Remote Project Brain artifact escaped the checkout.");
  const body = await readFile(absolute);
  const totalBytes = currentBytes + body.byteLength;
  if (totalBytes > maximumBytes || sha256(body) !== artifact.sha256)
    throw new Error("Remote Project Brain artifact integrity validation failed.");
  return { body, totalBytes, artifactPath };
}
async function verifiedPriorProjectBrainArtifacts(
  state,
  checkout,
  statusText,
  repositoryId,
  repositoryLocator,
  additionalDescriptors = [],
) {
  const descriptors = new Map(
    additionalDescriptors.map((artifact) => [String(artifact.path), String(artifact.sha256)]),
  );
  for (const receipt of Object.values(state.projectBrainReceipts ?? {}))
    if (
      receipt?.messageType === "RemoteProjectBrainOperationSucceeded" &&
      receipt?.centralAcknowledged === true &&
      receipt?.response?.envelope?.repository?.id === repositoryId &&
      receipt?.response?.envelope?.repository?.checkout_path === repositoryLocator
    )
      for (const artifact of receipt.response.envelope.artifacts ?? [])
        if (artifact?.path && /^[a-f0-9]{64}$/.test(String(artifact.sha256 ?? "")))
          descriptors.set(String(artifact.path), String(artifact.sha256));
  for (const line of statusText.split("\n").filter(Boolean)) {
    const path = line.slice(3);
    const expected = descriptors.get(path);
    if (!expected) throw new Error("Remote Project Brain requires a clean or previously verified worktree.");
    const absolute = await realpath(join(checkout, path));
    if ((absolute !== checkout && !absolute.startsWith(`${checkout}/`)) || sha256(await readFile(absolute)) !== expected)
      throw new Error("A previously verified Project Brain artifact changed unexpectedly.");
  }
  return descriptors;
}
async function versionAcknowledgedProjectBrainArtifacts(config, repositoryId, checkout, additionalDescriptors = []) {
  let state = {};
  try {
    state = await protectedJson(statePath);
  } catch {}
  const repository = config.repositories?.[repositoryId];
  if (!repository) throw new Error("Project Brain artifact versioning requires a registered repository.");
  const statusText = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], checkout);
  if (!statusText) {
    const commitSha = exec("git", ["rev-parse", "HEAD"], checkout);
    return { parentSha: commitSha, commitSha, paths: [] };
  }
  await verifiedPriorProjectBrainArtifacts(
    state,
    checkout,
    statusText,
    repositoryId,
    `mission-agent://${repository.fingerprint}`,
    additionalDescriptors,
  );
  const paths = statusText
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const explicitlyReturnedPaths = new Set(additionalDescriptors.map((artifact) => String(artifact.path ?? "")));
  if (
    paths.some(
      (path) => !path.startsWith(".project-brain/") && !(path === "AGENTS.md" && explicitlyReturnedPaths.has(path)),
    )
  )
    throw new Error("Project Brain artifact versioning refused a path outside .project-brain.");
  if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: checkout }).status !== 0)
    throw new Error("Project Brain artifact versioning requires an empty Git index.");
  const parentSha = exec("git", ["rev-parse", "HEAD"], checkout);
  const checksums = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, sha256(await readFile(join(checkout, path)))])),
  );
  let currentState = {};
  try {
    currentState = await protectedJson(statePath);
  } catch {}
  await updateState({
    projectBrainInFlight: {
      ...(currentState.projectBrainInFlight ?? {}),
      versioningIntent: { parentSha, paths, checksums },
    },
  });
  const artifactCommit = await finishProjectBrainArtifactVersioning(checkout, {
    parentSha,
    paths,
    checksums,
  });
  try {
    currentState = await protectedJson(statePath);
  } catch {}
  await updateState({
    projectBrainInFlight: {
      ...(currentState.projectBrainInFlight ?? {}),
      artifactCommit,
    },
  });
  // Registration refresh is best-effort here. The signed terminal callback
  // carries the exact A→B transition and is authoritative centrally; a
  // transient refresh failure must not turn an already committed write into a
  // terminal failure.
  await registerRepository(config, checkout).catch(() => undefined);
  return artifactCommit;
}
async function finishProjectBrainArtifactVersioning(checkout, intent) {
  const { parentSha, paths, checksums } = intent;
  if (
    !/^[a-f0-9]{40}$/.test(String(parentSha ?? "")) ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        typeof path !== "string" ||
        (!path.startsWith(".project-brain/") && path !== "AGENTS.md") ||
        path.startsWith("/") ||
        path.split("/").includes("..") ||
        !/^[a-f0-9]{64}$/.test(String(checksums?.[path] ?? "")),
    )
  )
    throw new Error("Project Brain artifact versioning intent is invalid.");
  if (exec("git", ["rev-parse", "HEAD"], checkout) !== parentSha)
    throw new Error("Project Brain artifact versioning parent changed during recovery.");
  for (const path of paths) {
    const absolute = await realpath(join(checkout, path));
    if (
      (absolute !== checkout && !absolute.startsWith(`${checkout}/`)) ||
      sha256(await readFile(absolute)) !== checksums[path]
    )
      throw new Error("Project Brain artifact versioning recovery found changed bytes.");
  }
  // Rebuild the index from the approved parent so a crash after any update-index
  // call cannot leave an ambiguous or attacker-controlled staged state.
  exec("git", ["read-tree", parentSha], checkout);
  for (const path of paths) {
    const body = await readFile(join(checkout, path));
    const hashed = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: checkout,
      input: body,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    if (hashed.status !== 0 || !/^[a-f0-9]{40}$/.test(hashed.stdout.trim()))
      throw new Error("Project Brain artifact blob could not be written.");
    exec("git", ["update-index", "--add", "--cacheinfo", `100644,${hashed.stdout.trim()},${path}`], checkout);
  }
  const tree = exec("git", ["write-tree"], checkout);
  const committed = spawnSync("git", ["commit-tree", tree, "-p", parentSha], {
    cwd: checkout,
    input: "project-brain: version governed artifacts\n",
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      GIT_AUTHOR_NAME: "Mission Control Project Brain",
      GIT_AUTHOR_EMAIL: "project-brain@localhost",
      GIT_COMMITTER_NAME: "Mission Control Project Brain",
      GIT_COMMITTER_EMAIL: "project-brain@localhost",
    },
  });
  const commitSha = committed.stdout.trim();
  if (committed.status !== 0 || !/^[a-f0-9]{40}$/.test(commitSha))
    throw new Error("Project Brain artifact commit object could not be created.");
  exec("git", ["update-ref", "HEAD", commitSha, parentSha], checkout);
  return {
    parentSha,
    commitSha,
    paths,
    checksums,
  };
}
async function executionHeartbeat(config, assignment, stage, summary, progressPercent) {
  await protocolMessage(config, assignment, "ExecutionHeartbeat", {
    workerId: config.leaseOwner,
    stage,
    summary,
    ...(Number.isInteger(progressPercent) ? { progressPercent } : {}),
  });
}

function parseGrokJson(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Grok did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}
function grokStructuredResult(payload) {
  if (payload?.structured_output && typeof payload.structured_output === "object") return payload.structured_output;
  if (payload?.structuredOutput && typeof payload.structuredOutput === "object") return payload.structuredOutput;
  if (typeof payload?.text === "string") {
    try {
      return JSON.parse(payload.text);
    } catch {
      return payload;
    }
  }
  return payload;
}
const GROK_INTELLIGENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recommendations", "observations"],
  properties: {
    recommendations: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "reasoning",
          "evidence",
          "estimatedImpact",
          "estimatedRisk",
          "estimatedEffort",
          "suggestedValidation",
          "acceptanceCriteria",
        ],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          reasoning: { type: "string" },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "description"],
              properties: {
                path: { type: "string" },
                line: { type: "integer" },
                description: { type: "string" },
              },
            },
          },
          estimatedImpact: { type: "string", enum: ["low", "medium", "high", "critical"] },
          estimatedRisk: { type: "string", enum: ["low", "medium", "high"] },
          estimatedEffort: { type: "string" },
          suggestedValidation: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    observations: {
      type: "array",
      minItems: 7,
      maxItems: 70,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "status", "severity", "summary", "evidence"],
        properties: {
          dimension: {
            type: "string",
            enum: ["architecture", "tests", "security", "technical_debt", "documentation", "dependencies", "ci"],
          },
          status: { type: "string", enum: ["strength", "risk", "unknown"] },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          summary: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "description"],
              properties: {
                path: { type: "string" },
                line: { type: "integer" },
                description: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
async function runGrok(config, assignment, prompt, cwd, extraArgs = [], heartbeatStage = "inspecting_repository") {
  const args = [
    "-p",
    prompt,
    "--sandbox",
    "read-only",
    "--tools",
    "read_file,grep,list_dir",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--no-auto-update",
    "--disallowed-tools",
    "search_replace,run_terminal_cmd,web_search,web_fetch,Agent",
    "--output-format",
    "json",
    "--max-turns",
    "40",
    ...extraArgs,
  ];
  const child = spawn("grok", args, {
    cwd,
    env: Object.fromEntries(
      ["PATH", "HOME", "GROK_HOME", "XAI_API_KEY", "TMPDIR", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout = (stdout + String(chunk)).slice(-512_000)));
  child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-512_000)));
  const renew = setInterval(() => {
    void Promise.all([
      assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed"),
      executionHeartbeat(config, assignment, heartbeatStage, "Grok is analyzing the repository", 50),
    ]).catch(() => child.kill("SIGTERM"));
  }, 25_000);
  const cancel = setInterval(async () => {
    const result = await assignmentAction(
      config,
      assignment,
      "cancellation",
      "AgentAssignmentCancellationChecked",
    ).catch(() => undefined);
    if (result?.cancellationRequested) child.kill("SIGTERM");
  }, 10_000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("Grok could not be started. Install grok, run grok login, then mission-agent doctor.");
    throw error;
  } finally {
    clearInterval(renew);
    clearInterval(cancel);
  }
  return { exitCode, stdout, stderr };
}
async function executeAnalysis(config, assignment) {
  if (config.adapter !== "codex" && config.adapter !== "grok")
    throw new Error(`The ${config.adapter} adapter can connect but cannot execute local tasks yet.`);
  const resource = assignment.allowedResources?.find((item) => item.resourceType === "repository");
  const repository = resource ? config.repositories?.[resource.resourceId] : undefined;
  if (!repository) throw new Error("The assignment repository is not registered on this Mission Agent.");
  if (config.repositoryIdentityMigrations?.[resource.resourceId] || repository.identityTransition?.status)
    throw new Error("Repository identity transition dispatch barrier is active.");
  const resolved = await realpath(repository.path);
  if (resolved !== repository.path) throw new Error("Repository path changed after registration.");
  const before = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  const beforeCommit = exec("git", ["rev-parse", "HEAD"], resolved);
  const projectBrain = verifiedProjectBrainContext(assignment, beforeCommit);
  if (projectBrain)
    await progress(
      config,
      assignment,
      "project_brain_context_verified",
      "Verified exact Project Brain context artifact",
      15,
      projectBrain.evidence,
    );
  else await progress(config, assignment, "validating_repository", "Validating repository", 10);
  const outputPath = join(root, `artifact-${assignment.executionId}.md`);
  const prompt = `Analyze this repository in read-only mode. Do not modify files, install packages, commit, push, create pull requests, access secrets, or deploy. Produce Markdown with exactly these sections: Repository overview, Main technologies, Application structure, Important commands, Test setup, Notable risks, Suggested next mission. Base every finding on visible repository contents. Objective: ${assignment.instructions ?? assignment.taskObjective}${projectBrain ? `\n\nVerified Project Brain context (${projectBrain.evidence.verifiedContextChecksum}):\n${projectBrain.content}` : ""}`;
  await progress(config, assignment, "inspecting_repository", "Inspecting repository structure", 25);
  if (config.adapter === "grok") {
    const grokResult = await runGrok(config, assignment, prompt, resolved);
    if (grokResult.exitCode !== 0)
      throw new Error(`Grok analysis failed${grokResult.stderr ? ": " + grokResult.stderr.slice(-300) : "."}`);
    const markdown = String(parseGrokJson(grokResult.stdout).text ?? "").trim();
    if (!markdown) throw new Error("Grok analysis produced no report.");
    await writeFile(outputPath, markdown);
  } else {
  const child = spawn("codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", outputPath, prompt], {
    cwd: resolved,
    env: Object.fromEntries(
      ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let cancellationRequested = false;
  child.stderr.on("data", (chunk) => (stderr += String(chunk).slice(-4000)));
  const renew = setInterval(() => {
    void Promise.all([
      assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed"),
      executionHeartbeat(config, assignment, "inspecting_repository", "Codex is analyzing the repository", 50),
    ]).catch(() => child.kill("SIGTERM"));
  }, 25_000);
  const cancel = setInterval(async () => {
    const result = await assignmentAction(
      config,
      assignment,
      "cancellation",
      "AgentAssignmentCancellationChecked",
    ).catch(() => undefined);
    if (result?.cancellationRequested) {
      cancellationRequested = true;
      child.kill("SIGTERM");
    }
  }, 10_000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(
        "Codex could not be started by the background service. Run mission-agent doctor, then mission-agent service install.",
      );
    throw error;
  } finally {
    clearInterval(renew);
    clearInterval(cancel);
  }
  if (cancellationRequested) {
    await protocolMessage(config, assignment, "ExecutionCancellationAcknowledged", {
      summary: "Mission Agent stopped the local adapter after cancellation was requested.",
    });
    await assignmentAction(config, assignment, "release", "AgentAssignmentReleased").catch(() => undefined);
    await updateState({ activeAssignment: null, stage: "cancelled", lastError: null });
    return;
  }
  if (exitCode !== 0) throw new Error(`Codex analysis failed${stderr ? ": " + stderr.slice(-300) : "."}`);
  }
  await progress(config, assignment, "preparing_findings", "Preparing findings", 75);
  const after = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  const afterCommit = exec("git", ["rev-parse", "HEAD"], resolved);
  if (before !== after || beforeCommit !== afterCommit)
    throw new Error("Read-only verification detected a repository change.");
  const report = await readFile(outputPath);
  if (!report.length || report.length > 128 * 1024)
    throw new Error("Repository analysis artifact is empty or oversized.");
  await progress(config, assignment, "uploading_report", "Uploading repository analysis", 90);
  await protocolMessage(config, assignment, "ExecutionArtifactSubmitted", {
    name: "Repository analysis",
    description: config.adapter === "grok"
      ? "Read-only analysis produced by the local Grok adapter"
      : "Read-only analysis produced by the local Codex adapter",
    artifactType: "repository_analysis",
    mediaType: "text/markdown",
    byteSize: report.length,
    checksum: sha256(report),
    contentBase64: report.toString("base64"),
    repositoryCommit: beforeCommit,
  });
  await progress(config, assignment, "structuring_recommendations", "Creating evidence-backed recommendations", 94);
  const recommendationsPath = join(root, `recommendations-${assignment.executionId}.json`);
  const recommendationPrompt = `Inspect this repository in read-only mode for the analysis objective: ${assignment.instructions ?? assignment.taskObjective}. Return ONLY one valid JSON object with two properties: recommendations and observations. recommendations must be an array containing 1 to 8 focused objects with title, description, reasoning, evidence (always an array of one or more objects containing repository-relative path, optional positive line, and description), estimatedImpact (low|medium|high|critical), estimatedRisk (low|medium|high), estimatedEffort, suggestedValidation (always an array of safe npm, pnpm, yarn, bun, npx, node, go, cargo, or pytest command strings), and acceptanceCriteria (always an array of one or more concrete criterion strings). observations must cover each dimension architecture, tests, security, technical_debt, documentation, dependencies, and ci at least once. Each observation has dimension, status (strength|risk|unknown), severity (low|medium|high|critical), summary, and evidence. A strength or risk requires visible repository-relative file evidence; use unknown with an empty evidence array when the repository cannot support a claim. Do not infer health from missing files and do not modify files.`;
  let intelligenceValue;
  if (config.adapter === "grok") {
    const grokResult = await runGrok(
      config,
      assignment,
      recommendationPrompt,
      resolved,
      ["--json-schema", JSON.stringify(GROK_INTELLIGENCE_SCHEMA)],
      "structuring_recommendations",
    );
    if (grokResult.exitCode !== 0)
      throw new Error(
        `Grok recommendation extraction failed${grokResult.stderr ? ": " + grokResult.stderr.slice(-300) : "."}`,
      );
    try {
      intelligenceValue = grokStructuredResult(parseGrokJson(grokResult.stdout));
    } catch {
      throw new Error("Grok returned invalid structured repository intelligence.");
    }
    await writeFile(recommendationsPath, JSON.stringify(intelligenceValue));
  } else {
  const recommendationResult = await runCodex(
    config,
    assignment,
    ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", recommendationsPath, recommendationPrompt],
    resolved,
  );
  if (recommendationResult.exitCode !== 0)
    throw new Error(
      `Codex recommendation extraction failed${recommendationResult.stderr ? ": " + recommendationResult.stderr.slice(-300) : "."}`,
    );
  const recommendationBody = await readFile(recommendationsPath);
  try {
    intelligenceValue = JSON.parse(recommendationBody.toString("utf8"));
  } catch {
    throw new Error("Codex returned invalid structured repository intelligence.");
  }
  }
  const recommendationValue = intelligenceValue?.recommendations;
  const observationValue = intelligenceValue?.observations;
  if (!Array.isArray(recommendationValue) || !recommendationValue.length || recommendationValue.length > 8)
    throw new Error(`${config.adapter === "grok" ? "Grok" : "Codex"} returned an unsupported recommendation set.`);
  if (!Array.isArray(observationValue) || !observationValue.length || observationValue.length > 70)
    throw new Error(`${config.adapter === "grok" ? "Grok" : "Codex"} returned an unsupported repository health observation set.`);
  if (
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved) !== before ||
    exec("git", ["rev-parse", "HEAD"], resolved) !== beforeCommit
  )
    throw new Error("Read-only recommendation verification detected a repository change.");
  await uploadArtifact(config, assignment, {
    name: "Repository recommendations",
    description: "Structured evidence-backed recommendations from repository analysis",
    type: "repository_recommendations",
    mediaType: "application/json",
    body: Buffer.from(JSON.stringify(recommendationValue)),
    repositoryCommit: beforeCommit,
  });
  await progress(config, assignment, "assessing_repository_health", "Calculating explainable repository health", 97);
  await uploadArtifact(config, assignment, {
    name: "Repository health observations",
    description: "Evidence-backed observations scored deterministically by Mission Control",
    type: "repository_health_observations",
    mediaType: "application/json",
    body: Buffer.from(JSON.stringify(observationValue)),
    repositoryCommit: beforeCommit,
  });
  await protocolMessage(config, assignment, "ExecutionSucceeded", {
    summary: "Read-only repository analysis completed and verified without repository changes.",
    usage: { runtime: `mission-agent/${VERSION}`, durationMs: 0 },
  });
  await updateState({ activeAssignment: null, stage: "completed", lastCompletedExecution: assignment.executionId });
  await rm(outputPath, { force: true });
  await rm(recommendationsPath, { force: true });
}
async function uploadArtifact(config, assignment, input) {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
  if (!body.length || body.length > 2 * 1024 * 1024) throw new Error(`${input.name} artifact is empty or oversized.`);
  const chunkSize = 120 * 1024;
  const chunks = Math.ceil(body.length / chunkSize);
  let first;
  for (let index = 0; index < chunks; index += 1) {
    const chunk = body.subarray(index * chunkSize, Math.min(body.length, (index + 1) * chunkSize));
    const response = await protocolMessage(config, assignment, "ExecutionArtifactSubmitted", {
      name: chunks === 1 ? input.name : `${input.name} (${index + 1}/${chunks})`,
      description:
        chunks === 1 ? input.description : `${input.description}; byte-preserving part ${index + 1} of ${chunks}`,
      artifactType: input.type,
      mediaType: input.mediaType,
      byteSize: chunk.length,
      checksum: sha256(chunk),
      contentBase64: chunk.toString("base64"),
      repositoryCommit: input.repositoryCommit,
      partNumber: index + 1,
      partCount: chunks,
      completeChecksum: sha256(body),
    });
    first ??= response;
  }
  return first;
}
async function runCodex(config, assignment, args, cwd, heartbeatStage = "running_codex") {
  const child = spawn("codex", args, {
    cwd,
    env: Object.fromEntries(
      ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout = (stdout + String(chunk)).slice(-512_000)));
  child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-512_000)));
  const renew = setInterval(() => {
    void Promise.all([
      assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed"),
      executionHeartbeat(config, assignment, heartbeatStage, "Codex is still working"),
    ]).catch(() => child.kill("SIGTERM"));
  }, 25_000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("Codex could not be started by the background service. Run mission-agent doctor.");
    throw error;
  } finally {
    clearInterval(renew);
  }
  return { exitCode, stdout, stderr };
}
function safeValidationCommands(value) {
  const allowed = new Set(["npm", "pnpm", "yarn", "bun", "npx", "node", "go", "cargo", "pytest"]);
  if (!Array.isArray(value) || value.length > 10) throw new Error("Validation command configuration is invalid.");
  return value.map((command) => {
    if (!Array.isArray(command) || !command.length || !allowed.has(command[0]))
      throw new Error("A validation command is not allowed.");
    if (
      command.some(
        (part) =>
          typeof part !== "string" ||
          !/^[A-Za-z0-9_./:@=,+-]+$/.test(part) ||
          (part.includes("..") && part !== "./..."),
      )
    )
      throw new Error("A validation command contains unsafe arguments.");
    return command;
  });
}
async function executeChange(config, assignment) {
  if (config.adapter !== "codex")
    throw new Error("Repository changes currently require the Codex adapter. Grok can analyze only.");
  const resource = assignment.allowedResources?.find((item) => item.resourceType === "repository");
  const repository = resource ? config.repositories?.[resource.resourceId] : undefined;
  if (!repository) throw new Error("The assignment repository is not registered on this Mission Agent.");
  const resolved = await realpath(repository.path);
  if (resolved !== repository.path) throw new Error("Repository path changed after registration.");
  let originalStatus = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  const baseBranch = repository.branch;
  let baseCommit = exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved);
  const projectBrain = verifiedProjectBrainContext(assignment, baseCommit);
  if (originalStatus) {
    let state = {};
    try {
      state = await protectedJson(statePath);
    } catch {}
    await verifiedPriorProjectBrainArtifacts(
      state,
      resolved,
      originalStatus,
      resource.resourceId,
      `mission-agent://${repository.fingerprint}`,
    );
  }
  if (projectBrain) {
    await versionAcknowledgedProjectBrainArtifacts(config, resource.resourceId, resolved);
    baseCommit = exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved);
    originalStatus = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  }
  if (projectBrain)
    await progress(
      config,
      assignment,
      "project_brain_context_verified",
      "Verified exact Project Brain context artifact",
      5,
      projectBrain.evidence,
    );
  const planPath = join(root, `plan-${assignment.executionId}.md`);
  await progress(config, assignment, "planning_change", "Codex is preparing an implementation plan", 10);
  const planPrompt = `Inspect this repository in read-only mode and prepare an implementation plan for: ${assignment.instructions}. Do not modify files. Produce Markdown with exactly these sections: Likely files or components, Expected behavior, Tests to add or update, Risks, Validation approach.${projectBrain ? `\n\nVerified Project Brain context (${projectBrain.evidence.verifiedContextChecksum}):\n${projectBrain.content}` : ""}`;
  const planResult = await runCodex(
    config,
    assignment,
    ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-o", planPath, planPrompt],
    resolved,
  );
  if (planResult.exitCode !== 0)
    throw new Error(`Codex planning failed${planResult.stderr ? ": " + planResult.stderr.slice(-300) : "."}`);
  if (exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved) !== originalStatus)
    throw new Error("Planning changed the registered repository; write approval was not granted.");
  const plan = await readFile(planPath);
  const uploadedPlan = await uploadArtifact(config, assignment, {
    name: "Implementation plan",
    description: "Read-only Codex plan produced before write approval",
    type: "implementation_plan",
    mediaType: "text/markdown",
    body: plan,
    repositoryCommit: baseCommit,
  });
  await progress(config, assignment, "waiting_for_write_approval", "Implementation plan ready for human approval", 20);
  let approval = await assignmentAction(config, assignment, "approval", "AgentApprovalStatusChecked");
  if (approval.status === "not_requested") {
    const requested = await protocolMessage(config, assignment, "ExecutionApprovalRequested", {
      actionType: "repository.modify",
      parameters: { repositoryId: resource.resourceId, baseBranch, baseCommit, objective: assignment.instructions },
      targetResource: `repository:${resource.resourceId}`,
      riskExplanation: "Codex requests permission to modify files and create one local commit in an isolated worktree.",
      evidence: [{ artifactId: uploadedPlan.artifactId, checksum: sha256(plan), kind: "implementation_plan" }],
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    if (requested.status !== "approval_required")
      throw new Error("Mission Control did not create the required write approval.");
    approval = { status: "pending", approvalId: requested.approvalId };
  }
  while (!approval || approval.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed");
    approval = await assignmentAction(config, assignment, "approval", "AgentApprovalStatusChecked");
    const cancellation = await assignmentAction(
      config,
      assignment,
      "cancellation",
      "AgentAssignmentCancellationChecked",
    );
    if (cancellation.cancellationRequested) throw new Error("Repository change was cancelled while awaiting approval.");
  }
  if (approval.status !== "granted") throw new Error(`Repository write approval was ${approval.status}.`);
  await protocolMessage(config, assignment, "ExecutionResumed", {
    stage: "write_approved",
    summary: "Human approved isolated repository modifications",
    approvalId: approval.approvalId,
    actionHash: approval.actionHash,
  });
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, assignment.executionId);
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  const slug =
    String(assignment.taskObjective ?? "change")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "change";
  const branchName = `mission/${assignment.missionId.slice(0, 8)}-${slug}`;
  let worktreeExists = false;
  try {
    worktreeExists = (await stat(join(worktreePath, ".git"))).isFile();
  } catch {}
  if (!worktreeExists) {
    const branchExists =
      spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: resolved }).status === 0;
    const created = spawnSync(
      "git",
      branchExists
        ? ["worktree", "add", worktreePath, branchName]
        : ["worktree", "add", "-b", branchName, worktreePath, baseCommit],
      { cwd: resolved, encoding: "utf8", timeout: 60_000 },
    );
    if (created.status !== 0)
      throw new Error(`Safe worktree isolation could not be established: ${created.stderr?.trim() ?? "git failed"}`);
  }
  if (exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved) !== baseCommit)
    throw new Error("The source branch moved after approval; start a new change mission from the latest commit.");
  const recoveredCommit = exec("git", ["rev-parse", "HEAD"], worktreePath);
  if (
    recoveredCommit !== baseCommit &&
    !exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], worktreePath)
  ) {
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", baseCommit, recoveredCommit], {
      cwd: worktreePath,
    });
    if (ancestry.status !== 0) throw new Error("Recovered worktree is not based on the approved commit.");
    const recoveredFiles = exec("git", ["diff", "--name-status", `${baseCommit}..${recoveredCommit}`], worktreePath);
    const recoveredPatch = spawnSync("git", ["diff", "--binary", `${baseCommit}..${recoveredCommit}`], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (!recoveredFiles || recoveredPatch.status !== 0)
      throw new Error("Recovered local commit has no reviewable diff evidence.");
    await uploadArtifact(config, assignment, {
      name: "Recovered repository diff",
      description: "Full diff recovered from the existing local mission commit",
      type: "git_patch",
      mediaType: "text/x-diff",
      body: recoveredPatch.stdout,
      repositoryCommit: recoveredCommit,
    });
    await uploadArtifact(config, assignment, {
      name: "Recovered change summary",
      description: "Restart recovery evidence for the existing local commit",
      type: "change_summary",
      mediaType: "text/markdown",
      body: `Mission Agent recovered an already-created local commit after restart.\n\nBase branch: ${baseBranch}\nBase commit: ${baseCommit}\nLocal branch: ${branchName}\nLocal commit: ${recoveredCommit}\n\nChanged files:\n${recoveredFiles}`,
      repositoryCommit: recoveredCommit,
    });
    await protocolMessage(config, assignment, "ExecutionSucceeded", {
      summary: "Recovered the approved isolated repository change and its existing local commit after restart.",
      stage: "completed",
      branchName,
      baseBranch,
      baseCommit,
      commitId: recoveredCommit,
      validationStatus: "recovered_after_validated_commit",
      usage: { runtime: `mission-agent/${VERSION}`, durationMs: 0 },
    });
    await updateState({
      activeAssignment: null,
      stage: "completed",
      lastCompletedExecution: assignment.executionId,
      reviewWorktree: worktreePath,
    });
    await rm(planPath, { force: true });
    return;
  }
  await progress(config, assignment, "worktree_ready", "Isolated mission branch and worktree created", 30);
  const summaryPath = join(root, `change-summary-${assignment.executionId}.md`);
  const changePrompt = `Implement the exact change in the approved plan below inside the current isolated worktree. Repository write approval has already been granted for this plan, base commit, and isolated worktree. Treat every approval or pause step in the approved plan as already completed; execute only its implementation and validation steps.\n\nApproved plan:\n${plan.toString("utf8")}${projectBrain ? `\n\nVerified Project Brain context (${projectBrain.evidence.verifiedContextChecksum}):\n${projectBrain.content}` : ""}\n\nDo not request another approval. Do not push, create a pull request, merge, deploy, access secrets, modify infrastructure, or write outside this worktree. Do not commit; Mission Agent will validate and create the local commit. Return a concise factual summary.`;
  let changeResult = await runCodex(
    config,
    assignment,
    ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-o", summaryPath, changePrompt],
    worktreePath,
  );
  if (changeResult.exitCode !== 0)
    throw new Error(
      `Codex change execution failed${changeResult.stderr ? ": " + changeResult.stderr.slice(-300) : "."}`,
    );
  if (!exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], worktreePath)) {
    const retryResult = await runCodex(
      config,
      assignment,
      [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "-o",
        summaryPath,
        `${changePrompt}\n\nThe previous execution produced no repository changes. Write approval is already granted. Implement the requested change now and verify that the worktree contains a reviewable diff before you finish.`,
      ],
      worktreePath,
    );
    changeResult = {
      exitCode: retryResult.exitCode,
      stdout: `${changeResult.stdout}\n${retryResult.stdout}`,
      stderr: `${changeResult.stderr}\n${retryResult.stderr}`,
    };
  }
  await uploadArtifact(config, assignment, {
    name: "Codex execution log",
    description: "Structured local Codex execution output, including a bounded no-change retry when required",
    type: "codex_execution_log",
    mediaType: "application/jsonl",
    body: `${changeResult.stdout}\n${changeResult.stderr}`,
    repositoryCommit: baseCommit,
  });
  if (changeResult.exitCode !== 0)
    throw new Error(
      `Codex change retry failed${changeResult.stderr ? ": " + changeResult.stderr.slice(-300) : "."}`,
    );
  await progress(config, assignment, "validating_change", "Running approved validation commands", 65);
  const validationResults = [];
  for (const command of safeValidationCommands(assignment.validationCommands ?? [])) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 300_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "" },
    });
    validationResults.push(
      `$ ${command.join(" ")}\nexit=${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    if (result.status !== 0) {
      await uploadArtifact(config, assignment, {
        name: "Validation results",
        description: "Approved repository-local validation commands",
        type: "validation_results",
        mediaType: "text/plain",
        body: validationResults.join("\n\n"),
        repositoryCommit: baseCommit,
      });
      throw new Error(`Validation failed: ${command.join(" ")}`);
    }
  }
  const changedFiles = exec("git", ["status", "--short"], worktreePath);
  if (!changedFiles) throw new Error("Codex produced no repository changes.");
  // Stage first so the approval-bound patch includes newly created files as
  // well as modifications to tracked files. Nothing leaves the local worktree.
  exec("git", ["add", "--all"], worktreePath);
  const patch = spawnSync("git", ["diff", "--cached", "--binary", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (patch.status !== 0) throw new Error("Git diff evidence could not be collected.");
  await uploadArtifact(config, assignment, {
    name: "Repository diff",
    description: "Full diff before local commit",
    type: "git_patch",
    mediaType: "text/x-diff",
    body: patch.stdout,
    repositoryCommit: baseCommit,
  });
  await uploadArtifact(config, assignment, {
    name: "Validation results",
    description: "Approved repository-local validation commands",
    type: "validation_results",
    mediaType: "text/plain",
    body: validationResults.length
      ? validationResults.join("\n\n")
      : "No explicit validation commands were supplied. Codex self-validation is recorded in the execution log.",
    repositoryCommit: baseCommit,
  });
  const committed = spawnSync(
    "git",
    [
      "-c",
      "user.name=Mission Control Codex",
      "-c",
      "user.email=codex@localhost",
      "commit",
      "-m",
      `mission: complete ${assignment.executionId}`,
    ],
    { cwd: worktreePath, encoding: "utf8", timeout: 60_000 },
  );
  if (committed.status !== 0) throw new Error(`Local commit failed: ${committed.stderr?.trim() ?? "git failed"}`);
  const commitId = exec("git", ["rev-parse", "HEAD"], worktreePath);
  if (
    exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved) !== baseCommit ||
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved) !== originalStatus
  )
    throw new Error("Safety verification detected a change to the original branch or worktree.");
  const summary = await readFile(summaryPath).catch(() =>
    Buffer.from("Codex completed the approved repository change."),
  );
  await uploadArtifact(config, assignment, {
    name: "Change summary",
    description: "Review summary with branch and commit evidence",
    type: "change_summary",
    mediaType: "text/markdown",
    body: `${summary.toString("utf8")}\n\nBase branch: ${baseBranch}\nBase commit: ${baseCommit}\nLocal branch: ${branchName}\nLocal commit: ${commitId}\n\nChanged files:\n${changedFiles}`,
    repositoryCommit: commitId,
  });
  await progress(config, assignment, "review_ready", "Local commit and review evidence are ready", 95);
  await protocolMessage(config, assignment, "ExecutionSucceeded", {
    summary: "Approved repository change completed in an isolated worktree with local commit evidence.",
    stage: "completed",
    branchName,
    baseBranch,
    baseCommit,
    commitId,
    validationStatus: validationResults.length ? "validated" : "partially_validated",
    usage: { runtime: `mission-agent/${VERSION}`, durationMs: 0 },
  });
  await updateState({
    activeAssignment: null,
    stage: "completed",
    lastCompletedExecution: assignment.executionId,
    reviewWorktree: worktreePath,
  });
  await rm(planPath, { force: true });
  await rm(summaryPath, { force: true });
}
async function work(config, assignment) {
  if (!assignment.leaseToken) throw new Error("Mission Agent cannot resume because its local lease token is missing.");
  await updateState({
    activeAssignment: assignment,
    stage: "assignment_received",
    leaseExpiresAt: assignment.leaseExpiresAt,
  });
  await assignmentAction(config, assignment, "acknowledge", "AgentAssignmentAcknowledged");
  try {
    if (assignment.missionType === "repository_change") await executeChange(config, assignment);
    else await executeAnalysis(config, assignment);
  } catch (error) {
    await protocolMessage(config, assignment, "ExecutionFailed", {
      classification: error.classification ?? "local_adapter_failure",
      summary: error.message,
      ...(error.expectedStartingSha ? { expectedStartingSha: error.expectedStartingSha } : {}),
      ...(error.observedStartingSha ? { observedStartingSha: error.observedStartingSha } : {}),
    }).catch(() => undefined);
    await updateState({ activeAssignment: null, stage: "failed", lastError: error.message });
  }
}
async function projectBrainMessage(config, assignment, messageType, payload = {}) {
  return signedRequest(
    config,
    "/api/agent-protocol/v1/project-brain/messages",
    messageType,
    { assignmentId: assignment.assignmentId, operationId: assignment.operationId, ...payload },
    assignment.missionId
      ? { missionId: assignment.missionId, executionId: assignment.executionId ?? undefined }
      : undefined,
    {
      assignmentId: assignment.assignmentId,
      leaseOwner: assignment.leaseOwner,
      leaseToken: assignment.leaseToken,
    },
  );
}
async function runProjectBrainProcess(
  executable,
  args,
  cwd,
  timeoutMs,
  maxOutputBytes,
  leaseState,
  durableOutput,
) {
  const startedEpochMs = Date.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let exceeded = false;
    const collect = (target, durablePath) => (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        exceeded = true;
        child.kill("SIGKILL");
      } else {
        target.push(chunk);
        if (durablePath) appendFileSync(durablePath, chunk, { mode: 0o600 });
      }
    };
    child.stdout.on("data", collect(stdout, durableOutput?.stdoutPath));
    child.stderr.on("data", collect(stderr, durableOutput?.stderrPath));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const leaseGuard = setInterval(() => {
      if (leaseState.lost) child.kill("SIGKILL");
    }, 250);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(leaseGuard);
      resolveResult({
        startedEpochMs,
        completedEpochMs: Date.now(),
        exitCode: code,
        signal,
        exceeded,
        timedOut: signal === "SIGKILL" && !exceeded,
        leaseLost: leaseState.lost,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
function projectBrainRunnerPaths(requestId) {
  const prefix = join(root, `project-brain-runner-${requestId}`);
  return {
    specPath: `${prefix}.spec.json`,
    resultPath: `${prefix}.result.json`,
    lockPath: `${prefix}.lock`,
    pidPath: `${prefix}.pid`,
    cancelPath: `${prefix}.cancel`,
    stdoutPath: `${prefix}.stdout`,
    stderrPath: `${prefix}.stderr`,
  };
}
async function removeProjectBrainRunnerEvidence(paths) {
  if (!paths) return;
  await Promise.all([
    rm(paths.specPath, { force: true }),
    rm(paths.resultPath, { force: true }),
    rm(paths.lockPath, { force: true }),
    rm(paths.pidPath, { force: true }),
    rm(paths.cancelPath, { force: true }),
    rm(paths.stdoutPath, { force: true }),
    rm(paths.stderrPath, { force: true }),
  ]);
}
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function runDurableProjectBrainProcess(
  requestId,
  executable,
  args,
  cwd,
  timeoutMs,
  maxOutputBytes,
  leaseState,
) {
  const paths = projectBrainRunnerPaths(requestId);
  let currentState = {};
  try {
    currentState = await protectedJson(statePath);
  } catch {}
  const existing = currentState.projectBrainInFlight ?? {};
  try {
    await stat(paths.specPath);
  } catch {
    await writeFile(
      paths.specPath,
      JSON.stringify({ executable, args, cwd, timeoutMs, maxOutputBytes }),
      { mode: 0o600 },
    );
  }
  await updateState({
    projectBrainInFlight: {
      ...existing,
      runner: paths,
    },
  });
  let result;
  try {
    result = await protectedJson(paths.resultPath);
  } catch {}
  if (!result) {
    let locked = false;
    try {
      await stat(paths.lockPath);
      locked = true;
    } catch {}
    if (locked) {
      const pid = Number(await readFile(paths.pidPath, "utf8").catch(() => ""));
      if (!processIsAlive(pid)) {
        const currentStatus = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
        if (currentStatus !== String(existing.statusBefore ?? ""))
          throw new Error(
            "project_brain_reconciliation_required: durable runner stopped after repository bytes changed",
          );
        await Promise.all([
          rm(paths.lockPath, { force: true }),
          rm(paths.pidPath, { force: true }),
          rm(paths.stdoutPath, { force: true }),
          rm(paths.stderrPath, { force: true }),
        ]);
        locked = false;
      }
    }
    if (!locked) {
      const runner = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "internal-project-brain-runner", paths.specPath, paths.resultPath],
        { detached: true, stdio: "ignore", env: { ...process.env, MISSION_AGENT_HOME: root } },
      );
      runner.unref();
    }
    const deadline = Date.now() + timeoutMs + 10_000;
    while (!result && Date.now() < deadline) {
      if (leaseState.lost) await writeFile(paths.cancelPath, "lease_lost\n", { mode: 0o600 });
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      try {
        result = await protectedJson(paths.resultPath);
      } catch {}
    }
  }
  if (!result)
    throw new Error(
      "project_brain_reconciliation_required: durable runner has not produced a terminal result",
    );
  return result;
}
async function internalProjectBrainRunner(specPath, resultPath) {
  const expected = projectBrainRunnerPaths(basename(specPath).replace(/^project-brain-runner-/, "").replace(/\.spec\.json$/, ""));
  if (resolve(specPath) !== resolve(expected.specPath) || resolve(resultPath) !== resolve(expected.resultPath))
    throw new Error("Project Brain runner paths are invalid.");
  try {
    await writeFile(expected.lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") return;
    throw error;
  }
  await writeFile(expected.pidPath, `${process.pid}\n`, { mode: 0o600 });
  await writeFile(expected.stdoutPath, "", { mode: 0o600 });
  await writeFile(expected.stderrPath, "", { mode: 0o600 });
  const spec = await protectedJson(expected.specPath);
  const leaseState = { lost: false };
  const cancelPoll = setInterval(async () => {
    try {
      await stat(expected.cancelPath);
      leaseState.lost = true;
    } catch {}
  }, 100);
  cancelPoll.unref();
  const result = await runProjectBrainProcess(
    String(spec.executable),
    Array.isArray(spec.args) ? spec.args.map(String) : [],
    String(spec.cwd),
    Number(spec.timeoutMs),
    Number(spec.maxOutputBytes),
    leaseState,
    { stdoutPath: expected.stdoutPath, stderrPath: expected.stderrPath },
  );
  clearInterval(cancelPoll);
  const temporary = `${expected.resultPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await rename(temporary, expected.resultPath);
}
async function executeRemoteProjectBrain(config, assignment) {
  const request = assignment;
  let state = {};
  try {
    state = await protectedJson(statePath);
  } catch {}
  validateRemoteProjectBrainAuthoritySnapshot(config, request, state);
  if (!validRemoteProjectBrainRequestShape(request))
    throw new Error("Remote Project Brain request structure is invalid.");
  const unsigned = { ...request };
  delete unsigned.assignmentId;
  delete unsigned.leaseOwner;
  delete unsigned.leaseToken;
  delete unsigned.leaseExpiresAt;
  delete unsigned.requestChecksum;
  delete unsigned.missionControlSignature;
  const computedRequestChecksum = sha256(canonicalJson(unsigned));
  if (!equalChecksum(computedRequestChecksum, request.requestChecksum)) {
    if (process.env.MISSION_AGENT_DEBUG_REQUEST === "1")
      await writeFile(join(root, "request-debug.json"), JSON.stringify(unsigned, null, 2), { mode: 0o600 });
    throw new Error("Remote Project Brain request checksum is invalid.");
  }
  if (
    !equalChecksum(
      createHmac("sha256", sha256(config.secret)).update(request.requestChecksum).digest("hex"),
      request.missionControlSignature,
    )
  )
    throw new Error("Remote Project Brain request signature is invalid.");
  if (
    request.workspaceId !== config.workspaceId ||
    request.agentId !== config.agentId ||
    request.idempotencyKey !== `project-brain:${request.operationId}` ||
    !projectBrainOperations.includes(request.operation)
  )
    throw new Error("Remote Project Brain request identity, expiry, or operation is invalid.");
  const repository = config.repositories?.[request.repositoryId];
  if (
    !repository ||
    request.repositoryLocator !== `mission-agent://${repository.fingerprint}` ||
    request.repositoryFingerprint !== repository.fingerprint
  )
    throw new Error("Remote Project Brain repository registration does not match.");
  const cached = state.projectBrainReceipts?.[request.idempotencyKey];
  if (cached) {
    if (cached.requestChecksum !== request.requestChecksum)
      throw new Error("Remote Project Brain idempotency key was reused with different input.");
    const delivered = await projectBrainMessage(config, assignment, cached.messageType, { response: cached.response });
    if (!callbackConfirmsTerminal(delivered, cached.messageType))
      throw new Error("Mission Control did not confirm the cached Project Brain terminal result.");
    await markProjectBrainReceiptAcknowledged(request.idempotencyKey);
    await updateState({ activeProjectBrainAssignment: null });
    return delivered;
  }
  const recoveredProcess =
    state.projectBrainInFlight?.requestId === request.requestId &&
    state.projectBrainInFlight?.requestChecksum === request.requestChecksum
      ? state.projectBrainInFlight
      : undefined;
  if (Date.parse(request.expiresAt) <= Date.now() && !recoveredProcess)
    throw new Error("Remote Project Brain request expiry is invalid.");
  if (!isAbsolute(repository.path)) throw new Error("Remote Project Brain checkout mapping must be absolute.");
  const configuredPath = resolve(repository.path);
  const checkout = await realpath(configuredPath);
  if (checkout !== configuredPath || relative(dirname(checkout), checkout).startsWith(".."))
    throw new Error("Remote Project Brain checkout mapping is unsafe.");
  if (exec("git", ["rev-parse", "--show-toplevel"], checkout) !== checkout)
    throw new Error("Remote Project Brain checkout containment validation failed.");
  const currentRepository = inspectRepository(checkout);
  if (
    (repository.identityVersion === "stable-v2"
      ? currentRepository.fingerprint !== repository.fingerprint
      : currentRepository.legacyFingerprint !== repository.fingerprint) ||
    currentRepository.name !== repository.name ||
    currentRepository.remoteUrl !== repository.remoteUrl
  )
    throw new Error("Remote Project Brain repository identity changed after registration.");
  const startingSha = exec("git", ["rev-parse", "HEAD"], checkout);
  let recoveredArtifactCommit = recoveredProcess?.artifactCommit;
  if (
    !recoveredArtifactCommit &&
    recoveredProcess?.versioningIntent &&
    startingSha === request.startingSha
  ) {
    recoveredArtifactCommit = await finishProjectBrainArtifactVersioning(
      checkout,
      recoveredProcess.versioningIntent,
    );
    await updateState({
      projectBrainInFlight: {
        ...recoveredProcess,
        artifactCommit: recoveredArtifactCommit,
      },
    });
  }
  if (
    !recoveredArtifactCommit &&
    recoveredProcess?.versioningIntent &&
    startingSha !== request.startingSha
  ) {
    const intent = recoveredProcess.versioningIntent;
    const committedPaths = exec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], checkout)
      .split("\n")
      .filter(Boolean);
    if (
      exec("git", ["rev-parse", "HEAD^"], checkout) !== intent.parentSha ||
      intent.parentSha !== request.startingSha ||
      committedPaths.length !== intent.paths.length ||
      committedPaths.some((path) => !intent.paths.includes(path))
    )
      throw new Error("Remote Project Brain artifact commit recovery could not verify the exact transition.");
    for (const path of intent.paths)
      if (sha256(await readFile(join(checkout, path))) !== intent.checksums[path])
        throw new Error("Remote Project Brain artifact commit recovery found changed bytes.");
    recoveredArtifactCommit = {
      parentSha: intent.parentSha,
      commitSha: startingSha,
      paths: intent.paths,
      checksums: intent.checksums,
    };
  }
  if (startingSha !== request.startingSha && recoveredArtifactCommit?.commitSha !== startingSha)
    throw new Error("Remote Project Brain repository HEAD changed.");
  const authorization = request.authorization ?? {};
  const policyDecision = request.policyDecision ?? {};
  const writing =
    request.operation === "prepare_context"
      ? request.arguments?.write === true
      : projectBrainWriteOperations.includes(request.operation);
  if (request.operation === "prepare_context" && request.arguments?.preview === true && request.arguments?.write === true)
    throw new Error("Remote Project Brain context preview cannot also request a write.");
  const approvalFingerprint = sha256(
    canonicalJson({
      repositoryId: request.repositoryId,
      missionId: request.missionId,
      executionId: request.executionId,
      agentId: request.agentId,
      operation: request.operation,
      arguments: request.arguments ?? {},
      startingSha: request.startingSha,
      locationMode: "mission_agent",
      expectedWriteScope: request.requestedArtifactTypes,
      timeoutMs: Number(request.timeoutMs),
      maxOutputBytes: Number(request.maxOutputBytes),
      requiredProjectBrainVersion: request.requiredProjectBrainVersion,
      requiredContractVersion: request.requiredContractVersion,
      artifactVersioning: request.artifactVersioning,
    }),
  );
  if (
    authorization.allowedAgent !== true ||
    policyDecision.outcome !== "allowed" ||
    policyDecision.action !== (writing ? "project_brain.repository_write" : "project_brain.read") ||
    authorization.repositoryReadAllowed !== true ||
    authorization.resourcePermission !== true ||
    authorization.requiredPermission !== (writing ? "write" : "read") ||
    (writing &&
      (authorization.repositoryWriteAllowed !== true ||
        authorization.repositoryCommitAllowed !== true ||
        request.artifactVersioning !== true ||
        repository.projectBrainWriteAllowed !== true ||
        !request.approvalId ||
        request.approvalFingerprint !== approvalFingerprint))
  )
    throw new Error("Remote Project Brain authorization snapshot is not permitted.");
  if (
    writing &&
    !recoveredProcess &&
    authorization.approvalExpiresAt &&
    Date.parse(authorization.approvalExpiresAt) <= Date.now()
  )
    throw new Error("Remote Project Brain approval expired.");
  const statusBefore =
    recoveredProcess?.statusBefore ?? exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], checkout);
  const priorArtifacts = await verifiedPriorProjectBrainArtifacts(
    state,
    checkout,
    statusBefore,
    request.repositoryId,
    request.repositoryLocator,
  );
  const caps = projectBrainCapabilities(config);
  if (
    !recoveredProcess &&
    (!caps.installed ||
      !caps.runtimeReady ||
      caps.coreVersion !== request.requiredProjectBrainVersion ||
      !caps.contractVersions.includes(request.requiredContractVersion) ||
      request.requiredSchemaVersions.some((version) => !caps.schemaVersions.includes(version)) ||
      !caps.operations.includes(request.operation))
  )
    throw new Error("Remote Project Brain runtime capabilities are incompatible.");
  if ((state.projectBrainNonces ?? []).includes(request.nonce) && !recoveredProcess)
    throw new Error("Remote Project Brain request nonce was replayed.");
  const runnerPaths = recoveredProcess?.runner ?? projectBrainRunnerPaths(request.requestId);
  let durableTerminalResult;
  if (recoveredProcess)
    try {
      durableTerminalResult = await protectedJson(runnerPaths.resultPath);
    } catch {}
  if (!durableTerminalResult) {
    let liveAuthorization;
    try {
      liveAuthorization = await signedRequest(
        config,
        `/api/agent-protocol/v1/project-brain/${assignment.assignmentId}/reauthorize`,
        "AgentProjectBrainReauthorizationRequested",
        {
          leaseOwner: assignment.leaseOwner,
          leaseToken: assignment.leaseToken,
          requestChecksum: request.requestChecksum,
        },
      );
    } catch (error) {
      if (recoveredProcess?.runner) {
        await writeFile(runnerPaths.cancelPath, "authority_revoked\n", { mode: 0o600 });
        throw new Error(
          `project_brain_reconciliation_required: live authority was revoked while durable work remained (${error.message})`,
        );
      }
      throw error;
    }
    if (
      liveAuthorization?.authorized !== true ||
      liveAuthorization.requestFingerprint !== approvalFingerprint
    ) {
      if (recoveredProcess?.runner) {
        await writeFile(runnerPaths.cancelPath, "authority_revoked\n", { mode: 0o600 });
        throw new Error(
          "project_brain_reconciliation_required: live authority was revoked while durable work remained",
        );
      }
      throw new Error("Remote Project Brain live reauthorization did not match the signed request.");
    }
  }
  if (!recoveredProcess)
    await updateState({
      projectBrainNonces: [...(state.projectBrainNonces ?? []).slice(-999), request.nonce],
      activeProjectBrainAssignment: assignment,
      projectBrainInFlight: {
        requestId: request.requestId,
        requestChecksum: request.requestChecksum,
        startedAt: new Date().toISOString(),
        startedEpochMs: Date.now(),
        statusBefore: exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], checkout),
        result: null,
      },
    });
  await projectBrainMessage(config, assignment, "RemoteProjectBrainOperationAccepted");
  await projectBrainMessage(config, assignment, "RemoteProjectBrainOperationStarted");
  const leaseState = { lost: false };
  const leaseTimer = setInterval(
    () =>
      void signedRequest(
        config,
        `/api/agent-protocol/v1/project-brain/${assignment.assignmentId}/lease`,
        "AgentProjectBrainLeaseRenewed",
        { leaseOwner: assignment.leaseOwner, leaseToken: assignment.leaseToken },
      ).catch(() => {
        leaseState.lost = true;
      }),
    30_000,
  );
  leaseTimer.unref();
  const startedAt = recoveredProcess?.startedAt ?? new Date().toISOString();
  const started = recoveredProcess?.startedEpochMs ?? Date.now();
  let result = recoveredProcess?.result ?? durableTerminalResult;
  if (!result)
    try {
      result = await runDurableProjectBrainProcess(
        request.requestId,
        config.projectBrainExecutable,
        [
          "consumer",
          "--operation",
          request.operation,
          "--repo",
          checkout,
          "--contract-version",
          request.requiredContractVersion,
          "--request-json",
          JSON.stringify(request.arguments ?? {}),
        ],
        checkout,
        Math.min(Number(request.timeoutMs), 3_600_000),
        Math.min(Number(request.maxOutputBytes), caps.maxResultBytes),
        leaseState,
      );
      await updateState({
        projectBrainInFlight: {
          requestId: request.requestId,
          requestChecksum: request.requestChecksum,
          startedAt,
          startedEpochMs: started,
          statusBefore,
          runner: recoveredProcess?.runner ?? projectBrainRunnerPaths(request.requestId),
          result,
        },
      });
    } finally {
      clearInterval(leaseTimer);
    }
  else clearInterval(leaseTimer);
  if (result.timedOut) throw new Error("Remote Project Brain operation timed out.");
  if (result.leaseLost) throw new Error("Remote Project Brain lease was lost during execution.");
  if (result.exceeded) throw new Error("Remote Project Brain operation exceeded its output bound.");
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw new Error("Remote Project Brain returned invalid JSON.");
  }
  if (
    !envelope ||
    envelope.operation !== request.operation ||
    envelope.contract_version !== request.requiredContractVersion ||
    !["succeeded", "failed"].includes(envelope.status) ||
    !Array.isArray(envelope.artifacts) ||
    !Array.isArray(envelope.warnings) ||
    !Array.isArray(envelope.blockers) ||
    typeof envelope.repository_files_changed !== "boolean"
  )
    throw new Error("Remote Project Brain returned an invalid consumer envelope.");
  let endingSha = exec("git", ["rev-parse", "HEAD"], checkout);
  if (endingSha !== request.startingSha && recoveredArtifactCommit?.commitSha !== endingSha)
    throw new Error("Remote Project Brain changed repository HEAD.");
  if (
    !envelope.repository ||
    (await realpath(String(envelope.repository.checkout_path ?? ""))) !== checkout ||
    envelope.repository.head_sha !== request.startingSha ||
    envelope.repository.ending_head_sha !== request.startingSha
  )
    throw new Error("Remote Project Brain repository binding is invalid.");
  const statusAfter = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], checkout);
  if (!writing && statusAfter !== statusBefore)
    throw new Error("A read-only Project Brain operation changed repository files.");
  if (writing) {
    const artifactPaths = new Set(envelope.artifacts.map((artifact) => String(artifact.path ?? "")));
    const changedPaths = statusAfter
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    if (changedPaths.some((changedPath) => !artifactPaths.has(changedPath) && !priorArtifacts.has(changedPath)))
      throw new Error("Project Brain changed files outside the approved artifact scope.");
    for (const [path, expected] of priorArtifacts)
      if (
        changedPaths.includes(path) &&
        !artifactPaths.has(path) &&
        sha256(await readFile(join(checkout, path))) !== expected
      )
        throw new Error("Project Brain changed a prior verified artifact outside the current operation scope.");
  }
  const artifacts = [];
  let artifactBytes = 0;
  for (const artifact of envelope.artifacts) {
    const verified = await verifiedRemoteProjectBrainArtifact(
      checkout,
      artifact,
      projectBrainArtifactKinds[request.operation] ?? [],
      request.requiredSchemaVersions,
      artifactBytes,
      Number(request.maxOutputBytes),
    );
    const { body } = verified;
    artifactBytes = verified.totalBytes;
    artifacts.push({
      ...artifact,
      size: body.byteLength,
      transfer_mode: "inline_base64",
      content_base64: body.toString("base64"),
    });
  }
  const aggregateLimit = Math.min(Number(request.maxOutputBytes), Number(caps.maxResultBytes), 10 * 1024 * 1024);
  if (
    Buffer.byteLength(
      canonicalJson({
        envelope: { ...envelope, artifacts },
        process: {
          exitCode: result.exitCode,
          stdoutSha256: sha256(result.stdout),
          stderrSha256: sha256(result.stderr),
        },
        artifactCommitBudget: "x".repeat(4_096),
      }),
    ) > aggregateLimit
  )
    throw new Error("Remote Project Brain serialized response exceeded the negotiated aggregate result bound.");
  let artifactCommit = recoveredArtifactCommit;
  if (
    result.exitCode === 0 &&
    envelope.status === "succeeded" &&
    writing &&
    request.artifactVersioning === true &&
    artifacts.length &&
    !artifactCommit
  ) {
    artifactCommit = await versionAcknowledgedProjectBrainArtifacts(config, request.repositoryId, checkout, artifacts);
    if (artifactCommit.parentSha !== request.startingSha)
      throw new Error("Project Brain artifact commit parent did not match the approved starting SHA.");
    endingSha = artifactCommit.commitSha;
  }
  if (artifactCommit && recoveredProcess) await registerRepository(config, checkout).catch(() => undefined);
  for (const artifact of artifacts) artifact.repository_sha = endingSha;
  envelope = {
    ...envelope,
    repository: {
      id: request.repositoryId,
      checkout_path: request.repositoryLocator,
      head_sha: request.startingSha,
      ending_head_sha: endingSha,
    },
    artifacts,
  };
  const processDurationMs = Math.max(
    0,
    Number(result.completedEpochMs ?? Date.now()) - Number(result.startedEpochMs ?? started),
  );
  const responseWithoutChecksum = {
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestChecksum: request.requestChecksum,
    startedAt,
    completedAt: new Date().toISOString(),
    startingSha: request.startingSha,
    endingSha,
    projectBrainVersion: caps.coreVersion || request.requiredProjectBrainVersion,
    schemaVersions: caps.schemaVersions.length ? caps.schemaVersions : request.requiredSchemaVersions,
    durationMs: processDurationMs,
    process: {
      exitCode: result.exitCode,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    },
    ...(artifactCommit ? { artifactCommit } : {}),
    envelope,
  };
  if (
    Buffer.byteLength(canonicalJson(responseWithoutChecksum)) >
    aggregateLimit
  )
    throw new Error("Remote Project Brain serialized response exceeded the negotiated aggregate result bound.");
  const response = { ...responseWithoutChecksum, responseChecksum: sha256(canonicalJson(responseWithoutChecksum)) };
  const messageType =
    result.exitCode === 0 && envelope.status === "succeeded"
      ? "RemoteProjectBrainOperationSucceeded"
      : "RemoteProjectBrainOperationFailed";
  await updateState({
    activeProjectBrainAssignment: assignment,
    projectBrainInFlight: null,
    projectBrainReceipts: {
      ...(state.projectBrainReceipts ?? {}),
      [request.idempotencyKey]: {
        requestChecksum: request.requestChecksum,
        messageType,
        response,
        centralAcknowledged: false,
      },
    },
  });
  await removeProjectBrainRunnerEvidence(
    recoveredProcess?.runner ?? projectBrainRunnerPaths(request.requestId),
  );
  const delivered = await projectBrainMessage(config, assignment, messageType, { response });
  if (!callbackConfirmsTerminal(delivered, messageType))
    throw new Error("Mission Control did not confirm the Project Brain terminal result.");
  await markProjectBrainReceiptAcknowledged(request.idempotencyKey);
  await updateState({ activeProjectBrainAssignment: null });
  return delivered;
}
async function publishForReview(config, publication) {
  const repository = config.repositories?.[publication.repositoryId];
  if (!repository) throw new Error("The approved publication repository is not registered on this Mission Agent.");
  const worktreePath = join(root, "worktrees", publication.executionId);
  const resolved = await realpath(worktreePath);
  if (resolved !== worktreePath) throw new Error("The review worktree path changed after approval.");
  const commit = exec("git", ["rev-parse", "HEAD"], resolved);
  const branch = exec("git", ["branch", "--show-current"], resolved);
  if (commit !== publication.commit || branch !== publication.branch)
    throw new Error("The local branch or commit changed after Publish for Review was approved.");
  if (exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved))
    throw new Error("The review worktree changed after approval. Generate a new publication approval.");
  if (publication.force === true) throw new Error("Force push is never permitted.");
  const remoteUrl = exec("git", ["remote", "get-url", publication.remote], resolved).replace(
    /\/\/[^/@]+@/,
    "//[redacted]@",
  );
  if (normalizedRemote(remoteUrl) !== normalizedRemote(publication.remoteIdentity))
    throw new Error("The repository remote changed after approval.");
  const target = exec(
    "git",
    ["ls-remote", "--heads", publication.remote, `refs/heads/${publication.targetBranch}`],
    resolved,
  ).split(/\s+/)[0];
  if (target !== publication.baseCommit)
    throw new Error("The pull-request target moved after approval. Generate a new publication approval.");
  const patch = spawnSync("git", ["diff", "--binary", `${publication.baseCommit}..${publication.commit}`], {
    cwd: resolved,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (
    patch.status !== 0 ||
    sha256(patch.stdout) !== publication.evidence.find((item) => item.kind === "git_patch")?.checksum
  )
    throw new Error("The local diff no longer matches the approved evidence checksum.");
  const before = spawnSync("git", ["ls-remote", "--heads", publication.remote, `refs/heads/${publication.branch}`], {
    cwd: resolved,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (before.status !== 0) throw new Error("The approved remote could not be inspected.");
  const existing = before.stdout.trim().split(/\s+/)[0];
  if (existing && existing !== publication.commit)
    throw new Error("The remote branch exists at a different commit. Force push remains prohibited.");
  if (!existing) {
    const pushed = spawnSync(
      "git",
      ["push", publication.remote, `${publication.commit}:refs/heads/${publication.branch}`],
      {
        cwd: resolved,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    if (pushed.status !== 0)
      throw new Error(`Git push failed without force: ${pushed.stderr?.trim() ?? "unknown error"}`);
  }
  const confirmed = exec(
    "git",
    ["ls-remote", "--heads", publication.remote, `refs/heads/${publication.branch}`],
    resolved,
  ).split(/\s+/)[0];
  if (confirmed !== publication.commit) throw new Error("The remote did not confirm the exact approved commit.");
  if (spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0)
    throw new Error(
      "GitHub CLI is required to create the approved pull request. Install gh, authenticate it, and retry.",
    );
  const existingPullRequests = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      publication.providerRepository,
      "--head",
      publication.branch,
      "--base",
      publication.targetBranch,
      "--state",
      "all",
      "--json",
      "number,url,headRefOid",
    ],
    { cwd: resolved, encoding: "utf8", timeout: 60_000 },
  );
  if (existingPullRequests.status !== 0)
    throw new Error(`GitHub pull-request lookup failed: ${existingPullRequests.stderr?.trim() ?? "unknown error"}`);
  let pullRequest = JSON.parse(existingPullRequests.stdout)[0];
  if (!pullRequest) {
    const created = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        publication.providerRepository,
        "--head",
        publication.branch,
        "--base",
        publication.targetBranch,
        "--title",
        publication.title,
        "--body",
        publication.description,
      ],
      { cwd: resolved, encoding: "utf8", timeout: 60_000 },
    );
    if (created.status !== 0)
      throw new Error(`GitHub pull-request creation failed: ${created.stderr?.trim() ?? "unknown error"}`);
    const viewed = spawnSync(
      "gh",
      ["pr", "view", publication.branch, "--repo", publication.providerRepository, "--json", "number,url,headRefOid"],
      { cwd: resolved, encoding: "utf8", timeout: 60_000 },
    );
    if (viewed.status !== 0) throw new Error("GitHub did not confirm pull-request creation.");
    pullRequest = JSON.parse(viewed.stdout);
  }
  if (pullRequest.headRefOid !== publication.commit)
    throw new Error("GitHub pull-request head does not match the approved commit.");
  await signedRequest(config, "/api/agent-protocol/v1/publications/complete", "AgentPublicationPushCompleted", {
    actionRequestId: publication.actionRequestId,
    branch: publication.branch,
    commit: publication.commit,
    remoteCommit: confirmed,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    pullRequestHeadSha: pullRequest.headRefOid,
  });
  await updateState({ stage: "pull_request_open", lastPublication: publication.actionRequestId, lastError: null });
}
async function run() {
  let config = await loadConfig();
  await heartbeat(config);
  const heartbeatTimer = setInterval(
    () =>
      void heartbeat(config).catch((error) =>
        updateState({ connected: false, lastError: `Heartbeat failed: ${error.message}` }),
      ),
    60_000,
  );
  heartbeatTimer.unref();
  let recovered;
  let recoveredProjectBrain;
  try {
    const state = await protectedJson(statePath);
    recovered =
      state.activeAssignment && typeof state.activeAssignment === "object" ? state.activeAssignment : undefined;
    recoveredProjectBrain =
      state.activeProjectBrainAssignment && typeof state.activeProjectBrainAssignment === "object"
        ? state.activeProjectBrainAssignment
        : undefined;
  } catch {}
  if (recoveredProjectBrain) {
    try {
      await signedRequest(
        config,
        `/api/agent-protocol/v1/project-brain/${recoveredProjectBrain.assignmentId}/lease`,
        "AgentProjectBrainLeaseRenewed",
        {
          leaseOwner: recoveredProjectBrain.leaseOwner,
          leaseToken: recoveredProjectBrain.leaseToken,
        },
      );
      await executeRemoteProjectBrain(config, recoveredProjectBrain);
      if (process.argv.includes("--once")) return;
    } catch (error) {
      let hasCachedResult = false;
      try {
        const latestState = await protectedJson(statePath);
        hasCachedResult = Boolean(latestState.projectBrainReceipts?.[recoveredProjectBrain.idempotencyKey]);
      } catch {}
      const reconciliationRequired = String(error?.message ?? "").startsWith(
        "project_brain_reconciliation_required:",
      );
      await updateState({
        activeProjectBrainAssignment: reconciliationRequired ? recoveredProjectBrain : null,
        stage: "project_brain_recovering",
        lastError: hasCachedResult
          ? `Cached Project Brain result is waiting for a fresh assignment lease: ${error.message}`
          : `Prior Project Brain lease could not be recovered: ${error.message}`,
      });
    }
  }
  if (recovered) {
    try {
      const renewed = await assignmentAction(config, recovered, "lease", "AgentAssignmentLeaseRenewed");
      recovered.leaseExpiresAt = renewed.leaseExpiresAt;
      await work(config, recovered);
      if (process.argv.includes("--once")) return;
    } catch {
      await updateState({
        activeAssignment: null,
        stage: "recovering",
        lastError: "Prior lease could not be recovered",
      });
    }
  }
  for (;;) {
    try {
      // Repository registrations can be added by a separate CLI process while
      // the service is running. Refresh protected configuration before pulling
      // work so a newly registered repository is immediately assignable.
      config = await loadConfig();
      let pendingProjectBrain;
      try {
        const latestState = await protectedJson(statePath);
        pendingProjectBrain = latestState.activeProjectBrainAssignment;
      } catch {}
      if (pendingProjectBrain && typeof pendingProjectBrain === "object") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        try {
          await executeRemoteProjectBrain(config, pendingProjectBrain);
        } catch (error) {
          let hasCachedResult = false;
          try {
            const latestState = await protectedJson(statePath);
            hasCachedResult = Boolean(
              latestState.projectBrainReceipts?.[pendingProjectBrain.idempotencyKey],
            );
          } catch {}
          if (!hasCachedResult) throw error;
          await updateState({
            activeProjectBrainAssignment: null,
            stage: "project_brain_awaiting_fresh_lease",
            lastError: `Cached Project Brain result requires a fresh assignment lease: ${error.message}`,
          });
        }
        if (process.argv.includes("--once")) return;
        continue;
      }
      const projectBrainResponse = await signedRequest(
        config,
        "/api/agent-protocol/v1/project-brain/pull",
        "AgentProjectBrainPullRequested",
        { leaseOwner: config.leaseOwner },
      );
      if (projectBrainResponse?.assignment) {
        try {
          await executeRemoteProjectBrain(config, projectBrainResponse.assignment);
        } catch (error) {
          let cachedTerminal = false;
          let cachedReceipt;
          try {
            const latestState = await protectedJson(statePath);
            cachedReceipt = latestState.projectBrainReceipts?.[projectBrainResponse.assignment.idempotencyKey];
            cachedTerminal = Boolean(cachedReceipt);
          } catch {}
          if (cachedTerminal) {
            await updateState({
              stage: "project_brain_callback_retry",
              lastError: `Project Brain result is cached for retry: ${error.message}`,
            });
            await projectBrainMessage(
              config,
              projectBrainResponse.assignment,
              cachedReceipt.messageType,
              { response: cachedReceipt.response },
            )
              .then(async (acknowledgement) => {
                if (!callbackConfirmsTerminal(acknowledgement, cachedReceipt.messageType))
                  throw new Error("Mission Control terminal result did not match the cached callback.");
                await markProjectBrainReceiptAcknowledged(projectBrainResponse.assignment.idempotencyKey);
                await updateState({ activeProjectBrainAssignment: null, stage: "project_brain_completed" });
              })
              .catch(() => undefined);
            if (process.argv.includes("--once")) return;
            continue;
          }
          if (String(error?.message ?? "").startsWith("project_brain_reconciliation_required:")) {
            await updateState({
              activeProjectBrainAssignment: projectBrainResponse.assignment,
              stage: "project_brain_recovering",
              lastError: error.message,
            });
            if (process.argv.includes("--once")) return;
            continue;
          }
          const denied = /signature|identity|expiry|operation|registration|mapping|authorization|approval|capabilit/i.test(
            error.message,
          );
          await projectBrainMessage(
            config,
            projectBrainResponse.assignment,
            denied ? "RemoteProjectBrainOperationDenied" : "RemoteProjectBrainOperationFailed",
            { error: error.message },
          ).catch(() => undefined);
          await updateState({
            activeProjectBrainAssignment: null,
            stage: "project_brain_failed",
            lastError: error.message,
          });
        }
        if (process.argv.includes("--once")) return;
      }
      const publicationResponse = await signedRequest(
        config,
        "/api/agent-protocol/v1/publications/pull",
        "AgentPublicationPullRequested",
      );
      if (publicationResponse?.publication) {
        try {
          await publishForReview(config, publicationResponse.publication);
        } catch (error) {
          await signedRequest(config, "/api/agent-protocol/v1/publications/fail", "AgentPublicationFailed", {
            actionRequestId: publicationResponse.publication.actionRequestId,
            summary: error.message,
          });
          await updateState({ stage: "publication_failed", lastError: error.message });
        }
      }
      const response = await signedRequest(
        config,
        "/api/agent-protocol/v1/assignments/pull",
        "AgentAssignmentPullRequested",
        { leaseOwner: config.leaseOwner, waitSeconds: 20 },
      );
      if (response?.assignment) {
        await work(config, response.assignment);
        if (process.argv.includes("--once")) return;
      } else if (process.argv.includes("--once")) return;
      else await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
    } catch (error) {
      await updateState({ connected: false, lastError: error.message });
      if (process.argv.includes("--once")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 + Math.random() * 5000));
    }
  }
}
async function status() {
  const config = await loadConfig();
  let state = {};
  try {
    state = await protectedJson(statePath);
  } catch {}
  console.log(
    `Mission Control: ${config.missionControlUrl}\nAgent: ${config.agentName}\nAdapter: ${config.adapter}\nConnected: ${state.connected ? "yes" : "no"}\nLast heartbeat: ${state.lastHeartbeatAt ?? "never"}\nPolling: ${state.pullReady ? "active" : "inactive"}\nActive assignment: ${state.activeAssignment?.assignmentId ?? state.activeAssignment ?? "none"}\nLease expiration: ${state.leaseExpiresAt ?? "none"}\nStage: ${state.stage ?? "idle"}\nLast error: ${state.lastError ?? "none"}\nVersion: ${VERSION}`,
  );
}
async function doctor() {
  const checks = [];
  checks.push([Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.version}`]);
  let config;
  try {
    config = await loadConfig();
    checks.push([true, "Protected configuration"]);
  } catch (error) {
    checks.push([false, error.message]);
  }
  checks.push([spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0, "Git executable"]);
  checks.push([
    config?.adapter === "grok"
      ? spawnSync("grok", ["--version"], { stdio: "ignore" }).status === 0
      : spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0,
    config?.adapter === "grok" ? "Grok executable" : "Codex executable",
  ]);
  if (config) {
    try {
      await heartbeat(config);
      checks.push([true, "Mission Control signature and heartbeat"]);
    } catch (error) {
      checks.push([false, `Mission Control: ${error.message}`]);
    }
    for (const repository of Object.values(config.repositories ?? {})) {
      try {
        inspectRepository(repository.path);
        checks.push([true, `Repository ${repository.name}`]);
      } catch (error) {
        checks.push([false, `Repository: ${error.message}`]);
      }
    }
  }
  for (const [ok, label] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (checks.some(([ok]) => !ok)) process.exitCode = 1;
}
async function logout() {
  if (!process.argv.includes("--yes"))
    throw new Error("Run mission-agent logout --yes to remove this local credential.");
  let config;
  try {
    config = await protectedJson(configPath);
  } catch {}
  if (config?.secretStorage === "keychain")
    spawnSync("security", ["delete-generic-password", "-a", config.agentId, "-s", "Mission Agent"], {
      stdio: "ignore",
    });
  await rm(root, { recursive: true, force: true });
  console.log("Mission Agent local credentials removed.");
}

async function repositoryList() {
  const config = await loadConfig();
  const entries = Object.entries(config.repositories ?? {});
  if (!entries.length) return console.log("No repositories registered.");
  for (const [id, repository] of entries)
    console.log(
      `${id}\t${repository.name}\t${normalizedRemote(repository.remoteUrl)}\t${repository.branch ?? "unknown"}`,
    );
}
async function repositoryInspect(id) {
  const config = await loadConfig();
  const repository = config.repositories?.[id];
  if (!repository) throw new Error(`Repository ${id ?? ""} is not registered on this Mission Agent.`);
  const current = inspectRepository(repository.path);
  console.log(
    `Repository: ${id}\nName: ${current.name}\nRemote: ${normalizedRemote(current.remoteUrl)}\nBranch: ${current.branch}\nCommit: ${current.commit}\nAgent: ${config.agentName}`,
  );
}
async function activateRepositoryIdentity(repositoryId) {
  const config = await loadConfig();
  const repository = config.repositories?.[repositoryId];
  const pending = config.repositoryIdentityMigrations?.[repositoryId];
  if (!repository || !pending) throw new Error("A governed migration preview is required before activation.");
  const current = inspectRepository(repository.path);
  const prepared = await signedRequest(config, "/api/agent-protocol/v1/repositories/identity/complete",
    "RepositoryIdentityActivationRequested", {
      migrationId: pending.migrationId, requestFingerprint: pending.requestFingerprint,
      stableFingerprint: current.fingerprint, registeredPath: repository.path, currentHead: current.commit,
    });
  const request = prepared.activationRequest;
  const unsigned = { ...request }; delete unsigned.requestChecksum; delete unsigned.missionControlSignature;
  const checksum = sha256(canonicalJson(unsigned));
  const expectedSignature = createHmac("sha256", sha256(config.secret)).update(checksum).digest("hex");
  const artifact = await artifactIdentity();
  if (request.requestChecksum !== checksum || request.missionControlSignature !== expectedSignature ||
      request.requiredArtifactChecksum !== artifact.sha256 || request.agentVersion !== VERSION ||
      request.repositoryId !== repositoryId || request.stableFingerprint !== current.fingerprint ||
      request.canonicalRemoteUrl !== current.canonicalRemoteUrl || request.repositoryName !== current.name ||
      request.currentHead !== current.commit || request.registeredPath !== repository.path)
    throw new Error("Stable identity activation request verification failed.");
  repository.identityHistory = [...(repository.identityHistory ?? []),
    { identityVersion: repository.identityVersion ?? "legacy-v1", fingerprint: repository.fingerprint }];
  repository.identityVersion = "stable-v2";
  repository.fingerprint = current.fingerprint;
  repository.canonicalRemoteUrl = current.canonicalRemoteUrl;
  repository.identityTransition = { status: "activating", migrationId: pending.migrationId, requestId: request.requestId };
  repository.localActivation = { requestId: request.requestId, activatedAt: new Date().toISOString(),
    legacyFingerprint: request.legacyFingerprint, stableFingerprint: current.fingerprint };
  await persistConfig(config);
  const acknowledgement = await signedRequest(config, "/api/agent-protocol/v1/repositories/identity/acknowledge",
    "RepositoryIdentityActivationAcknowledged", {
      migrationId: pending.migrationId, requestId: request.requestId, activationProtocolVersion: "1",
      agentVersion: VERSION, artifact, repositoryId, legacyFingerprint: request.legacyFingerprint,
      stableFingerprint: current.fingerprint, canonicalRemoteUrl: current.canonicalRemoteUrl,
      repositoryName: current.name, registeredPath: repository.path, currentHead: current.commit,
      permissionSnapshotHash: request.permissionSnapshotHash, projectBrainEnabled: request.projectBrainEnabled,
      activatedAt: repository.localActivation.activatedAt, nonce: randomBytes(18).toString("base64url"),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  if (acknowledgement.status !== "accepted") throw new Error("Stable identity activation acknowledgement was not accepted.");
  await registerRepository(config, repository.path);
  await heartbeat(config);
  delete repository.identityTransition;
  delete config.repositoryIdentityMigrations[repositoryId];
  await persistConfig(config);
  console.log(`Repository identity activated.\n\nRepository: ${repositoryId}\nIdentity: stable-v2\nStatus: ${acknowledgement.status}`);
}

async function rollbackRepositoryIdentity(repositoryId) {
  const config = await loadConfig();
  const repository = config.repositories?.[repositoryId];
  const previous = repository?.identityHistory?.at(-1);
  const resuming = repository?.identityTransition?.status === "rolling_back" && repository?.localRollback?.request;
  if (!repository || (!resuming && (repository.identityVersion !== "stable-v2" || !previous)))
    throw new Error("A completed stable-v2 activation with durable history is required before rollback.");
  const artifact = await artifactIdentity();
  let request = repository.localRollback?.request;
  if (!resuming) {
    const prepared = await signedRequest(config, "/api/agent-protocol/v1/repositories/identity/rollback/prepare",
      "RepositoryIdentityRollbackRequested", {
        repositoryId, stableFingerprint: repository.fingerprint, rollbackFingerprint: previous.fingerprint,
        registeredPath: repository.path, currentHead: exec("git", ["rev-parse", "HEAD"], repository.path),
      });
    request = prepared.rollbackRequest;
    const unsigned = { ...request }; delete unsigned.requestChecksum; delete unsigned.missionControlSignature;
    const checksum = sha256(canonicalJson(unsigned));
    const expectedSignature = createHmac("sha256", sha256(config.secret)).update(checksum).digest("hex");
    if (request.requestChecksum !== checksum || request.missionControlSignature !== expectedSignature ||
        request.agentVersion !== VERSION || request.requiredArtifactChecksum !== artifact.sha256 ||
        request.repositoryId !== repositoryId || request.stableFingerprint !== repository.fingerprint ||
        request.rollbackFingerprint !== previous.fingerprint || request.identityProtocolVersion !== "2" ||
        request.activationProtocolVersion !== "1" || Date.parse(request.expiresAt) <= Date.now())
      throw new Error("Repository identity rollback request verification failed.");
    repository.identityTransition = { status: "rolling_back", startedAt: new Date().toISOString(),
      requestId: request.requestId };
    repository.localRollback = { request, requestId: request.requestId, rolledBackAt: new Date().toISOString(),
      fromIdentityVersion: repository.identityVersion, toIdentityVersion: previous.identityVersion,
      fromFingerprint: repository.fingerprint, toFingerprint: previous.fingerprint };
    repository.identityVersion = previous.identityVersion;
    repository.fingerprint = previous.fingerprint;
    await persistConfig(config);
  }
  const rollback = repository.localRollback;
  const acknowledgement = await signedRequest(config,
    "/api/agent-protocol/v1/repositories/identity/rollback/acknowledge",
    "RepositoryIdentityRollbackAcknowledged", {
      migrationId: request.migrationId, requestId: request.requestId, activationProtocolVersion: "1",
      identityProtocolVersion: "2", agentVersion: VERSION, artifact, repositoryId,
      fromFingerprint: rollback.fromFingerprint, toFingerprint: rollback.toFingerprint,
      rolledBackAt: rollback.rolledBackAt, nonce: randomBytes(18).toString("base64url"),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  if (acknowledgement.status !== "accepted") throw new Error("Repository identity rollback acknowledgement was not accepted.");
  await heartbeat(config);
  delete repository.identityTransition;
  await persistConfig(config);
  console.log(`Repository identity rolled back.\n\nRepository: ${repositoryId}\nIdentity: ${repository.identityVersion}`);
}

async function repositoryAdd(path) {
  const config = await loadConfig();
  const current = inspectRepository(path);
  await registerRepository(config, path);
  console.log(
    `Repository registered.\n\nName: ${current.name}\nRemote: ${normalizedRemote(current.remoteUrl)}\nBranch: ${current.branch}\nAgent: ${config.agentName}\n\nThis repository is now available when launching a mission.`,
  );
}
async function repositoryRemove(id) {
  const config = await loadConfig();
  if (!config.repositories?.[id]) throw new Error(`Repository ${id ?? ""} is not registered on this Mission Agent.`);
  await signedRequest(config, "/api/agent-protocol/v1/repositories/remove", "AgentRepositoryRemoved", {
    repositoryId: id,
  });
  delete config.repositories[id];
  await persistConfig(config);
  console.log(`Repository association removed.\n\nRepository: ${id}\nAgent: ${config.agentName}`);
}
async function configureProjectBrain(executable) {
  if (!executable || !isAbsolute(executable))
    throw new Error("Provide the explicit absolute Project Brain executable path.");
  const resolved = await realpath(executable);
  const config = await loadConfig();
  config.projectBrainExecutable = resolved;
  const repositoryId = option("--allow-write");
  if (repositoryId) {
    if (!config.repositories?.[repositoryId])
      throw new Error("The write-enabled repository must already be registered on this Mission Agent.");
    config.repositories[repositoryId].projectBrainWriteAllowed = true;
  }
  await persistConfig(config);
  const capabilities = projectBrainCapabilities(config);
  if (!capabilities.runtimeReady)
    throw new Error("The configured Project Brain executable did not return valid capabilities.");
  console.log(
    `Project Brain configured.\n\nExecutable: ${resolved}\nCore version: ${capabilities.coreVersion}\nContract versions: ${capabilities.contractVersions.join(", ")}\nRepository writes: ${repositoryId ?? "disabled"}`,
  );
}
async function update() {
  const config = await loadConfig();
  const response = await fetch(`${config.missionControlUrl}/mission-agent-latest.json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Update manifest returned ${response.status}.`);
  const manifestText = await response.text();
  const allowRollbackVersion = option("--allow-rollback-version");
  const verifiedManifest = verifyReleaseManifestText(manifestText, { allowRollbackVersion });
  if (verifiedManifest.version === VERSION) return console.log(`Mission Agent ${VERSION} is current.`);
  const next = verifiedManifest.version.split(".").map(Number);
  const current = VERSION.split(".").map(Number);
  const newer = next.some((part, index) => part > current[index] && next.slice(0, index).every((value, prior) => value === current[prior]));
  if (!newer && verifiedManifest.version !== allowRollbackVersion)
    throw new Error("Release manifest downgrade requires an explicit governed rollback version.");
  const artifact = await fetch(`${config.missionControlUrl}${verifiedManifest.path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!artifact.ok) throw new Error(`Update artifact returned ${artifact.status}.`);
  const source = await artifact.text();
  if (verifiedManifest.manifestVersion === "3" &&
      Buffer.byteLength(source, "utf8") !== verifiedManifest.artifactByteLength)
    throw new Error("Update artifact byte-length verification failed.");
  if (sha256(source) !== verifiedManifest.sha256) throw new Error("Update checksum verification failed.");
  const target = join(root, `mission-agent-${verifiedManifest.version}.mjs`);
  const targetMetadata = `${target}.artifact.json`;
  await writeFile(target, source, { mode: 0o700 });
  if (
    !["1", "3"].includes(verifiedManifest.manifestVersion) ||
    !/^[a-f0-9]{64}$/.test(String(verifiedManifest.sha256 ?? ""))
  )
    throw new Error("Update manifest artifact identity is invalid.");
  await writeFile(
    targetMetadata,
    `${JSON.stringify({
      version: verifiedManifest.version,
      sha256: verifiedManifest.sha256,
      manifestVersion: verifiedManifest.manifestVersion,
      ...(verifiedManifest.manifestVersion === "3" ? {
        artifactByteLength: verifiedManifest.artifactByteLength,
        signingKeyId: verifiedManifest.signingKeyId,
        publicKeyFingerprint: verifiedManifest.publicKeyFingerprint,
        releaseAuthorityVersion: verifiedManifest.releaseAuthorityVersion,
        canonicalizationVersion: verifiedManifest.canonicalizationVersion,
        sourceCommit: verifiedManifest.sourceCommit,
        platform: verifiedManifest.platform,
      } : {}),
    })}\n`,
    { mode: 0o600 },
  );
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  const activated = spawnSync(process.execPath, [target, "service", "install"], {
    encoding: "utf8",
    env: { ...process.env, MISSION_AGENT_HOME: root },
    timeout: 30_000,
  });
  if (activated.status !== 0)
    throw new Error(
      `Mission Agent ${verifiedManifest.version} was downloaded but the background service could not be restarted. Run mission-agent service install.`,
    );
  console.log(`Mission Agent updated to ${verifiedManifest.version} and the background service was restarted.`);
}

export {
  artifactIdentity,
  canonicalizeRepositoryRemote,
  deriveStableRepositoryIdentity,
  parseReleaseManifestV2,
  canonicalJson,
  rollbackRepositoryIdentity,
  validateReleaseTrustStore,
  verifyReleaseManifest,
  verifyReleaseManifestText,
  verifyReleaseManifestV2,
  verifyReleaseManifestV3,
  parseReleaseManifestV3,
  canonicalReleaseManifestV3,
  assertReleasePlatformEligibility,
  executeRemoteProjectBrain,
  finishProjectBrainArtifactVersioning,
  runDurableProjectBrainProcess,
  runProjectBrainProcess,
  updateState,
  validateRemoteProjectBrainAuthoritySnapshot,
  verifiedPriorProjectBrainArtifacts,
  verifiedRemoteProjectBrainArtifact,
  verifiedProjectBrainContext,
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
try {
  if (command === "internal-project-brain-runner")
    await internalProjectBrainRunner(process.argv[3], process.argv[4]);
  else if (command === "connect") await connect(process.argv[3]);
  else if (command === "run") await run();
  else if (command === "status") await status();
  else if (command === "doctor") await doctor();
  else if (command === "logout") await logout();
  else if (command === "repository" && process.argv[3] === "list") await repositoryList();
  else if (command === "repository" && process.argv[3] === "add") await repositoryAdd(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "remove") await repositoryRemove(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "inspect") await repositoryInspect(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "identity-activate") await activateRepositoryIdentity(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "identity-rollback") await rollbackRepositoryIdentity(process.argv[4]);
  else if (command === "project-brain" && process.argv[3] === "configure")
    await configureProjectBrain(process.argv[4]);
  else if (command === "install") await installCurrentVersion();
  else if (command === "update") await update();
  else if (command === "service" && process.argv[3] === "install") {
    if (!(await installService())) throw new Error("Automatic service installation is unavailable on this system.");
    console.log("Mission Agent service installed and started.");
  } else
    throw new Error(
      "Commands: connect, install, run, status, doctor, update, logout, repository list|add|remove|inspect|identity-activate|identity-rollback, project-brain configure",
    );
} catch (error) {
  console.error(
    `Mission Agent: ${error instanceof Error ? error.message.replace(/mc_agent_[A-Za-z0-9_-]+/g, "[redacted]") : "Unknown error"}`,
  );
  process.exitCode = 1;
}
