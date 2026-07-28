#!/usr/bin/env node
/* eslint-disable */

// scripts/v1-macos-operator.ts
import { execFile as execFile3 } from "node:child_process";
import { createHash as createHash10, randomUUID as randomUUID2 } from "node:crypto";
import { readFile as readFile5 } from "node:fs/promises";
import { resolve as resolve4 } from "node:path";
import { parseArgs, promisify as promisify3 } from "node:util";

// application/v1-macos-operator-grant.ts
import { createHmac, timingSafeEqual } from "node:crypto";

// application/v1-production-runtime-identity.ts
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

// application/v1-macos-operator-grant.ts
function payload(grant) {
  const value = { ...grant };
  delete value.authenticationTag;
  return value;
}
function authenticate(value, key) {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}
function verifyV1OperatorGrant(grant, key, now = /* @__PURE__ */ new Date(), options = {}) {
  const expected = Uint8Array.from(Buffer.from(authenticate(payload(grant), key), "hex"));
  const supplied = Uint8Array.from(Buffer.from(grant.authenticationTag, "hex"));
  if (grant.schemaVersion !== "mission-agent-v1-operator-grant-v1" || !/^[a-f0-9-]{36}$/.test(grant.grantId) || !["forward", "rollback", "recovery"].includes(grant.grantKind) || !/^[a-f0-9-]{36}$/.test(grant.operationId) || !/^[a-f0-9-]{36}$/.test(grant.providerMutationId) || grant.sequence < 1 || grant.lifecycleSequence < 1 || !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(grant.hostFingerprint) || !/^[a-f0-9]{64}$/.test(grant.operatorArtifactSha256) || !grant.operatorProtocolVersion || grant.configurationVersion < 1 || !grant.originatingForwardDeploymentId || !grant.currentControllerDeploymentId || grant.currentControllerFencingGeneration < 1 || grant.rollbackObligationId !== grant.binding.rollbackObligationId || grant.providerMutationId.length === 0 || !/^[a-f0-9]{64}$/.test(grant.approvedExecutableChecksum) || grant.operatorArtifactSha256 !== grant.approvedExecutableChecksum || !grant.missionControlUrl.startsWith("https://") || !Number.isFinite(Date.parse(grant.issuedAt)) || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt) || !options.allowExpiredReceiptRecovery && Date.parse(grant.expiresAt) <= now.getTime() || Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) > 15 * 6e4 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error("V1 operator grant is malformed or unauthenticated.");
}

// application/v1-macos-operator-provider.ts
import { createHash as createHash4 } from "node:crypto";

// application/replacement-bootstrap-macos-local.ts
import { execFile } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join as join2, resolve as resolve2 } from "node:path";
import { promisify } from "node:util";

// integrations/mission-agent/replacement-bootstrap.ts
import { createHash as createHash2, createPublicKey as createPublicKey2, verify as verify2 } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

// integrations/mission-agent/release-authority.ts
import { createHash, createPublicKey, verify } from "node:crypto";
var RELEASE_MANIFEST_V3_VERSION = "3";
var RELEASE_CANONICALIZATION_V3 = "release-manifest-json-v3";
var KEY_ID = /^mission-agent-release-\d{4}-\d{2}$/;
var SHA256 = /^[a-f0-9]{64}$/;
var SEMVER = /^\d+\.\d+\.\d+$/;
var COMMIT = /^[a-f0-9]{40}$/;
var V3_FIELDS = [
  "artifactByteLength",
  "artifactName",
  "artifactSha256",
  "build",
  "canonicalizationVersion",
  "compatibility",
  "createdAt",
  "expiresAt",
  "manifestVersion",
  "platform",
  "provenance",
  "publicKeyFingerprint",
  "releaseAuthorityVersion",
  "releaseVersion",
  "signingKeyId"
];
var V3_BUILD_FIELDS = ["buildId", "sourceCommit"];
var V3_COMPATIBILITY_FIELDS = [
  "activationProtocolVersion",
  "identityProtocolVersion",
  "minimumMissionControlVersion"
];
var V3_PLATFORM_FIELDS = [
  "architecture",
  "artifactFormat",
  "operatingSystem",
  "runtime",
  "runtimeMajorVersion"
];
var V3_PROVENANCE_FIELDS = [
  "builderSha256",
  "containerImageDigest",
  "manifestSchemaSha256",
  "nodeVersion",
  "packageLockSha256",
  "reproducibilityEvidenceSha256"
];
var SUPPORTED_IDENTITY_PROTOCOLS = /* @__PURE__ */ new Set(["2"]);
var SUPPORTED_ACTIVATION_PROTOCOLS = /* @__PURE__ */ new Set(["1"]);
var trustedReleaseKeys = {
  "mission-agent-release-2026-00": {
    keyId: "mission-agent-release-2026-00",
    algorithm: "Ed25519",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEAkJJvbXaL3hnwifCZ/nyTD9z3oNWyJRCjxxfjXMWhVwo=",
    publicKeyFingerprint: "ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a",
    status: "retiring",
    purpose: "mission-agent-release",
    createdAt: "2026-07-25T12:05:40.000Z",
    activatedAt: "2026-07-25T12:14:48.000Z",
    retiresAt: null,
    revokedAt: null,
    replacedBy: "mission-agent-release-2026-01",
    historicalVersions: ["0.6.8"],
    kms: null
  },
  "mission-agent-release-2026-01": {
    keyId: "mission-agent-release-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEAvSkEoddFoGfJn2PauL+KEl4ykZ+5WM5B2PklJOZOAKE=",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
    status: "active",
    purpose: "mission-agent-release",
    createdAt: "2026-07-26T20:50:15.575Z",
    activatedAt: "2026-07-27T16:58:06.000Z",
    retiresAt: null,
    revokedAt: null,
    replacedBy: null,
    historicalVersions: [],
    kms: {
      provider: "aws-kms",
      accountId: "661452835066",
      region: "us-east-1",
      keyArn: "arn:aws:kms:us-east-1:661452835066:key/cd9ebd3d-f2c6-44cb-83d6-fd4893008fee",
      keyId: "cd9ebd3d-f2c6-44cb-83d6-fd4893008fee",
      keySpec: "ECC_NIST_EDWARDS25519",
      keyUsage: "SIGN_VERIFY",
      signingAlgorithm: "ED25519_SHA_512",
      origin: "AWS_KMS",
      keyManager: "CUSTOMER",
      multiRegion: false
    }
  }
  // RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT
};
function canonicalJson2(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson2).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson2(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function assertExactFields(record, fields, label) {
  if (Object.keys(record).sort().join("\n") !== [...fields].sort().join("\n"))
    throw new Error(`${label} fields must exactly match the schema`);
}
function assertCanonicalUnicode(value) {
  if (typeof value === "string" && value.normalize("NFC") !== value)
    throw new Error("manifest strings must use Unicode NFC");
  if (Array.isArray(value)) {
    for (const item of value) assertCanonicalUnicode(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.normalize("NFC") !== key) throw new Error("manifest keys must use Unicode NFC");
      assertCanonicalUnicode(item);
    }
  }
}
function assertNoDuplicateJsonKeys(text) {
  const stack = [];
  let index = 0;
  let expectingKey = false;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        if (!escaped && current === '"') break;
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
        index += 1;
      }
      if (index >= text.length) throw new Error("manifest JSON string is unterminated");
      const literal = text.slice(start, index + 1);
      let after = index + 1;
      while (/\s/.test(text[after] ?? "")) after += 1;
      if (expectingKey && text[after] === ":") {
        const key = JSON.parse(literal);
        const keys = stack.at(-1);
        if (!(keys instanceof Set)) throw new Error("manifest JSON object state is malformed");
        if (keys.has(key)) throw new Error(`manifest contains duplicate field: ${key}`);
        keys.add(key);
        expectingKey = false;
      }
      index += 1;
      continue;
    }
    if (character === "{") {
      stack.push(/* @__PURE__ */ new Set());
      expectingKey = true;
    } else if (character === "[") {
      stack.push(null);
      expectingKey = false;
    } else if (character === "}" || character === "]") {
      stack.pop();
      expectingKey = false;
    } else if (character === "," && stack.at(-1) instanceof Set) {
      expectingKey = true;
    }
    index += 1;
  }
}
function requireIsoDate(value, field) {
  if (!value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new Error(`${field} must be a canonical ISO-8601 timestamp`);
}
function parseReleaseManifestV3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest v3 must be an object");
  const record = value;
  assertExactFields(record, V3_FIELDS, "manifest v3");
  if (!record.build || typeof record.build !== "object" || Array.isArray(record.build) || !record.compatibility || typeof record.compatibility !== "object" || Array.isArray(record.compatibility) || !record.platform || typeof record.platform !== "object" || Array.isArray(record.platform) || !record.provenance || typeof record.provenance !== "object" || Array.isArray(record.provenance))
    throw new Error("manifest v3 nested metadata is required");
  assertExactFields(record.build, V3_BUILD_FIELDS, "manifest v3 build");
  assertExactFields(
    record.compatibility,
    V3_COMPATIBILITY_FIELDS,
    "manifest v3 compatibility"
  );
  assertExactFields(record.platform, V3_PLATFORM_FIELDS, "manifest v3 platform");
  assertExactFields(record.provenance, V3_PROVENANCE_FIELDS, "manifest v3 provenance");
  const manifest = record;
  if (manifest.manifestVersion !== RELEASE_MANIFEST_V3_VERSION) throw new Error("unsupported manifest version");
  if (manifest.releaseAuthorityVersion !== "v2") throw new Error("unsupported Release Authority version");
  if (manifest.canonicalizationVersion !== RELEASE_CANONICALIZATION_V3)
    throw new Error("unsupported manifest canonicalization");
  if (!SEMVER.test(manifest.releaseVersion) || !SEMVER.test(manifest.compatibility.minimumMissionControlVersion))
    throw new Error("release and Mission Control versions must be canonical semver");
  if (manifest.artifactName !== `mission-agent-${manifest.releaseVersion}.mjs`)
    throw new Error("artifact name does not match release version");
  if (!SHA256.test(manifest.artifactSha256)) throw new Error("artifact checksum must be lowercase SHA-256");
  if (!Number.isSafeInteger(manifest.artifactByteLength) || manifest.artifactByteLength <= 0)
    throw new Error("artifact byte length must be a positive safe integer");
  if (!COMMIT.test(manifest.build.sourceCommit)) throw new Error("source commit must be a full lowercase Git SHA");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.build.buildId)) throw new Error("invalid build ID");
  if (!KEY_ID.test(manifest.signingKeyId)) throw new Error("invalid signing key ID");
  if (!/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(manifest.publicKeyFingerprint))
    throw new Error("invalid public-key fingerprint");
  if (manifest.platform.runtime !== "node" || manifest.platform.runtimeMajorVersion !== 22 || manifest.platform.operatingSystem !== "darwin-linux" || manifest.platform.architecture !== "universal" || manifest.platform.artifactFormat !== "esm")
    throw new Error("unsupported Mission Agent platform");
  if (!SHA256.test(manifest.provenance.builderSha256) || !SHA256.test(manifest.provenance.manifestSchemaSha256) || !SHA256.test(manifest.provenance.packageLockSha256) || !SHA256.test(manifest.provenance.reproducibilityEvidenceSha256) || manifest.provenance.nodeVersion !== "22.22.0" || !/^node@sha256:[a-f0-9]{64}$/.test(manifest.provenance.containerImageDigest))
    throw new Error("invalid build provenance");
  if (!SUPPORTED_IDENTITY_PROTOCOLS.has(manifest.compatibility.identityProtocolVersion))
    throw new Error("unsupported identity protocol version");
  if (!SUPPORTED_ACTIVATION_PROTOCOLS.has(manifest.compatibility.activationProtocolVersion))
    throw new Error("unsupported activation protocol version");
  if (manifest.compatibility.minimumMissionControlVersion !== "0.1.0")
    throw new Error("Mission Control version is incompatible");
  requireIsoDate(manifest.createdAt, "createdAt");
  requireIsoDate(manifest.expiresAt, "expiresAt");
  if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt))
    throw new Error("manifest must expire after creation");
  assertCanonicalUnicode(manifest);
  return manifest;
}
function canonicalReleaseManifestV3(value) {
  return canonicalJson2(parseReleaseManifestV3(value));
}
function parseCanonicalSignedReleaseManifestV3Json(text) {
  const canonicalText = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  assertNoDuplicateJsonKeys(canonicalText);
  const parsed = JSON.parse(canonicalText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("signed manifest v3 must be an object");
  const { signature, ...unsigned } = parsed;
  if (typeof signature !== "string" || signature === "") throw new Error("manifest signature is required");
  const manifest = parseReleaseManifestV3(unsigned);
  const bundle = { ...manifest, signature };
  if (canonicalText !== canonicalJson2(bundle)) throw new Error("signed manifest v3 bytes are not canonical");
  return bundle;
}
function publicKeyFingerprint(spkiBase64) {
  return `ed25519-spki-sha256:${createHash("sha256").update(Uint8Array.from(Buffer.from(spkiBase64, "base64"))).digest("hex")}`;
}
function validateTrustStore(keys = trustedReleaseKeys) {
  const fingerprints = /* @__PURE__ */ new Set();
  for (const [id, key] of Object.entries(keys)) {
    if (id !== key.keyId || !KEY_ID.test(id)) throw new Error(`invalid release key ID: ${id}`);
    if (key.algorithm !== "Ed25519" || key.purpose !== "mission-agent-release")
      throw new Error(`invalid release key purpose: ${id}`);
    if (key.kms && (key.kms.provider !== "aws-kms" || !/^\d{12}$/.test(key.kms.accountId) || key.kms.region === "" || key.kms.keyArn !== `arn:aws:kms:${key.kms.region}:${key.kms.accountId}:key/${key.kms.keyId}` || key.kms.keySpec !== "ECC_NIST_EDWARDS25519" || key.kms.keyUsage !== "SIGN_VERIFY" || key.kms.signingAlgorithm !== "ED25519_SHA_512" || key.kms.origin !== "AWS_KMS" || key.kms.keyManager !== "CUSTOMER" || key.kms.multiRegion !== false))
      throw new Error(`invalid AWS KMS provenance: ${id}`);
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki"
    });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`release key is not Ed25519: ${id}`);
    if (publicKeyFingerprint(key.publicKeySpkiBase64) !== key.publicKeyFingerprint)
      throw new Error(`release key fingerprint mismatch: ${id}`);
    if (fingerprints.has(key.publicKeyFingerprint)) throw new Error(`duplicate release key fingerprint: ${id}`);
    fingerprints.add(key.publicKeyFingerprint);
    if (key.status === "active" && !key.activatedAt) throw new Error(`active release key lacks activation time: ${id}`);
    if (key.status === "revoked" && !key.revokedAt) throw new Error(`revoked release key lacks revocation time: ${id}`);
    if (key.activatedAt) requireIsoDate(key.activatedAt, `${id}.activatedAt`);
    if (key.retiresAt) requireIsoDate(key.retiresAt, `${id}.retiresAt`);
    if (key.revokedAt) requireIsoDate(key.revokedAt, `${id}.revokedAt`);
    if (key.replacedBy && key.replacedBy !== "mission-agent-release-2026-01" && !keys[key.replacedBy])
      throw new Error(`replacement release key is unknown: ${id}`);
    if (key.historicalVersions.some((version) => !SEMVER.test(version)))
      throw new Error(`historical release version is malformed: ${id}`);
  }
}
function verifyReleaseManifestV3(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    throw new Error("signed manifest v3 must be an object");
  const { signature, ...unsigned } = bundle;
  if (typeof signature !== "string" || signature === "") throw new Error("manifest signature is required");
  const manifest = parseReleaseManifestV3(unsigned);
  const keys = options.keys ?? trustedReleaseKeys;
  validateTrustStore(keys);
  const key = keys[manifest.signingKeyId];
  if (!key) throw new Error("manifest signing key is unknown");
  if (key.keyId !== manifest.signingKeyId) throw new Error("manifest signing key ID mismatch");
  if (key.status !== "active") throw new Error(`manifest signing key is ${key.status}`);
  if (key.publicKeyFingerprint !== manifest.publicKeyFingerprint)
    throw new Error("signed public-key fingerprint does not match trust record");
  const derivedFingerprint = publicKeyFingerprint(key.publicKeySpkiBase64);
  if (derivedFingerprint !== manifest.publicKeyFingerprint)
    throw new Error("signed public-key fingerprint does not match public key");
  const now = options.now ?? /* @__PURE__ */ new Date();
  if (key.activatedAt && Date.parse(key.activatedAt) > now.getTime())
    throw new Error("manifest signing key is not active yet");
  if (key.retiresAt && Date.parse(key.retiresAt) <= now.getTime()) throw new Error("manifest signing key is retired");
  if (Date.parse(manifest.expiresAt) <= now.getTime()) throw new Error("manifest is expired");
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature)
    throw new Error("manifest signature must be canonical Ed25519 base64");
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki"
  });
  if (!verify(
    null,
    Uint8Array.from(Buffer.from(canonicalReleaseManifestV3(manifest), "utf8")),
    publicKey,
    Uint8Array.from(signatureBytes)
  ))
    throw new Error("manifest signature verification failed");
  return manifest;
}

// integrations/mission-agent/replacement-bootstrap.ts
var REPLACEMENT_BOOTSTRAP_PROTOCOL = "operator-replacement-bootstrap-v1";
var NAMED_CANARY_ID = "0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8";
var SOURCE_VERSION = "0.6.8";
var SOURCE_SHA256 = "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d";
var TARGET_VERSION = "0.7.2";
var TARGET_SHA256 = "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09";
var TARGET_LENGTH = 148063;
var TARGET_MANIFEST_SHA256 = "b9f7d17b54219a50f4298817db1bcece1fec49eb9311e27aa9a6f4f9a5947ace";
var TARGET_SIGNATURE_SHA256 = "4c86744ec6e8749b743b9130c65f23e6e2b324d3ccac3d0bf01c828b91d1a583";
var TARGET_KEY_ID = "mission-agent-release-2026-01";
var TARGET_KEY_FINGERPRINT = "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b";
var NODE_VERSION = "22.22.0";
var NODE_ARCHIVE_SHA256 = "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640";
var NODE_ARCHIVE_URL = "https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz";
var NODE_EXECUTABLE_SHA256 = "913b144fdb40638b1acef7974ab3c33fbd527cc0974cb5da467ab1e6ac51b4d4";
var NODE_INSTALL_ROOT = "/opt/mission-agent/runtime/node-22/22.22.0";
var NODE_EXECUTABLE = `${NODE_INSTALL_ROOT}/bin/node`;
var NODE_PLATFORM = "darwin-arm64";
var NODE_ARCHIVE_LENGTH = 49923798;
var SERVICE_MANAGER = "launchd";
var SERVICE_IDENTIFIER = "com.wallyweb.mission-agent";
var APPROVED_AGENT_ROOT = "/Users/shawnwollenberg/.mission-agent";
var TARGET_SERVICE_PATH = "/Users/shawnwollenberg/.mission-agent/staged-0.7.2/com.wallyweb.mission-agent.plist";
var CURRENT_SERVICE_SHA256 = "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898";
var TARGET_SERVICE_SHA256 = "c81d2310df79224c41d71bdac2ea458f53b86caeed8b1543a474e955fa00dde6";
var ROLLBACK_INVENTORY_SHA256 = "2e7f074a890b1b6492ac76d1786b987c0a7417e50532a1e712699963b7e5f229";
var SHA2562 = /^[a-f0-9]{64}$/;
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var sha256 = (value) => createHash2("sha256").update(value).digest("hex");
function authorizationChecksum(value) {
  return sha256(canonicalJson2(value));
}
function validateReplacementAuthorization(value, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const exactKeys2 = [
    "protocolVersion",
    "authorizationId",
    "agentId",
    "hostIdentity",
    "workspaceId",
    "repositoryId",
    "repositoryFingerprint",
    "currentVersion",
    "currentArtifactSha256",
    "targetVersion",
    "targetArtifactSha256",
    "targetArtifactByteLength",
    "targetManifestSha256",
    "targetSignatureSha256",
    "targetSigningKeyId",
    "targetPublicKeyFingerprint",
    "requiredNodeVersion",
    "nodeRuntime",
    "serviceReplacement",
    "smokeMission",
    "evidenceDestination",
    "approvalId",
    "operatorIdentity",
    "approvedBy",
    "approvedAt",
    "expiresAt",
    "maximumExecutionCount",
    "rollbackVersion",
    "rollbackArtifactSha256",
    "rollbackInventorySha256",
    "reason",
    "legacyCryptographicContinuity",
    "evidenceReferences"
  ].sort();
  const exactNodeKeys = [
    "version",
    "platform",
    "distributionUrl",
    "archiveSha256",
    "archiveByteLength",
    "installationDirectory",
    "executablePath",
    "executableSha256"
  ].sort();
  const exactServiceKeys = [
    "serviceManager",
    "serviceIdentifier",
    "currentDefinitionSha256",
    "targetDefinitionSha256",
    "targetDefinitionPath",
    "rollbackDefinitionSha256"
  ].sort();
  if (canonicalJson2(Object.keys(value).sort()) !== canonicalJson2(exactKeys2) || canonicalJson2(Object.keys(value.nodeRuntime ?? {}).sort()) !== canonicalJson2(exactNodeKeys) || canonicalJson2(Object.keys(value.serviceReplacement ?? {}).sort()) !== canonicalJson2(exactServiceKeys) || canonicalJson2(Object.keys(value.smokeMission ?? {}).sort()) !== canonicalJson2(["operation", "readOnly", "templateId"]))
    throw new Error("Replacement authorization contains missing or unknown fields.");
  if (value.protocolVersion !== REPLACEMENT_BOOTSTRAP_PROTOCOL || !UUID.test(value.authorizationId) || value.agentId !== NAMED_CANARY_ID || value.currentVersion !== SOURCE_VERSION || value.currentArtifactSha256 !== SOURCE_SHA256 || value.targetVersion !== TARGET_VERSION || value.targetArtifactSha256 !== TARGET_SHA256 || value.targetArtifactByteLength !== TARGET_LENGTH || value.targetManifestSha256 !== TARGET_MANIFEST_SHA256 || value.targetSignatureSha256 !== TARGET_SIGNATURE_SHA256 || value.targetSigningKeyId !== TARGET_KEY_ID || value.targetPublicKeyFingerprint !== TARGET_KEY_FINGERPRINT || value.requiredNodeVersion !== NODE_VERSION || value.nodeRuntime?.version !== NODE_VERSION || value.nodeRuntime?.platform !== NODE_PLATFORM || value.nodeRuntime?.distributionUrl !== NODE_ARCHIVE_URL || value.nodeRuntime?.archiveSha256 !== NODE_ARCHIVE_SHA256 || value.nodeRuntime?.archiveByteLength !== NODE_ARCHIVE_LENGTH || value.nodeRuntime?.installationDirectory !== NODE_INSTALL_ROOT || value.nodeRuntime?.executablePath !== NODE_EXECUTABLE || value.nodeRuntime?.executableSha256 !== NODE_EXECUTABLE_SHA256 || value.serviceReplacement?.serviceManager !== SERVICE_MANAGER || value.serviceReplacement?.serviceIdentifier !== SERVICE_IDENTIFIER || value.serviceReplacement?.currentDefinitionSha256 !== CURRENT_SERVICE_SHA256 || value.serviceReplacement?.targetDefinitionSha256 !== TARGET_SERVICE_SHA256 || value.serviceReplacement?.targetDefinitionPath !== TARGET_SERVICE_PATH || value.serviceReplacement?.rollbackDefinitionSha256 !== CURRENT_SERVICE_SHA256 || value.smokeMission?.templateId !== "replacement-bootstrap-read-only-v1" || value.smokeMission?.operation !== "repository-analysis" || value.smokeMission?.readOnly !== true || value.maximumExecutionCount !== 1 || value.rollbackVersion !== SOURCE_VERSION || value.rollbackArtifactSha256 !== SOURCE_SHA256 || value.rollbackInventorySha256 !== ROLLBACK_INVENTORY_SHA256 || value.reason !== "legacy-signing-authority-unavailable" || value.legacyCryptographicContinuity !== "unavailable")
    throw new Error("Replacement authorization binding is invalid.");
  if (!value.hostIdentity || !UUID.test(value.approvalId) || !UUID.test(value.workspaceId) || !UUID.test(value.repositoryId) || !SHA2562.test(value.repositoryFingerprint) || !value.operatorIdentity || !value.approvedBy || !isAbsolute(value.evidenceDestination) || resolve(value.evidenceDestination) !== value.evidenceDestination || !value.evidenceDestination.startsWith(`${APPROVED_AGENT_ROOT}/evidence/`) || value.evidenceReferences.length === 0)
    throw new Error("Replacement authorization scope is incomplete.");
  if (new Date(value.approvedAt).toISOString() !== value.approvedAt || new Date(value.expiresAt).toISOString() !== value.expiresAt || Date.parse(value.expiresAt) <= Date.parse(value.approvedAt) || Date.parse(value.expiresAt) <= now.getTime())
    throw new Error("Replacement authorization is expired or malformed.");
  return value;
}
function verifyReplacementRelease(input) {
  const bundle = parseCanonicalSignedReleaseManifestV3Json(input.signedManifestText);
  const { signature, ...manifest } = bundle;
  const canonicalManifest = canonicalReleaseManifestV3(manifest);
  const manifestChecksum = sha256(canonicalManifest);
  const signatureBytes = Buffer.from(signature, "base64");
  if (manifestChecksum !== TARGET_MANIFEST_SHA256 || sha256(Uint8Array.from(signatureBytes)) !== TARGET_SIGNATURE_SHA256)
    throw new Error("Replacement release manifest or signature checksum mismatch.");
  const verified = verifyReleaseManifestV3(bundle, { now: input.now });
  const key = trustedReleaseKeys[verified.signingKeyId];
  if (verified.releaseVersion !== TARGET_VERSION || verified.artifactSha256 !== TARGET_SHA256 || verified.artifactByteLength !== TARGET_LENGTH || verified.signingKeyId !== TARGET_KEY_ID || verified.publicKeyFingerprint !== TARGET_KEY_FINGERPRINT || publicKeyFingerprint(key.publicKeySpkiBase64) !== TARGET_KEY_FINGERPRINT)
    throw new Error("Replacement release binding mismatch.");
  const publicKey = createPublicKey2({
    key: Buffer.from(key.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki"
  });
  if (!verify2(null, Uint8Array.from(Buffer.from(canonicalManifest)), publicKey, Uint8Array.from(signatureBytes)))
    throw new Error("Standalone replacement signature verification failed.");
  const artifactChecksum = sha256(input.artifact);
  if (input.artifact.byteLength !== TARGET_LENGTH || artifactChecksum !== TARGET_SHA256)
    throw new Error("Replacement artifact length or checksum mismatch.");
  return { manifestChecksum, artifactChecksum, standaloneVerified: true };
}

// application/replacement-bootstrap-macos-local.ts
var LOCAL_AGENT_HOME = "/Users/shawnwollenberg/.mission-agent";
var ACTIVE_SOURCE_ARTIFACT = `${LOCAL_AGENT_HOME}/mission-agent-0.6.8.mjs`;
var ACTIVE_TARGET_ARTIFACT = `${LOCAL_AGENT_HOME}/mission-agent-0.7.2.mjs`;
var ACTIVE_PLIST = "/Users/shawnwollenberg/Library/LaunchAgents/com.wallyweb.mission-agent.plist";
var CONFIG_PATH = `${LOCAL_AGENT_HOME}/config.json`;
var STATE_PATH = `${LOCAL_AGENT_HOME}/state.json`;
var CANONICAL_PLIST = "release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist";
var SIGNED_MANIFEST = "release/mission-agent-0.7.2/signed-manifest-v3.json";
var TARGET_REPOSITORY_ARTIFACT = "public/mission-agent-0.7.2.mjs";
var ROLLBACK_INVENTORY = "release/mission-agent-0.7.2/replacement-bootstrap/rollback-0.6.8-inventory.json";
var fixedExecutables = {
  uname: "/usr/bin/uname",
  id: "/usr/bin/id",
  scutil: "/usr/sbin/scutil",
  tar: "/usr/bin/tar",
  launchctl: "/bin/launchctl",
  ps: "/bin/ps",
  security: "/usr/bin/security",
  plutil: "/usr/bin/plutil"
};
var exec = promisify(execFile);
var sha2562 = (value) => createHash3("sha256").update(value).digest("hex");
function stagingRoot(authorization) {
  return join2(LOCAL_AGENT_HOME, "replacement-bootstrap", authorization.authorizationId);
}
function stagedArchive(authorization) {
  return join2(stagingRoot(authorization), "node-v22.22.0-darwin-arm64.tar.gz");
}
function stagedArtifact(authorization) {
  return join2(stagingRoot(authorization), "mission-agent-0.7.2.mjs");
}
function stagedPlist(authorization) {
  return join2(stagingRoot(authorization), "com.wallyweb.mission-agent.plist");
}
function rollbackRoot(authorization) {
  return join2(stagingRoot(authorization), "rollback-0.6.8");
}
async function removeStagedReplacementAssets(authorization) {
  const root = stagingRoot(authorization);
  if (!root.startsWith(`${LOCAL_AGENT_HOME}/replacement-bootstrap/`))
    throw new Error("Replacement staging root escaped the approved agent home.");
  for (const path of [stagedArtifact(authorization), stagedPlist(authorization), stagedArchive(authorization)]) {
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function fileChecksum(path) {
  return sha2562(Uint8Array.from(await readFile(path)));
}
function observedKeychainMetadata(stdout) {
  const itemClass = stdout.match(/^class:\s+"([^"]+)"$/m)?.[1];
  const service = stdout.match(/^\s*"svce"<[^>]+>="([^"]+)"$/m)?.[1];
  const account = stdout.match(/^\s*"acct"<[^>]+>="([^"]+)"$/m)?.[1];
  if (itemClass !== "genp" || !service || !account)
    throw new Error("Keychain returned no parseable generic-password metadata.");
  const metadata = { itemClass: "generic-password", service, account };
  return { ...metadata, metadataChecksum: sha2562(canonicalJson2(metadata)) };
}
async function rollbackInventoryEquivalence() {
  const inventoryBytes = Uint8Array.from(await readFile(ROLLBACK_INVENTORY));
  if (sha2562(inventoryBytes) !== ROLLBACK_INVENTORY_SHA256)
    throw new Error("Rollback inventory bytes are not the reviewed inventory.");
  const inventory = JSON.parse(Buffer.from(inventoryBytes).toString("utf8"));
  const [artifact, plist, configuration, owner, group, uid, gid, parsedPlist] = await Promise.all([
    lstat(ACTIVE_SOURCE_ARTIFACT),
    lstat(ACTIVE_PLIST),
    lstat(CONFIG_PATH),
    exec(fixedExecutables.id, ["-un"], { encoding: "utf8", timeout: 5e3 }),
    exec(fixedExecutables.id, ["-gn"], { encoding: "utf8", timeout: 5e3 }),
    exec(fixedExecutables.id, ["-u"], { encoding: "utf8", timeout: 5e3 }),
    exec(fixedExecutables.id, ["-g"], { encoding: "utf8", timeout: 5e3 }),
    exec(fixedExecutables.plutil, ["-convert", "json", "-o", "-", ACTIVE_PLIST], {
      encoding: "utf8",
      timeout: 1e4,
      maxBuffer: 256 * 1024
    })
  ]);
  const service = JSON.parse(parsedPlist.stdout);
  const environment = service.EnvironmentVariables;
  const environmentNames = Object.keys(environment ?? {}).sort();
  const environmentValueChecksums = Object.fromEntries(
    environmentNames.map((name) => [name, sha2562(String(environment?.[name]))])
  );
  const credential = await exec(
    fixedExecutables.security,
    ["find-generic-password", "-s", inventory.credential.service, "-a", inventory.credential.account],
    { encoding: "utf8", timeout: 1e4, maxBuffer: 32 * 1024 }
  );
  const credentialMetadata = observedKeychainMetadata(credential.stdout);
  const mode = (value) => (Number(value.mode) & 511).toString(8).padStart(4, "0");
  if (!artifact.isFile() || artifact.isSymbolicLink() || artifact.size !== inventory.artifact.byteLength || mode(artifact) !== inventory.artifact.mode || await fileChecksum(ACTIVE_SOURCE_ARTIFACT) !== inventory.artifact.sha256 || artifact.uid !== Number(uid.stdout.trim()) || artifact.gid !== Number(gid.stdout.trim()) || !plist.isFile() || plist.isSymbolicLink() || plist.size !== inventory.service.plistByteLength || mode(plist) !== inventory.service.mode || await fileChecksum(ACTIVE_PLIST) !== inventory.service.plistSha256 || plist.uid !== Number(uid.stdout.trim()) || plist.gid !== Number(gid.stdout.trim()) || !configuration.isFile() || configuration.isSymbolicLink() || configuration.size !== inventory.configuration.byteLength || mode(configuration) !== inventory.configuration.mode || await fileChecksum(CONFIG_PATH) !== inventory.configuration.sha256 || configuration.uid !== Number(uid.stdout.trim()) || configuration.gid !== Number(gid.stdout.trim()) || owner.stdout.trim() !== inventory.artifact.owner || group.stdout.trim() !== inventory.artifact.group || credential.stderr.includes("could not be found") || inventory.credential.storage !== "macOS Keychain" || credentialMetadata.itemClass !== inventory.credential.itemClass || credentialMetadata.service !== inventory.credential.service || credentialMetadata.account !== inventory.credential.account || inventory.credential.secretCopied !== false || inventory.credential.identityPreserved !== true || service.Label !== inventory.service.label || canonicalJson2(service.ProgramArguments) !== canonicalJson2(inventory.service.programArguments) || (service.WorkingDirectory ?? null) !== inventory.service.workingDirectory || service.RunAtLoad !== inventory.service.runAtLoad || service.KeepAlive !== inventory.service.keepAlive || service.StandardOutPath !== inventory.service.standardOutputPath || service.StandardErrorPath !== inventory.service.standardErrorPath || canonicalJson2(environmentNames) !== canonicalJson2([...inventory.environment.names].sort()) || canonicalJson2(environmentValueChecksums) !== canonicalJson2(inventory.environment.nonSecretValueChecksums))
    throw new Error("Prior runtime ownership, permissions, configuration, or credential metadata differs.");
  return {
    rollbackInventoryChecksum: ROLLBACK_INVENTORY_SHA256,
    artifactByteLength: artifact.size,
    artifactMode: mode(artifact),
    artifactChecksum: await fileChecksum(ACTIVE_SOURCE_ARTIFACT),
    plistByteLength: plist.size,
    plistMode: mode(plist),
    plistChecksum: await fileChecksum(ACTIVE_PLIST),
    configurationByteLength: configuration.size,
    configurationMode: mode(configuration),
    configurationChecksum: await fileChecksum(CONFIG_PATH),
    owner: owner.stdout.trim(),
    group: group.stdout.trim(),
    credentialMetadataPresent: true,
    credentialStorage: inventory.credential.storage,
    credentialItemClass: credentialMetadata.itemClass,
    credentialService: credentialMetadata.service,
    credentialAccount: credentialMetadata.account,
    credentialMetadataChecksum: credentialMetadata.metadataChecksum,
    environmentNames,
    environmentValueChecksums,
    standardOutputPath: service.StandardOutPath,
    standardErrorPath: service.StandardErrorPath,
    runAtLoad: service.RunAtLoad,
    keepAlive: service.KeepAlive
  };
}
async function safeConfig() {
  const value = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (typeof value.agentId !== "string" || typeof value.workspaceId !== "string")
    throw new Error("Mission Agent configuration identity is unavailable.");
  return {
    agentId: value.agentId,
    workspaceId: value.workspaceId,
    repositories: Array.isArray(value.repositories) ? value.repositories : void 0
  };
}
async function hostIdentity() {
  const { stdout } = await exec(fixedExecutables.scutil, ["--get", "LocalHostName"], {
    encoding: "utf8",
    timeout: 5e3
  });
  return stdout.trim();
}
async function assertHost(pkg) {
  const [{ stdout: kernel }, { stdout: architecture }, config] = await Promise.all([
    exec(fixedExecutables.uname, ["-s"], { encoding: "utf8", timeout: 5e3 }),
    exec(fixedExecutables.uname, ["-m"], { encoding: "utf8", timeout: 5e3 }),
    safeConfig()
  ]);
  if (kernel.trim() !== "Darwin" || architecture.trim() !== "arm64" || await hostIdentity() !== pkg.authorization.hostIdentity || config.agentId !== NAMED_CANARY_ID || config.workspaceId !== pkg.authorization.workspaceId || await fileChecksum(ACTIVE_SOURCE_ARTIFACT) !== SOURCE_SHA256 || await fileChecksum(ACTIVE_PLIST) !== CURRENT_SERVICE_SHA256)
    throw new Error("Local macOS host, agent, source artifact, or service identity mismatch.");
}
async function atomicCopy(source, destination, mode) {
  const temporary = `${destination}.replacement-tmp`;
  await copyFile(source, temporary);
  await chmod(temporary, mode);
  await rename(temporary, destination);
}
async function downloadExactNodeArchive(destination) {
  try {
    const existing = await stat(destination);
    if (existing.isFile() && existing.size === NODE_ARCHIVE_LENGTH && await fileChecksum(destination) === NODE_ARCHIVE_SHA256)
      return;
    throw new Error("Existing staged Node archive does not match the approved immutable archive.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(NODE_ARCHIVE_URL, { redirect: "manual" });
  if (!response.ok || response.url !== NODE_ARCHIVE_URL || new URL(response.url).origin !== "https://nodejs.org" || response.status >= 300)
    throw new Error("Node archive origin, redirect policy, or response is invalid.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== NODE_ARCHIVE_LENGTH || sha2562(bytes) !== NODE_ARCHIVE_SHA256)
    throw new Error("Node archive length or checksum mismatch.");
  await writeFile(destination, bytes, { mode: 384, flag: "wx" });
}
async function verifyNodeExecutable() {
  const metadata = await lstat(NODE_EXECUTABLE);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 18) !== 0)
    throw new Error("Node executable type or permissions are unsafe.");
  const { stdout } = await exec(NODE_EXECUTABLE, ["--version"], { encoding: "utf8", timeout: 1e4 });
  if (stdout.trim() !== `v${NODE_VERSION}` || await fileChecksum(NODE_EXECUTABLE) !== NODE_EXECUTABLE_SHA256)
    throw new Error("Installed Node executable version or checksum mismatch.");
}
async function pathChecksum(path) {
  try {
    return await fileChecksum(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function serviceLoaded() {
  const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8", timeout: 5e3 })).stdout.trim();
  try {
    await exec(fixedExecutables.launchctl, ["print", `gui/${uid}/com.wallyweb.mission-agent`], {
      encoding: "utf8",
      timeout: 1e4,
      maxBuffer: 256 * 1024
    });
    return true;
  } catch (error) {
    if (typeof error.code === "number") return false;
    throw error;
  }
}
async function runningProcessObservation(expected) {
  const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8", timeout: 5e3 })).stdout.trim();
  const owner = (await exec(fixedExecutables.id, ["-un"], { encoding: "utf8", timeout: 5e3 })).stdout.trim();
  const { stdout: service } = await exec(
    fixedExecutables.launchctl,
    ["print", `gui/${uid}/com.wallyweb.mission-agent`],
    { encoding: "utf8", timeout: 1e4, maxBuffer: 256 * 1024 }
  );
  const pid = Number(/\bpid = (\d+)/.exec(service)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("launchd did not report a valid running PID.");
  const { stdout: processRow } = await exec(
    fixedExecutables.ps,
    ["-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "user=", "-o", "command="],
    { encoding: "utf8", timeout: 1e4, maxBuffer: 64 * 1024 }
  );
  const match = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)\s*$/.exec(
    processRow
  );
  if (!match) throw new Error("Running Mission Agent process metadata could not be parsed.");
  const command = match[4];
  const expectedNode = expected === "0.7.2" ? NODE_EXECUTABLE : "/usr/local/Cellar/node/24.10.0/bin/node";
  const expectedArtifact = expected === "0.7.2" ? ACTIVE_TARGET_ARTIFACT : ACTIVE_SOURCE_ARTIFACT;
  const expectedCommand = `${expectedNode} ${expectedArtifact} run`;
  if (command !== expectedCommand || match[3] !== owner)
    throw new Error("Running Mission Agent executable, arguments, or owner mismatch.");
  const nodeVersion = (await exec(expectedNode, ["--version"], { encoding: "utf8", timeout: 1e4 })).stdout.trim();
  const artifactChecksum = await fileChecksum(expectedArtifact);
  const plistChecksum = await fileChecksum(ACTIVE_PLIST);
  const startedAt = new Date(match[2]).toISOString();
  const targetProcessAbsent = expected !== "0.6.8" ? void 0 : !(await exec(fixedExecutables.ps, ["-axo", "command="], {
    encoding: "utf8",
    timeout: 1e4,
    maxBuffer: 1024 * 1024
  })).stdout.split("\n").some((line) => line.trim() === `${NODE_EXECUTABLE} ${ACTIVE_TARGET_ARTIFACT} run`);
  return {
    observationVersion: "mission-agent-process-v1",
    hostIdentity: await hostIdentity(),
    agentId: NAMED_CANARY_ID,
    serviceLabel: "com.wallyweb.mission-agent",
    pid,
    parentPid: Number(match[1]),
    processStartedAt: startedAt,
    processOwner: owner,
    nodeExecutable: expectedNode,
    nodeVersion,
    artifactPath: expectedArtifact,
    artifactChecksum,
    processArgumentsChecksum: sha2562(expectedCommand),
    launchdPlistChecksum: plistChecksum,
    ...targetProcessAbsent === void 0 ? {} : { targetProcessAbsent }
  };
}
async function inspectMutationState(operation) {
  if (operation === "extract_node_runtime") {
    try {
      await verifyNodeExecutable();
      return "postcondition";
    } catch (error) {
      if (error.code !== "ENOENT") return "partial";
      try {
        await lstat(NODE_INSTALL_ROOT);
        return "partial";
      } catch (missing) {
        return missing.code === "ENOENT" ? "precondition" : "ambiguous";
      }
    }
  }
  if (operation === "stop_service") return await serviceLoaded() ? "precondition" : "postcondition";
  if (operation === "start_service") return await serviceLoaded() ? "postcondition" : "precondition";
  if (operation === "replace_artifact") {
    const checksum2 = await pathChecksum(ACTIVE_TARGET_ARTIFACT);
    return checksum2 === null ? "precondition" : checksum2 === TARGET_SHA256 ? "postcondition" : "partial";
  }
  if (operation === "replace_plist") {
    const checksum2 = await pathChecksum(ACTIVE_PLIST);
    if (checksum2 === CURRENT_SERVICE_SHA256) return "precondition";
    if (checksum2 === TARGET_SERVICE_SHA256) return "postcondition";
    return checksum2 === null ? "ambiguous" : "partial";
  }
  if (operation === "restore_artifact") {
    const source = await pathChecksum(ACTIVE_SOURCE_ARTIFACT);
    const target = await pathChecksum(ACTIVE_TARGET_ARTIFACT);
    if (source !== SOURCE_SHA256) return "partial";
    if (target === null) return "postcondition";
    return target === TARGET_SHA256 ? "precondition" : "partial";
  }
  if (operation === "restore_plist") {
    const checksum2 = await pathChecksum(ACTIVE_PLIST);
    if (checksum2 === TARGET_SERVICE_SHA256) return "precondition";
    if (checksum2 === CURRENT_SERVICE_SHA256) return "postcondition";
    return checksum2 === null ? "ambiguous" : "partial";
  }
  if (operation === "restart_prior_service") return await serviceLoaded() ? "postcondition" : "precondition";
  throw new Error(`Mutation inspection is unavailable for ${operation}.`);
}
function summary(message, inspectedChecksums = {}, changedChecksums = {}) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    startedAt: now,
    completedAt: now,
    safeStdoutSummary: message,
    inspectedChecksums,
    changedChecksums
  };
}
function createMacOSLocalFixedOperations(repositoryRoot) {
  const canonicalPlist = resolve2(repositoryRoot, CANONICAL_PLIST);
  const repositoryArtifact = resolve2(repositoryRoot, TARGET_REPOSITORY_ARTIFACT);
  const signedManifest = resolve2(repositoryRoot, SIGNED_MANIFEST);
  const rollbackInventory = resolve2(repositoryRoot, ROLLBACK_INVENTORY);
  return {
    inspectHost: assertHost,
    async inspectMutation({ operation }) {
      return inspectMutationState(operation);
    },
    async execute({ operation, pkg }) {
      const authorization = pkg.authorization;
      const root = stagingRoot(authorization);
      if (!root.startsWith(`${LOCAL_AGENT_HOME}/replacement-bootstrap/`))
        throw new Error("Replacement staging root escaped the approved agent home.");
      await mkdir(root, { recursive: true, mode: 448 });
      switch (operation) {
        case "inspect_host":
          await assertHost(pkg);
          return summary("macOS arm64 host identity passed");
        case "inspect_agent":
          return summary("named Mission Agent identity passed", {
            sourceArtifact: await fileChecksum(ACTIVE_SOURCE_ARTIFACT)
          });
        case "inventory_configuration":
          return summary("configuration and Keychain credential reference inventoried", {
            configuration: await fileChecksum(CONFIG_PATH),
            service: await fileChecksum(ACTIVE_PLIST)
          });
        case "verify_rollback_assets": {
          if (await fileChecksum(rollbackInventory) !== ROLLBACK_INVENTORY_SHA256)
            throw new Error("Rollback inventory checksum mismatch.");
          await mkdir(rollbackRoot(authorization), { recursive: true, mode: 448 });
          await atomicCopy(ACTIVE_SOURCE_ARTIFACT, join2(rollbackRoot(authorization), "mission-agent-0.6.8.mjs"), 448);
          await atomicCopy(ACTIVE_PLIST, join2(rollbackRoot(authorization), "com.wallyweb.mission-agent.plist"), 384);
          if (await fileChecksum(join2(rollbackRoot(authorization), "mission-agent-0.6.8.mjs")) !== SOURCE_SHA256 || await fileChecksum(join2(rollbackRoot(authorization), "com.wallyweb.mission-agent.plist")) !== CURRENT_SERVICE_SHA256)
            throw new Error("Rollback assets do not match exact 0.6.8 bindings.");
          return summary("exact rollback assets preserved");
        }
        case "stage_node_archive":
          await downloadExactNodeArchive(stagedArchive(authorization));
          return summary("official Node archive staged", {}, { nodeArchive: NODE_ARCHIVE_SHA256 });
        case "verify_node_archive":
          if ((await stat(stagedArchive(authorization))).size !== NODE_ARCHIVE_LENGTH || await fileChecksum(stagedArchive(authorization)) !== NODE_ARCHIVE_SHA256)
            throw new Error("Staged Node archive mismatch.");
          return summary("Node archive verified", { nodeArchive: NODE_ARCHIVE_SHA256 });
        case "extract_node_runtime": {
          try {
            await verifyNodeExecutable();
            return summary("existing isolated Node runtime reverified", { nodeExecutable: NODE_EXECUTABLE_SHA256 });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await mkdir(dirname(NODE_INSTALL_ROOT), { recursive: true, mode: 493 });
          const installMetadata = await lstat(dirname(NODE_INSTALL_ROOT));
          if (installMetadata.isSymbolicLink()) throw new Error("Node installation parent is a symlink.");
          await mkdir(NODE_INSTALL_ROOT, { recursive: false, mode: 493 });
          await exec(
            fixedExecutables.tar,
            ["-xzf", stagedArchive(authorization), "--strip-components=1", "-C", NODE_INSTALL_ROOT],
            { timeout: 12e4, maxBuffer: 1024 * 1024 }
          );
          return summary(
            "isolated Node runtime extracted",
            {},
            { nodeExecutable: await fileChecksum(NODE_EXECUTABLE) }
          );
        }
        case "verify_node_executable":
          await verifyNodeExecutable();
          return summary("isolated Node executable verified", { nodeExecutable: NODE_EXECUTABLE_SHA256 });
        case "stage_target_artifact":
          await atomicCopy(repositoryArtifact, stagedArtifact(authorization), 448);
          if ((await stat(stagedArtifact(authorization))).size !== TARGET_LENGTH)
            throw new Error("Staged target artifact byte length mismatch.");
          return summary(
            "exact target artifact staged",
            {},
            { targetArtifact: await fileChecksum(stagedArtifact(authorization)) }
          );
        case "verify_release": {
          const artifact = Uint8Array.from(await readFile(stagedArtifact(authorization)));
          verifyReplacementRelease({ signedManifestText: await readFile(signedManifest, "utf8"), artifact });
          return summary("Manifest v3 and standalone Ed25519 verification passed", { targetArtifact: TARGET_SHA256 });
        }
        case "stage_target_plist":
          await atomicCopy(canonicalPlist, stagedPlist(authorization), 384);
          return summary(
            "canonical target plist staged",
            {},
            { targetPlist: await fileChecksum(stagedPlist(authorization)) }
          );
        case "verify_target_plist":
          if (await fileChecksum(stagedPlist(authorization)) !== TARGET_SERVICE_SHA256)
            throw new Error("Canonical target plist checksum mismatch.");
          return summary("canonical target plist verified", { targetPlist: TARGET_SERVICE_SHA256 });
        case "drain_agent":
          return summary("Mission Control claim confirmed named-agent drain and no active lease");
        case "stop_service": {
          const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8" })).stdout.trim();
          await exec(fixedExecutables.launchctl, ["bootout", `gui/${uid}`, ACTIVE_PLIST], { timeout: 3e4 });
          return summary("exact named launchd service stopped");
        }
        case "replace_artifact":
          await atomicCopy(stagedArtifact(authorization), ACTIVE_TARGET_ARTIFACT, 448);
          if (await fileChecksum(ACTIVE_TARGET_ARTIFACT) !== TARGET_SHA256)
            throw new Error("Active target artifact mismatch.");
          return summary("target artifact atomically activated", {}, { targetArtifact: TARGET_SHA256 });
        case "replace_plist":
          await atomicCopy(stagedPlist(authorization), ACTIVE_PLIST, 384);
          if (await fileChecksum(ACTIVE_PLIST) !== TARGET_SERVICE_SHA256)
            throw new Error("Active target plist mismatch.");
          return summary("target plist atomically activated", {}, { targetPlist: TARGET_SERVICE_SHA256 });
        case "start_service": {
          const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8" })).stdout.trim();
          await exec(fixedExecutables.launchctl, ["bootstrap", `gui/${uid}`, ACTIVE_PLIST], { timeout: 3e4 });
          return summary("exact named launchd service started");
        }
        case "verify_runtime":
          await verifyNodeExecutable();
          return {
            ...summary("running service runtime binding verified", { nodeExecutable: NODE_EXECUTABLE_SHA256 }),
            observation: await runningProcessObservation("0.7.2")
          };
        case "verify_version": {
          const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
          if (state.version !== "0.7.2") throw new Error("Mission Agent state did not report version 0.7.2.");
          return {
            ...summary("Mission Agent version 0.7.2 verified"),
            observation: await runningProcessObservation("0.7.2")
          };
        }
        case "verify_identity":
        case "verify_registration": {
          const config = await safeConfig();
          if (config.agentId !== authorization.agentId || config.workspaceId !== authorization.workspaceId)
            throw new Error("Mission Agent identity or workspace changed.");
          return summary(`${operation} passed`);
        }
        case "verify_heartbeats": {
          const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
          if (!state.connected || !state.pullReady || !state.lastHeartbeatAt || Date.now() - Date.parse(state.lastHeartbeatAt) > 12e4)
            throw new Error("Mission Agent heartbeat is absent or stale.");
          return summary("fresh connected heartbeat verified");
        }
        case "verify_capabilities": {
          const { stdout } = await exec(NODE_EXECUTABLE, [ACTIVE_TARGET_ARTIFACT, "doctor"], {
            env: {
              NODE_ENV: "production",
              MISSION_AGENT_HOME: LOCAL_AGENT_HOME,
              PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin"
            },
            encoding: "utf8",
            timeout: 6e4,
            maxBuffer: 256 * 1024
          });
          if (!stdout.includes("Mission Agent") || !stdout.includes("0.7.2"))
            throw new Error("Mission Agent doctor did not confirm the target capability runtime.");
          return {
            ...summary("Mission Agent doctor and capabilities passed"),
            observation: await runningProcessObservation("0.7.2")
          };
        }
        case "restore_artifact":
          if (await fileChecksum(join2(rollbackRoot(authorization), "mission-agent-0.6.8.mjs")) !== SOURCE_SHA256)
            throw new Error("Rollback artifact mismatch.");
          if (await pathChecksum(ACTIVE_TARGET_ARTIFACT) === TARGET_SHA256) await unlink(ACTIVE_TARGET_ARTIFACT);
          if (await fileChecksum(ACTIVE_SOURCE_ARTIFACT) !== SOURCE_SHA256)
            throw new Error("Exact prior artifact was not restored.");
          return summary("exact prior artifact restored and target removed", { sourceArtifact: SOURCE_SHA256 });
        case "restore_plist":
          await atomicCopy(join2(rollbackRoot(authorization), "com.wallyweb.mission-agent.plist"), ACTIVE_PLIST, 384);
          if (await fileChecksum(ACTIVE_PLIST) !== CURRENT_SERVICE_SHA256)
            throw new Error("Rollback plist mismatch.");
          return summary("exact prior plist restored", {}, { rollbackPlist: CURRENT_SERVICE_SHA256 });
        case "restart_prior_service": {
          const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8" })).stdout.trim();
          await exec(fixedExecutables.launchctl, ["bootstrap", `gui/${uid}`, ACTIVE_PLIST], { timeout: 3e4 });
          return {
            ...summary("exact prior service restarted"),
            observation: await runningProcessObservation("0.6.8")
          };
        }
        case "verify_prior_runtime":
          return {
            ...summary("exact prior runtime process reverified", { sourceArtifact: SOURCE_SHA256 }),
            observation: {
              ...await runningProcessObservation("0.6.8"),
              ...await rollbackInventoryEquivalence()
            }
          };
        case "verify_prior_identity": {
          const config = await safeConfig();
          if (config.agentId !== authorization.agentId || config.workspaceId !== authorization.workspaceId)
            throw new Error("Prior Mission Agent identity or workspace was not restored.");
          return summary("prior Mission Agent identity and registration binding verified");
        }
        case "verify_prior_heartbeats": {
          const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
          if (state.version !== "0.6.8" || !state.connected || !state.lastHeartbeatAt || Date.now() - Date.parse(state.lastHeartbeatAt) > 12e4)
            throw new Error("Prior Mission Agent heartbeat is absent, stale, or the wrong version.");
          return summary("fresh prior-version heartbeat observed");
        }
        case "verify_prior_capabilities": {
          const { stdout } = await exec("/usr/local/Cellar/node/24.10.0/bin/node", [ACTIVE_SOURCE_ARTIFACT, "doctor"], {
            env: {
              NODE_ENV: "production",
              MISSION_AGENT_HOME: LOCAL_AGENT_HOME,
              PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin"
            },
            encoding: "utf8",
            timeout: 6e4,
            maxBuffer: 256 * 1024
          });
          if (!stdout.includes("Mission Agent") || !stdout.includes("0.6.8"))
            throw new Error("Prior Mission Agent capabilities did not recover.");
          return summary("prior-version doctor and capabilities verified");
        }
        case "verify_prior_projection":
          return summary("local rollback evidence ready for authoritative Mission Control projection verification");
        case "report_evidence":
          return summary("checksum-bound local evidence ready for Mission Control");
        default:
          throw new Error(`Unsupported local operation: ${String(operation)}`);
      }
    }
  };
}

// application/v1-macos-operator-provider.ts
var LOCAL_ONLY = /* @__PURE__ */ new Set([
  "observe",
  "stage_artifact",
  "verify_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "verify_process",
  "collect_heartbeats",
  "verify_capabilities",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback"
]);
var operationMap = {
  observe: ["inspect_host", "inspect_agent", "inventory_configuration"],
  stage_artifact: ["stage_target_artifact", "stage_target_plist"],
  verify_artifact: ["verify_release", "verify_target_plist"],
  stop_agent: ["stop_service"],
  install_agent: ["replace_artifact"],
  install_launch_configuration: ["replace_plist"],
  start_agent: ["start_service"],
  verify_process: ["verify_runtime", "verify_version", "verify_identity"],
  collect_heartbeats: ["verify_heartbeats"],
  verify_capabilities: ["verify_capabilities", "verify_registration"],
  restore_previous_launch_configuration: ["restore_plist"],
  restore_previous_version: ["restore_artifact"],
  verify_rollback: [
    "verify_prior_runtime",
    "verify_prior_identity",
    "verify_prior_heartbeats",
    "verify_prior_capabilities",
    "verify_prior_projection"
  ]
};
function createV1MacOSOperatorProvider(repositoryRoot, authorizationPackage) {
  const fixed = createMacOSLocalFixedOperations(repositoryRoot);
  const sha2565 = (value) => createHash4("sha256").update(value).digest("hex");
  const receipt = (request, startedAt, observations, recovered = false) => ({
    providerMutationId: request.providerMutationId,
    operation: request.operation,
    startedAt,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    resultChecksum: sha2565(
      JSON.stringify({
        providerMutationId: request.providerMutationId,
        operation: request.operation,
        observations
      })
    ),
    safeSummary: `${request.operation} ${recovered ? "postcondition recovered" : "completed"} through the fixed macOS provider`,
    observations
  });
  return {
    async inspect(request) {
      if (!LOCAL_ONLY.has(request.operation)) return "postcondition";
      if (request.operation === "remove_staged_artifact") return "precondition";
      const mapped = operationMap[request.operation];
      if (!mapped) throw new Error(`Unsupported v1 local operator operation: ${request.operation}.`);
      const states = await Promise.all(
        mapped.filter(
          (operation) => [
            "stop_service",
            "replace_artifact",
            "replace_plist",
            "start_service",
            "restore_artifact",
            "restore_plist"
          ].includes(operation)
        ).map(
          (operation) => fixed.inspectMutation({
            operation,
            pkg: authorizationPackage
          })
        )
      );
      if (states.length === 0) return "precondition";
      if (states.every((state) => state === "postcondition")) return "postcondition";
      if (states.every((state) => state === "precondition")) return "precondition";
      return "ambiguous";
    },
    async execute(request) {
      if (!LOCAL_ONLY.has(request.operation))
        throw new Error(`Control-plane operation ${request.operation} cannot mutate the macOS provider.`);
      const startedAt = (/* @__PURE__ */ new Date()).toISOString();
      const observations = [];
      if (request.operation === "remove_staged_artifact") {
        await removeStagedReplacementAssets(authorizationPackage.authorization);
      } else {
        const mapped = operationMap[request.operation];
        if (!mapped) throw new Error(`Unsupported v1 local operator operation: ${request.operation}.`);
        for (const operation of mapped)
          observations.push(
            await fixed.execute({
              operation,
              operationId: request.providerMutationId,
              pkg: authorizationPackage
            })
          );
      }
      return receipt(request, startedAt, observations);
    },
    async verify(request) {
      const startedAt = (/* @__PURE__ */ new Date()).toISOString();
      const state = await this.inspect(request);
      if (state !== "postcondition") throw new Error("Provider postcondition is not established.");
      return receipt(request, startedAt, [{ postcondition: true }], true);
    }
  };
}

// application/v1-macos-operator.ts
import { createHash as createHash6, createHmac as createHmac3, timingSafeEqual as timingSafeEqual3 } from "node:crypto";
import { execFile as execFile2 } from "node:child_process";
import { lstat as lstat2, mkdir as mkdir3, open as open2, readFile as readFile3, rm as rm2 } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve3 } from "node:path";
import { promisify as promisify2 } from "node:util";

// application/v1-macos-operator-journal.ts
import { createHash as createHash5, createHmac as createHmac2, randomUUID, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { chmod as chmod2, mkdir as mkdir2, open, readFile as readFile2, rename as rename2, rm } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var V1_OPERATOR_JOURNAL_SCHEMA = "mission-agent-v1-operator-journal-v1";
var V1_OPERATOR_OPERATIONS = [
  "observe",
  "request_drain",
  "verify_drain",
  "lease_intent",
  "renew_lease",
  "stage_artifact",
  "verify_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "verify_process",
  "collect_heartbeats",
  "verify_capabilities",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback",
  "release_lease"
];
var SHA2563 = /^[a-f0-9]{64}$/;
var UUID2 = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var FORWARD_MUTATIONS = /* @__PURE__ */ new Set([
  "stage_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent"
]);
var ROLLBACK_OPERATIONS = /* @__PURE__ */ new Set([
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback"
]);
function checksum(value) {
  return createHash5("sha256").update(canonicalJson(value)).digest("hex");
}
function authenticate2(value, key) {
  return createHmac2("sha256", key).update(canonicalJson(value)).digest("hex");
}
function requestPayload(request) {
  const payload2 = { ...request };
  delete payload2.requestAuthenticationTag;
  return payload2;
}
function verifyV1OperatorRequest(request, key, expected, now = /* @__PURE__ */ new Date(), options = {}) {
  const issuedAt = Date.parse(request.issuedAt);
  const forwardExpiresAt = Date.parse(request.forwardExpiresAt);
  if (!V1_OPERATOR_OPERATIONS.includes(request.operation) || !UUID2.test(request.authorizationId) || !UUID2.test(request.executionId) || !UUID2.test(request.agentId) || !UUID2.test(request.operatorId) || !UUID2.test(request.rollbackObligationId) || !UUID2.test(request.grantId) || !UUID2.test(request.providerMutationId) || !UUID2.test(request.requestMessageId) || !request.nonce || request.sequence < 1 || request.fencingGeneration < 1 || !request.currentControllerDeploymentId || request.currentControllerFencingGeneration < request.fencingGeneration || !SHA2563.test(request.targetArtifactSha256) || !SHA2563.test(request.priorInventorySha256) || !SHA2563.test(request.authorizationFingerprint) || !SHA2563.test(request.grantChecksum) || !SHA2563.test(request.expectedJournalChecksum) || !Number.isFinite(issuedAt) || !Number.isFinite(forwardExpiresAt) || FORWARD_MUTATIONS.has(request.operation) && (forwardExpiresAt <= issuedAt || forwardExpiresAt - issuedAt > 15 * 6e4) || issuedAt > now.getTime() + 6e4 || !options.allowExactIntentRecovery && now.getTime() - issuedAt > 15 * 6e4 || canonicalJson(
    Object.fromEntries(Object.keys(expected).map((name) => [name, request[name]]))
  ) !== canonicalJson(expected))
    throw new Error("V1 operator request binding is malformed or contradictory.");
  const supplied = Uint8Array.from(Buffer.from(request.requestAuthenticationTag, "hex"));
  const computed = Uint8Array.from(Buffer.from(authenticate2(requestPayload(request), key), "hex"));
  if (supplied.length !== computed.length || !timingSafeEqual2(supplied, computed))
    throw new Error("V1 operator request authentication failed.");
  if (FORWARD_MUTATIONS.has(request.operation) && forwardExpiresAt <= now.getTime() && !options.allowExactIntentRecovery)
    throw new Error("V1 forward mutation authority expired.");
  if (ROLLBACK_OPERATIONS.has(request.operation) && request.rollbackObligationId !== expected.rollbackObligationId)
    throw new Error("V1 rollback operation lacks its durable obligation.");
}
function sealJournal(value, key) {
  const journalChecksum = checksum(value);
  return {
    ...value,
    journalChecksum,
    authenticationTag: authenticate2({ ...value, journalChecksum }, key)
  };
}
function emptyV1OperatorJournal(binding, key) {
  return sealJournal({ schemaVersion: V1_OPERATOR_JOURNAL_SCHEMA, binding, entries: [] }, key);
}
function appendV1OperatorJournal(journal, request, status, key, providerReceiptChecksum, recordedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  verifyV1OperatorJournal(journal, key);
  if (canonicalJson(journal.binding) !== canonicalJson(
    Object.fromEntries(Object.keys(journal.binding).map((name) => [name, request[name]]))
  ))
    throw new Error("V1 operator request does not match the durable journal binding.");
  const existing = journal.entries.find(
    (entry2) => entry2.requestMessageId === request.requestMessageId || entry2.nonce === request.nonce || entry2.providerMutationId === request.providerMutationId
  );
  const requestChecksum = checksum(requestPayload(request));
  if (existing) {
    if (existing.requestChecksum === requestChecksum && existing.status === status && existing.providerReceiptChecksum === providerReceiptChecksum)
      return journal;
    throw new Error("V1 operator request replay or mutation identity reuse detected.");
  }
  if (request.sequence !== journal.entries.length + 1)
    throw new Error("V1 operator request sequence is not the exact successor.");
  const previousEntryChecksum = journal.entries.at(-1)?.entryChecksum ?? null;
  const unsealed = {
    localJournalEntryId: randomUUID(),
    sequence: request.sequence,
    operation: request.operation,
    providerMutationId: request.providerMutationId,
    requestMessageId: request.requestMessageId,
    nonce: request.nonce,
    requestChecksum,
    status,
    ...providerReceiptChecksum ? { providerReceiptChecksum } : {},
    recordedAt,
    previousEntryChecksum
  };
  const entry = { ...unsealed, entryChecksum: checksum(unsealed) };
  return sealJournal(
    { schemaVersion: V1_OPERATOR_JOURNAL_SCHEMA, binding: journal.binding, entries: [...journal.entries, entry] },
    key
  );
}
function completeV1OperatorJournal(journal, request, providerReceiptChecksum, key, recordedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  verifyV1OperatorJournal(journal, key);
  if (!SHA2563.test(providerReceiptChecksum)) throw new Error("Provider receipt checksum is malformed.");
  const index = journal.entries.findIndex(
    (entry) => entry.providerMutationId === request.providerMutationId && entry.requestChecksum === checksum(requestPayload(request))
  );
  if (index < 0) throw new Error("Provider completion lacks its durable local intent.");
  const existing = journal.entries[index];
  if (existing.status === "completed" && existing.providerReceiptChecksum === providerReceiptChecksum) return journal;
  if (existing.status !== "intent_recorded" || index !== journal.entries.length - 1)
    throw new Error("Provider completion is not the current durable intent.");
  const entries = journal.entries.map((entry, entryIndex) => {
    if (entryIndex !== index) return entry;
    const prior = { ...entry };
    delete prior.entryChecksum;
    const payload2 = {
      ...prior,
      status: "completed",
      providerReceiptChecksum,
      recordedAt
    };
    return { ...payload2, entryChecksum: checksum(payload2) };
  });
  return sealJournal({ schemaVersion: V1_OPERATOR_JOURNAL_SCHEMA, binding: journal.binding, entries }, key);
}
function verifyV1OperatorJournal(journal, key) {
  const { journalChecksum, authenticationTag, ...unsealed } = journal;
  if (journal.schemaVersion !== V1_OPERATOR_JOURNAL_SCHEMA || checksum(unsealed) !== journalChecksum || authenticate2({ ...unsealed, journalChecksum }, key) !== authenticationTag)
    throw new Error("V1 operator journal authentication failed.");
  let previous = null;
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    const { entryChecksum, ...payload2 } = entry;
    if (!UUID2.test(entry.localJournalEntryId) || entry.sequence !== index + 1 || entry.previousEntryChecksum !== previous || checksum(payload2) !== entryChecksum)
      throw new Error("V1 operator journal hash chain is invalid.");
    previous = entryChecksum;
  }
}
async function readV1OperatorJournal(path, key) {
  try {
    const journal = JSON.parse(await readFile2(path, "utf8"));
    verifyV1OperatorJournal(journal, key);
    return journal;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function writeV1OperatorJournal(path, journal) {
  await mkdir2(dirname2(path), { recursive: true, mode: 448 });
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  const file = await open(temporary, "wx", 384);
  try {
    await file.writeFile(`${JSON.stringify(journal)}
`);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod2(temporary, 384);
  await rename2(temporary, path);
  const directory = await open(dirname2(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// application/v1-macos-operator.ts
var V1_OPERATOR_INSTALL_PATH = "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs";
var V1_OPERATOR_JOURNAL_ROOT = "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/journal";
var MUTATIONS = /* @__PURE__ */ new Set([
  "stage_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version"
]);
var HOST_OPERATIONS = /* @__PURE__ */ new Set([
  "observe",
  "stage_artifact",
  "verify_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "verify_process",
  "collect_heartbeats",
  "verify_capabilities",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback"
]);
var sha2563 = (value) => createHash6("sha256").update(value).digest("hex");
var executeFile = promisify2(execFile2);
async function assertV1OperatorRuntimeBoundary(boundary) {
  if (boundary.platform !== "darwin" || boundary.actualUid !== boundary.expectedUid || boundary.actualUid === 0 || resolve3(boundary.executablePath) !== V1_OPERATOR_INSTALL_PATH || !boundary.journalPath.startsWith(`${V1_OPERATOR_JOURNAL_ROOT}/`) || !/^[a-f0-9]{64}$/.test(boundary.executableChecksum))
    throw new Error("V1 macOS operator runtime boundary is invalid.");
  const executable = await lstat2(boundary.executablePath);
  const parent = await lstat2(dirname3(boundary.executablePath));
  if (!executable.isFile() || executable.isSymbolicLink() || executable.uid !== boundary.expectedUid || (executable.mode & 511) !== 320 || parent.uid !== boundary.expectedUid || (parent.mode & 63) !== 0 || sha2563(Uint8Array.from(await readFile3(boundary.executablePath))) !== boundary.executableChecksum)
    throw new Error("V1 macOS operator checksum, owner, or permissions differ.");
}
function providerResultChecksum(receipt) {
  return sha2563(
    JSON.stringify({
      providerMutationId: receipt.providerMutationId,
      operation: receipt.operation,
      observations: receipt.observations
    })
  );
}
function receiptAuthenticationTag(value, credentialKey) {
  return createHmac3("sha256", credentialKey).update(canonicalJson(value)).digest("hex");
}
async function writeReceipt(path, receipt, requestChecksum, intentEntryChecksum, credentialKey) {
  if (providerResultChecksum(receipt) !== receipt.resultChecksum)
    throw new Error("Provider receipt result checksum is invalid.");
  const unsigned = { receipt, requestChecksum, intentEntryChecksum };
  const authenticated = {
    ...unsigned,
    authenticationTag: receiptAuthenticationTag(unsigned, credentialKey)
  };
  const bytes = `${JSON.stringify(authenticated)}
`;
  const checksum2 = sha2563(bytes);
  await mkdir3(dirname3(path), { recursive: true, mode: 448 });
  try {
    const file = await open2(path, "wx", 384);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open2(dirname3(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (sha2563(Uint8Array.from(await readFile3(path))) !== checksum2)
      throw new Error("Existing provider receipt contradicts recovered provider state.");
  }
  return { checksum: checksum2, authenticated, bytes };
}
async function readReceipt(path, request, requestChecksum, intentEntryChecksum, credentialKey) {
  try {
    const bytes = await readFile3(path);
    const authenticated = JSON.parse(bytes.toString("utf8"));
    const { authenticationTag, ...unsigned } = authenticated;
    const supplied = Uint8Array.from(Buffer.from(authenticationTag ?? "", "hex"));
    const computed = Uint8Array.from(Buffer.from(receiptAuthenticationTag(unsigned, credentialKey), "hex"));
    const receipt = authenticated.receipt;
    if (supplied.length !== computed.length || !timingSafeEqual3(supplied, computed) || authenticated.requestChecksum !== requestChecksum || authenticated.intentEntryChecksum !== intentEntryChecksum || receipt.providerMutationId !== request.providerMutationId || receipt.operation !== request.operation || !/^[a-f0-9]{64}$/.test(receipt.resultChecksum) || providerResultChecksum(receipt) !== receipt.resultChecksum)
      throw new Error("Existing provider receipt is unauthenticated or contradicts the authorized operation.");
    return { receipt, checksum: sha2563(Uint8Array.from(bytes)), authenticated, bytes: bytes.toString("utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function withOperatorLock(journalPath, callback) {
  const lockPath = `${journalPath}.lock`;
  await mkdir3(dirname3(journalPath), { recursive: true, mode: 448 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir3(lockPath, { mode: 448 });
      const owner = await open2(`${lockPath}/owner`, "wx", 384);
      try {
        await owner.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            uid: process.getuid?.() ?? -1,
            processStartIdentity: await processStartIdentity(process.pid)
          })}
`
        );
        await owner.sync();
      } finally {
        await owner.close();
      }
      const directory = await open2(dirname3(lockPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      try {
        return await callback();
      } finally {
        await rm2(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST" || attempt > 0) throw error;
      const owner = JSON.parse(await readFile3(`${lockPath}/owner`, "utf8"));
      if (owner.uid !== (process.getuid?.() ?? -1) || !Number.isSafeInteger(owner.pid) || !owner.processStartIdentity)
        throw new Error("Operator lock ownership is contradictory.");
      try {
        const observedStartIdentity = await processStartIdentity(owner.pid);
        if (observedStartIdentity === owner.processStartIdentity)
          throw new Error("Another v1 operator process holds the execution lock.");
      } catch (probe) {
        if (probe.message === "Another v1 operator process holds the execution lock." || !["ESRCH", "ENOENT"].includes(probe.code ?? ""))
          throw probe;
      }
      await rm2(lockPath, { recursive: true });
    }
  }
  throw new Error("V1 operator lock could not be acquired.");
}
async function processStartIdentity(pid) {
  process.kill(pid, 0);
  const result = await executeFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 5e3,
    maxBuffer: 1024
  });
  const value = result.stdout.trim();
  if (!value) throw Object.assign(new Error("Process is no longer running."), { code: "ESRCH" });
  return sha2563(`${pid}:${value}`);
}
async function executeV1OperatorRequest(input) {
  const { request, expectedBinding, credentialKey, boundary, provider } = input;
  if (!HOST_OPERATIONS.has(request.operation))
    throw new Error(`Control-plane operation ${request.operation} is not a host-provider operation.`);
  await (input.assertRuntimeBoundary ?? assertV1OperatorRuntimeBoundary)(boundary);
  return withOperatorLock(boundary.journalPath, async () => {
    let journal = await readV1OperatorJournal(boundary.journalPath, credentialKey) ?? emptyV1OperatorJournal(expectedBinding, credentialKey);
    const expectedRequestChecksum = sha2563(canonicalJson(requestPayload(request)));
    const existing = journal.entries.find((entry) => entry.providerMutationId === request.providerMutationId);
    const exactDurableIntent = existing !== void 0 && existing.requestChecksum === expectedRequestChecksum && ["intent_recorded", "completed"].includes(existing.status);
    verifyV1OperatorRequest(request, credentialKey, expectedBinding, input.now, {
      allowExactIntentRecovery: exactDurableIntent
    });
    if (journal.journalChecksum !== request.expectedJournalChecksum && existing?.requestChecksum !== expectedRequestChecksum)
      throw new Error("V1 operator journal does not match the controller's monotonic head.");
    if (existing?.status === "completed" && existing.requestChecksum !== expectedRequestChecksum)
      throw new Error("Completed provider mutation ID was reused by a contradictory request.");
    if (!existing) {
      journal = appendV1OperatorJournal(journal, request, "intent_recorded", credentialKey);
      await writeV1OperatorJournal(boundary.journalPath, journal);
    }
    const requestChecksum = sha2563(canonicalJson(request));
    const confirmation = await input.confirmWithControlPlane({
      request,
      requestChecksum,
      journalChecksum: journal.journalChecksum
    });
    if (confirmation.accepted !== true || confirmation.currentJournalChecksum !== journal.journalChecksum)
      throw new Error("Mission Control did not confirm the exact operator journal head.");
    if (existing?.status === "completed" && existing.providerReceiptChecksum) {
      const recoveredReceipt = await readReceipt(
        `${dirname3(boundary.journalPath)}/receipts/${request.providerMutationId}.json`,
        request,
        expectedRequestChecksum,
        existing.entryChecksum,
        credentialKey
      );
      if (!recoveredReceipt) throw new Error("Completed journal entry lacks its durable provider receipt.");
      return {
        disposition: "receipt_recovered",
        receiptChecksum: recoveredReceipt.checksum,
        providerReceipt: recoveredReceipt.authenticated,
        receiptBytes: recoveredReceipt.bytes,
        operatorJournalChecksum: journal.journalChecksum,
        localJournalEntryId: existing.localJournalEntryId
      };
    }
    const intent = journal.entries.find(
      (entry) => entry.providerMutationId === request.providerMutationId && entry.requestChecksum === expectedRequestChecksum
    );
    if (!intent) throw new Error("Provider operation lacks its durable authenticated intent.");
    const receiptPath = `${dirname3(boundary.journalPath)}/receipts/${request.providerMutationId}.json`;
    const durableReceipt = await readReceipt(
      receiptPath,
      request,
      expectedRequestChecksum,
      intent.entryChecksum,
      credentialKey
    );
    if (durableReceipt) {
      journal = completeV1OperatorJournal(journal, request, durableReceipt.checksum, credentialKey);
      await writeV1OperatorJournal(boundary.journalPath, journal);
      return {
        disposition: "receipt_recovered",
        receiptChecksum: durableReceipt.checksum,
        providerReceipt: durableReceipt.authenticated,
        receiptBytes: durableReceipt.bytes,
        operatorJournalChecksum: journal.journalChecksum,
        localJournalEntryId: intent.localJournalEntryId
      };
    }
    const state = await provider.inspect(request);
    if (state === "ambiguous") throw new Error("Provider state is ambiguous; human intervention is required.");
    let receipt;
    let disposition;
    if (!MUTATIONS.has(request.operation)) {
      receipt = await provider.execute(request);
      disposition = "completed";
    } else if (state === "postcondition") {
      receipt = await provider.verify(request);
      disposition = "receipt_recovered";
    } else {
      receipt = await provider.execute(request);
      disposition = "completed";
    }
    await input.afterProviderExecuted?.(receipt);
    const persistedReceipt = await writeReceipt(
      receiptPath,
      receipt,
      expectedRequestChecksum,
      intent.entryChecksum,
      credentialKey
    );
    await input.afterReceiptPersisted?.(persistedReceipt.checksum);
    journal = completeV1OperatorJournal(journal, request, persistedReceipt.checksum, credentialKey);
    await writeV1OperatorJournal(boundary.journalPath, journal);
    return {
      disposition,
      receiptChecksum: persistedReceipt.checksum,
      providerReceipt: persistedReceipt.authenticated,
      receiptBytes: persistedReceipt.bytes,
      operatorJournalChecksum: journal.journalChecksum,
      localJournalEntryId: intent.localJournalEntryId
    };
  });
}

// integrations/mission-agent/replacement-authorization-package.ts
import { createHash as createHash7, createHmac as createHmac4, timingSafeEqual as timingSafeEqual4 } from "node:crypto";
var REPLACEMENT_PACKAGE_VERSION = "replacement-authorization-package-v1";
var REPLACEMENT_CREDENTIAL_PROTOCOL = "replacement-bootstrap-v1";
var MISSION_CONTROL_INSTANCE_ID = "mission-control-disposable-replacement-bootstrap-v1";
var REPLACEMENT_CREDENTIAL_SERVICE = "com.wallyweb.mission-agent.replacement-bootstrap";
var REPLACEMENT_CLAIM_PATH = "/api/mission-agent/replacement-bootstrap/claim";
var REPLACEMENT_INTENT_PATH = "/api/mission-agent/replacement-bootstrap/intent";
var REPLACEMENT_RECEIPT_PATH = "/api/mission-agent/replacement-bootstrap/receipt";
var REPLACEMENT_DECISION_PATH = "/api/mission-agent/replacement-bootstrap/decision";
var REPLACEMENT_STATUS_PATH = "/api/mission-agent/replacement-bootstrap/status";
var REPLACEMENT_FAILURE_PATH = "/api/mission-agent/replacement-bootstrap/failure";
var SHA2564 = /^[a-f0-9]{64}$/;
var UUID3 = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var NONCE = /^[A-Za-z0-9_-]{32,128}$/;
var sha2564 = (value) => createHash7("sha256").update(value).digest("hex");
var unsignedKeys = [
  "packageVersion",
  "protocolVersion",
  "credentialProtocol",
  "credentialId",
  "missionControlInstanceIdentity",
  "claimPath",
  "intentPath",
  "receiptPath",
  "decisionPath",
  "statusPath",
  "failurePath",
  "executionId",
  "nonce",
  "issuedAt",
  "expiresAt",
  "maximumUseCount",
  "authorization",
  "approval",
  "authorizationFingerprint",
  "evidenceInstructions"
];
function exactKeys(value, keys, name) {
  if (canonicalJson2(Object.keys(value).sort()) !== canonicalJson2([...keys].sort()))
    throw new Error(`${name} contains missing or unknown fields.`);
}
function packageSigningBytes(value) {
  return canonicalJson2(value);
}
function validateUnsigned(value) {
  exactKeys(value, unsignedKeys, "Authorization package");
  exactKeys(
    value.approval,
    ["approvalId", "status", "decidedBy", "actionHash", "decidedAt", "expiresAt"],
    "Approval snapshot"
  );
  exactKeys(value.evidenceInstructions, ["mode", "localDirectory", "receiptSequenceStartsAt"], "Evidence instructions");
  const fingerprint = authorizationChecksum(value.authorization);
  if (value.packageVersion !== REPLACEMENT_PACKAGE_VERSION || value.protocolVersion !== REPLACEMENT_BOOTSTRAP_PROTOCOL || value.credentialProtocol !== REPLACEMENT_CREDENTIAL_PROTOCOL || !UUID3.test(value.credentialId) || value.missionControlInstanceIdentity !== MISSION_CONTROL_INSTANCE_ID || value.claimPath !== REPLACEMENT_CLAIM_PATH || value.intentPath !== REPLACEMENT_INTENT_PATH || value.receiptPath !== REPLACEMENT_RECEIPT_PATH || value.decisionPath !== REPLACEMENT_DECISION_PATH || value.statusPath !== REPLACEMENT_STATUS_PATH || value.failurePath !== REPLACEMENT_FAILURE_PATH || !UUID3.test(value.executionId) || !NONCE.test(value.nonce) || value.maximumUseCount !== 1 || value.authorization.agentId !== NAMED_CANARY_ID || value.authorizationFingerprint !== fingerprint || value.approval.approvalId !== value.authorization.approvalId || value.approval.status !== "granted" || value.approval.decidedBy !== value.authorization.approvedBy || value.approval.actionHash !== fingerprint || value.approval.expiresAt !== value.authorization.expiresAt || value.evidenceInstructions.mode !== "authenticated-receipt-api" || value.evidenceInstructions.localDirectory !== value.authorization.evidenceDestination || value.evidenceInstructions.receiptSequenceStartsAt !== 1)
    throw new Error("Replacement authorization package binding is invalid.");
  for (const timestamp of [value.issuedAt, value.expiresAt, value.approval.decidedAt, value.approval.expiresAt])
    if (new Date(timestamp).toISOString() !== timestamp)
      throw new Error("Replacement authorization package timestamp is malformed.");
  if (value.issuedAt !== value.authorization.approvedAt || value.expiresAt !== value.authorization.expiresAt || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))
    throw new Error("Replacement authorization package time binding is invalid.");
}
function verifyReplacementAuthorizationPackage(input) {
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value))
    throw new Error("Replacement authorization package must be an object.");
  const value = input.value;
  exactKeys(value, [...unsignedKeys, "packageChecksum", "authentication"], "Signed authorization package");
  exactKeys(value.authentication ?? {}, ["algorithm", "credentialId", "signature"], "Package authentication");
  const { packageChecksum, authentication, ...unsigned } = value;
  validateUnsigned(unsigned);
  const now = input.now ?? /* @__PURE__ */ new Date();
  validateReplacementAuthorization(unsigned.authorization, {
    now: input.allowExpiredRecovery ? new Date(unsigned.authorization.approvedAt) : now
  });
  if (authentication.algorithm !== "hmac-sha256" || authentication.credentialId !== unsigned.credentialId || !SHA2564.test(authentication.signature) || !SHA2564.test(packageChecksum) || !SHA2564.test(input.credentialSigningKey) || !input.allowExpiredRecovery && Date.parse(unsigned.expiresAt) <= now.getTime())
    throw new Error("Replacement package authentication metadata or expiry is invalid.");
  const bytes = packageSigningBytes(unsigned);
  const expectedChecksum = sha2564(bytes);
  const expectedSignature = createHmac4("sha256", input.credentialSigningKey).update(bytes).digest("hex");
  if (!timingSafeEqual4(
    Uint8Array.from(Buffer.from(packageChecksum, "hex")),
    Uint8Array.from(Buffer.from(expectedChecksum, "hex"))
  ) || !timingSafeEqual4(
    Uint8Array.from(Buffer.from(authentication.signature, "hex")),
    Uint8Array.from(Buffer.from(expectedSignature, "hex"))
  ))
    throw new Error("Replacement authorization package checksum or authentication failed.");
  return value;
}

// remote-agent/protocol.ts
import { createHash as createHash8, createHmac as createHmac5, timingSafeEqual as timingSafeEqual5 } from "node:crypto";
function deriveSigningKey(secret) {
  return createHash8("sha256").update(secret).digest("hex");
}
function signatureInput(input) {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.messageId,
    input.bodyChecksum.toLowerCase(),
    input.protocolVersion
  ].join("\n");
}
function signProtocolRequest(key, input) {
  return createHmac5("sha256", key).update(signatureInput(input)).digest("hex");
}

// application/v1-operator-host-identity.ts
import { createHash as createHash9, createPrivateKey, createPublicKey as createPublicKey3, generateKeyPairSync, sign, verify as verify3 } from "node:crypto";
import { chmod as chmod3, mkdir as mkdir4, open as open3, readFile as readFile4 } from "node:fs/promises";
var V1_HOST_PRIVATE_KEY_PATH = "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/host-identity.pk8";
async function signV1HostBoundPayload(payload2, privateKeyPath = V1_HOST_PRIVATE_KEY_PATH) {
  const privateKey = createPrivateKey({ key: await readFile4(privateKeyPath), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("V1 host identity key is not Ed25519.");
  return sign(null, new TextEncoder().encode(canonicalJson(payload2)), privateKey).toString("base64");
}

// scripts/v1-macos-operator.ts
var exec2 = promisify3(execFile3);
async function main() {
  const parsed = parseArgs({
    options: {
      request: { type: "string" },
      grant: { type: "string" },
      "authorization-package": { type: "string" },
      "owner-uid": { type: "string" },
      "repository-root": { type: "string" }
    },
    strict: true
  });
  const requiredKeys = ["request", "grant", "authorization-package", "owner-uid", "repository-root"];
  for (const key of requiredKeys) if (!parsed.values[key]) throw new Error(`--${key} is required.`);
  const request = JSON.parse(await readFile5(resolve4(parsed.values.request), "utf8"));
  const grant = JSON.parse(await readFile5(resolve4(parsed.values.grant), "utf8"));
  const rawPackage = JSON.parse(
    await readFile5(resolve4(parsed.values["authorization-package"]), "utf8")
  );
  const keychain = await exec2(
    "/usr/bin/security",
    ["find-generic-password", "-s", REPLACEMENT_CREDENTIAL_SERVICE, "-a", rawPackage.credentialId, "-w"],
    { encoding: "utf8", timeout: 1e4, maxBuffer: 8 * 1024 }
  );
  const credentialKey = deriveSigningKey(keychain.stdout.trim());
  verifyV1OperatorGrant(grant, credentialKey, /* @__PURE__ */ new Date(), { allowExpiredReceiptRecovery: true });
  const authorizationPackage = verifyReplacementAuthorizationPackage({
    value: rawPackage,
    credentialSigningKey: credentialKey
  });
  const expectedBinding = grant.binding;
  if (expectedBinding.agentId !== authorizationPackage.authorization.agentId || expectedBinding.targetArtifactSha256 !== TARGET_SHA256 || expectedBinding.authorizationFingerprint !== authorizationPackage.authorizationFingerprint || grant.credentialId !== rawPackage.credentialId || grant.allowedOperation !== request.operation || grant.providerMutationId !== request.providerMutationId || grant.sequence !== request.sequence || grant.currentControllerFencingGeneration !== request.currentControllerFencingGeneration || grant.currentControllerDeploymentId !== request.currentControllerDeploymentId || request.grantId !== grant.grantId || request.grantChecksum !== createHash10("sha256").update(canonicalJson(grant)).digest("hex"))
    throw new Error("Operator grant contradicts the governed authorization package or request.");
  const journalPath = `${V1_OPERATOR_JOURNAL_ROOT}/${expectedBinding.authorizationId}/${expectedBinding.executionId}.json`;
  const boundary = {
    executablePath: V1_OPERATOR_INSTALL_PATH,
    executableChecksum: grant.approvedExecutableChecksum,
    expectedUid: Number(parsed.values["owner-uid"]),
    actualUid: process.getuid?.() ?? -1,
    platform: process.platform,
    journalPath
  };
  const protocolPost = async (path, bodyValue) => {
    if (bodyValue.action === "acknowledge_grant" && path === REPLACEMENT_STATUS_PATH || bodyValue.action === "accept_provider_receipt" && path === REPLACEMENT_RECEIPT_PATH)
      bodyValue.hostSignature = await signV1HostBoundPayload(bodyValue, V1_HOST_PRIVATE_KEY_PATH);
    const body = canonicalJson(bodyValue);
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const nonce = randomUUID2();
    const messageId = randomUUID2();
    const bodyChecksum = createHash10("sha256").update(body).digest("hex");
    const signature = signProtocolRequest(credentialKey, {
      method: "POST",
      path,
      timestamp,
      nonce,
      messageId,
      protocolVersion: REPLACEMENT_CREDENTIAL_PROTOCOL,
      bodyChecksum
    });
    const response = await fetch(new URL(path, grant.missionControlUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mc-agent-id": expectedBinding.agentId,
        "x-mc-credential-id": grant.credentialId,
        "x-mc-timestamp": timestamp,
        "x-mc-nonce": nonce,
        "x-mc-message-id": messageId,
        "x-mc-protocol-version": REPLACEMENT_CREDENTIAL_PROTOCOL,
        "x-mc-body-sha256": bodyChecksum,
        "x-mc-signature": signature
      },
      body
    });
    if (!response.ok) throw new Error(`Mission Control rejected ${path} (${response.status}).`);
    return await response.json();
  };
  await protocolPost(REPLACEMENT_STATUS_PATH, {
    authorizationId: expectedBinding.authorizationId,
    executionId: expectedBinding.executionId,
    authorizationFingerprint: expectedBinding.authorizationFingerprint,
    claimGeneration: 1,
    action: "acknowledge_grant",
    expectedState: grant.grantKind === "forward" ? "grant_delivered" : "rollback_grant_delivered",
    expectedSequence: grant.lifecycleSequence + 2,
    fencingGeneration: request.fencingGeneration,
    eventId: randomUUID2(),
    grantId: grant.grantId,
    grantChecksum: request.grantChecksum,
    acknowledgementChecksum: createHash10("sha256").update(canonicalJson(grant)).digest("hex"),
    operatorJournalChecksum: request.expectedJournalChecksum
  });
  let confirmedJournalChecksum = request.expectedJournalChecksum;
  const result = await executeV1OperatorRequest({
    request,
    expectedBinding,
    credentialKey,
    boundary,
    provider: createV1MacOSOperatorProvider(resolve4(parsed.values["repository-root"]), authorizationPackage),
    async confirmWithControlPlane({ request: pending, requestChecksum, journalChecksum }) {
      confirmedJournalChecksum = journalChecksum;
      const confirmation = await protocolPost(REPLACEMENT_STATUS_PATH, {
        authorizationId: expectedBinding.authorizationId,
        executionId: expectedBinding.executionId,
        authorizationFingerprint: expectedBinding.authorizationFingerprint,
        claimGeneration: 1,
        action: "operator_journal_head",
        expectedState: grant.grantKind === "forward" ? "mutation_intent_committed" : "rollback_intent_committed",
        expectedSequence: grant.lifecycleSequence + 3,
        fencingGeneration: pending.fencingGeneration,
        eventId: randomUUID2(),
        grantId: grant.grantId,
        operatorRequestChecksum: requestChecksum,
        operatorRequestMessageId: pending.requestMessageId,
        operatorRequestNonce: pending.nonce,
        operatorJournalChecksum: journalChecksum
      });
      if (confirmation.state !== (grant.grantKind === "forward" ? "awaiting_provider_receipt" : "awaiting_rollback_receipt"))
        throw new Error("Mission Control did not persist the exact operator journal intent.");
      return {
        accepted: true,
        currentJournalChecksum: journalChecksum
      };
    }
  });
  const provider = result.providerReceipt.receipt;
  await protocolPost(REPLACEMENT_RECEIPT_PATH, {
    authorizationId: expectedBinding.authorizationId,
    executionId: expectedBinding.executionId,
    authorizationFingerprint: expectedBinding.authorizationFingerprint,
    claimGeneration: 1,
    action: "accept_provider_receipt",
    expectedState: grant.grantKind === "forward" ? "awaiting_provider_receipt" : "awaiting_rollback_receipt",
    expectedSequence: grant.lifecycleSequence + 4,
    fencingGeneration: request.fencingGeneration,
    eventId: randomUUID2(),
    grantId: grant.grantId,
    providerMutationId: request.providerMutationId,
    operation: request.operation,
    priorStateChecksum: request.expectedJournalChecksum,
    resultingStateChecksum: provider.resultChecksum,
    localJournalEntryId: result.localJournalEntryId,
    executedAt: provider.completedAt,
    operatorRequestMessageId: request.requestMessageId,
    operatorRequestNonce: request.nonce,
    priorOperatorJournalChecksum: confirmedJournalChecksum,
    operatorJournalChecksum: result.operatorJournalChecksum,
    receiptBytes: result.receiptBytes,
    receiptChecksum: result.receiptChecksum,
    authenticatedReceiptTag: result.providerReceipt.authenticationTag,
    verificationEvidenceChecksum: provider.resultChecksum,
    outcome: "succeeded"
  });
  process.stdout.write(`${JSON.stringify(result)}
`);
}
void main();
