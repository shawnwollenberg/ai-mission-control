import { createHash, createPublicKey, verify } from "node:crypto";

export const RELEASE_AUTHORITY_VERSION = "2" as const;
export const RELEASE_MANIFEST_VERSION = "2" as const;
export const RELEASE_MANIFEST_V3_VERSION = "3" as const;
export const RELEASE_CANONICALIZATION_V3 = "release-manifest-json-v3" as const;

export type ReleaseKeyStatus = "pending" | "active" | "retiring" | "retired" | "revoked";

export type KmsReleaseKeyProvenance = {
  provider: "aws-kms";
  accountId: string;
  region: string;
  keyArn: string;
  keyId: string;
  keySpec: "ECC_NIST_EDWARDS25519";
  keyUsage: "SIGN_VERIFY";
  signingAlgorithm: "ED25519_SHA_512";
  origin: "AWS_KMS";
  keyManager: "CUSTOMER";
  multiRegion: false;
};

export type ReleaseKeyRecord = {
  keyId: string;
  algorithm: "Ed25519";
  publicKeySpkiBase64: string;
  publicKeyFingerprint: `ed25519-spki-sha256:${string}`;
  status: ReleaseKeyStatus;
  purpose: "mission-agent-release";
  createdAt: string;
  activatedAt: string | null;
  retiresAt: string | null;
  revokedAt: string | null;
  replacedBy: string | null;
  historicalVersions: readonly string[];
  kms: KmsReleaseKeyProvenance | null;
};

export type ReleaseManifestV2 = {
  activationProtocolVersion: string;
  agentVersion: string;
  artifactPath: string;
  artifactSha256: string;
  buildId: string;
  createdAt: string;
  expiresAt: string;
  identityProtocolVersion: string;
  manifestVersion: "2";
  minimumMissionControlVersion: string;
  signingKeyId: string;
  sourceCommit: string;
};

export type SignedReleaseManifestV2 = ReleaseManifestV2 & { signature: string };

export type ReleaseManifestPlatformV3 = {
  architecture: "universal";
  artifactFormat: "esm";
  operatingSystem: "darwin-linux";
  runtime: "node";
  runtimeMajorVersion: 22;
};

export type ReleaseManifestCompatibilityV3 = {
  activationProtocolVersion: "1";
  identityProtocolVersion: "2";
  minimumMissionControlVersion: string;
};

export type ReleaseManifestBuildV3 = {
  buildId: string;
  sourceCommit: string;
};

export type ReleaseManifestProvenanceV3 = {
  builderSha256: string;
  containerImageDigest: string;
  manifestSchemaSha256: string;
  nodeVersion: "22.22.0";
  packageLockSha256: string;
  reproducibilityEvidenceSha256: string;
};

export type ReleaseManifestV3 = {
  artifactByteLength: number;
  artifactName: string;
  artifactSha256: string;
  build: ReleaseManifestBuildV3;
  canonicalizationVersion: "release-manifest-json-v3";
  compatibility: ReleaseManifestCompatibilityV3;
  createdAt: string;
  expiresAt: string;
  manifestVersion: "3";
  platform: ReleaseManifestPlatformV3;
  provenance: ReleaseManifestProvenanceV3;
  publicKeyFingerprint: `ed25519-spki-sha256:${string}`;
  releaseAuthorityVersion: "v2";
  releaseVersion: string;
  signingKeyId: string;
};

export type SignedReleaseManifestV3 = ReleaseManifestV3 & { signature: string };

const KEY_ID = /^mission-agent-release-\d{4}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[a-f0-9]{40}$/;
const V2_FIELDS = [
  "activationProtocolVersion",
  "agentVersion",
  "artifactPath",
  "artifactSha256",
  "buildId",
  "createdAt",
  "expiresAt",
  "identityProtocolVersion",
  "manifestVersion",
  "minimumMissionControlVersion",
  "signingKeyId",
  "sourceCommit",
] as const;
const V3_FIELDS = [
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
  "signingKeyId",
] as const;
const V3_BUILD_FIELDS = ["buildId", "sourceCommit"] as const;
const V3_COMPATIBILITY_FIELDS = [
  "activationProtocolVersion",
  "identityProtocolVersion",
  "minimumMissionControlVersion",
] as const;
const V3_PLATFORM_FIELDS = [
  "architecture",
  "artifactFormat",
  "operatingSystem",
  "runtime",
  "runtimeMajorVersion",
] as const;
const V3_PROVENANCE_FIELDS = [
  "builderSha256",
  "containerImageDigest",
  "manifestSchemaSha256",
  "nodeVersion",
  "packageLockSha256",
  "reproducibilityEvidenceSha256",
] as const;
const SUPPORTED_IDENTITY_PROTOCOLS = new Set(["2"]);
const SUPPORTED_ACTIVATION_PROTOCOLS = new Set(["1"]);

export const trustedReleaseKeys: Readonly<Record<string, ReleaseKeyRecord>> = {
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
    kms: null,
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
      multiRegion: false,
    },
  },
  // RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT
};

export function validatePendingReleaseKey(record: ReleaseKeyRecord): ReleaseKeyRecord {
  if (
    record.keyId !== "mission-agent-release-2026-01" ||
    record.status !== "pending" ||
    record.activatedAt !== null ||
    record.retiresAt !== null ||
    record.revokedAt !== null ||
    record.replacedBy !== null ||
    record.historicalVersions.length !== 0 ||
    record.kms?.provider !== "aws-kms" ||
    record.kms.keySpec !== "ECC_NIST_EDWARDS25519" ||
    record.kms.keyUsage !== "SIGN_VERIFY" ||
    record.kms.signingAlgorithm !== "ED25519_SHA_512"
  )
    throw new Error("pending replacement release key record is incomplete");
  validateTrustStore({ [record.keyId]: record });
  return record;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertExactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(record).sort().join("\n") !== [...fields].sort().join("\n"))
    throw new Error(`${label} fields must exactly match the schema`);
}

function assertCanonicalUnicode(value: unknown): void {
  if (typeof value === "string" && value.normalize("NFC") !== value)
    throw new Error("manifest strings must use Unicode NFC");
  if (Array.isArray(value)) {
    for (const item of value) assertCanonicalUnicode(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.normalize("NFC") !== key) throw new Error("manifest keys must use Unicode NFC");
      assertCanonicalUnicode(item);
    }
  }
}

function assertNoDuplicateJsonKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
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
        const key = JSON.parse(literal) as string;
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
      stack.push(new Set());
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

function requireIsoDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new Error(`${field} must be a canonical ISO-8601 timestamp`);
}

export function parseReleaseManifestV2(value: unknown): ReleaseManifestV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest must be an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\n") !== [...V2_FIELDS].sort().join("\n"))
    throw new Error("manifest fields must exactly match the Release Authority v2 schema");
  for (const field of V2_FIELDS)
    if (typeof record[field] !== "string" || record[field] === "") throw new Error(`${field} is required`);
  const manifest = record as ReleaseManifestV2;
  if (manifest.manifestVersion !== RELEASE_MANIFEST_VERSION) throw new Error("unsupported manifest version");
  if (!SEMVER.test(manifest.agentVersion) || !SEMVER.test(manifest.minimumMissionControlVersion))
    throw new Error("agent and Mission Control versions must be canonical semver");
  if (manifest.artifactPath !== `/mission-agent-${manifest.agentVersion}.mjs`)
    throw new Error("artifact path does not match agent version");
  if (!SHA256.test(manifest.artifactSha256)) throw new Error("artifact checksum must be lowercase SHA-256");
  if (!COMMIT.test(manifest.sourceCommit)) throw new Error("source commit must be a full lowercase Git SHA");
  if (!KEY_ID.test(manifest.signingKeyId)) throw new Error("invalid signing key ID");
  if (!SUPPORTED_IDENTITY_PROTOCOLS.has(manifest.identityProtocolVersion))
    throw new Error("unsupported identity protocol version");
  if (!SUPPORTED_ACTIVATION_PROTOCOLS.has(manifest.activationProtocolVersion))
    throw new Error("unsupported activation protocol version");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.buildId)) throw new Error("invalid build ID");
  requireIsoDate(manifest.createdAt, "createdAt");
  requireIsoDate(manifest.expiresAt, "expiresAt");
  if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt))
    throw new Error("manifest must expire after creation");
  return manifest;
}

export function parseReleaseManifestV3(value: unknown): ReleaseManifestV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest v3 must be an object");
  const record = value as Record<string, unknown>;
  assertExactFields(record, V3_FIELDS, "manifest v3");
  if (
    !record.build ||
    typeof record.build !== "object" ||
    Array.isArray(record.build) ||
    !record.compatibility ||
    typeof record.compatibility !== "object" ||
    Array.isArray(record.compatibility) ||
    !record.platform ||
    typeof record.platform !== "object" ||
    Array.isArray(record.platform) ||
    !record.provenance ||
    typeof record.provenance !== "object" ||
    Array.isArray(record.provenance)
  )
    throw new Error("manifest v3 nested metadata is required");
  assertExactFields(record.build as Record<string, unknown>, V3_BUILD_FIELDS, "manifest v3 build");
  assertExactFields(
    record.compatibility as Record<string, unknown>,
    V3_COMPATIBILITY_FIELDS,
    "manifest v3 compatibility",
  );
  assertExactFields(record.platform as Record<string, unknown>, V3_PLATFORM_FIELDS, "manifest v3 platform");
  assertExactFields(record.provenance as Record<string, unknown>, V3_PROVENANCE_FIELDS, "manifest v3 provenance");
  const manifest = record as ReleaseManifestV3;
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
  if (
    manifest.platform.runtime !== "node" ||
    manifest.platform.runtimeMajorVersion !== 22 ||
    manifest.platform.operatingSystem !== "darwin-linux" ||
    manifest.platform.architecture !== "universal" ||
    manifest.platform.artifactFormat !== "esm"
  )
    throw new Error("unsupported Mission Agent platform");
  if (
    !SHA256.test(manifest.provenance.builderSha256) ||
    !SHA256.test(manifest.provenance.manifestSchemaSha256) ||
    !SHA256.test(manifest.provenance.packageLockSha256) ||
    !SHA256.test(manifest.provenance.reproducibilityEvidenceSha256) ||
    manifest.provenance.nodeVersion !== "22.22.0" ||
    !/^node@sha256:[a-f0-9]{64}$/.test(manifest.provenance.containerImageDigest)
  )
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

export function canonicalReleaseManifestV3(value: unknown): string {
  return canonicalJson(parseReleaseManifestV3(value));
}

export function parseCanonicalReleaseManifestV3Json(text: string): ReleaseManifestV3 {
  if (text.endsWith("\n") || text.endsWith("\r")) throw new Error("manifest v3 must not have a trailing newline");
  assertNoDuplicateJsonKeys(text);
  const parsed = JSON.parse(text);
  const manifest = parseReleaseManifestV3(parsed);
  if (text !== canonicalJson(manifest)) throw new Error("manifest v3 bytes are not canonical");
  return manifest;
}

export function parseCanonicalSignedReleaseManifestV3Json(text: string): SignedReleaseManifestV3 {
  const canonicalText = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  assertNoDuplicateJsonKeys(canonicalText);
  const parsed = JSON.parse(canonicalText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("signed manifest v3 must be an object");
  const { signature, ...unsigned } = parsed;
  if (typeof signature !== "string" || signature === "") throw new Error("manifest signature is required");
  const manifest = parseReleaseManifestV3(unsigned);
  const bundle = { ...manifest, signature };
  if (canonicalText !== canonicalJson(bundle)) throw new Error("signed manifest v3 bytes are not canonical");
  return bundle;
}

export function parseCanonicalReleaseManifestJson(text: string): ReleaseManifestV2 {
  const parsed = JSON.parse(text);
  const manifest = parseReleaseManifestV2(parsed);
  if (text.trim() !== canonicalJson(manifest)) throw new Error("manifest bytes are not canonical");
  return manifest;
}

export function parseCanonicalSignedReleaseManifestJson(text: string): SignedReleaseManifestV2 {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("signed manifest must be an object");
  const { signature, ...unsigned } = parsed as Record<string, unknown>;
  if (typeof signature !== "string" || signature === "") throw new Error("manifest signature is required");
  const manifest = parseReleaseManifestV2(unsigned);
  const bundle = { ...manifest, signature };
  if (text.trim() !== canonicalJson(bundle)) throw new Error("signed manifest bytes are not canonical");
  return bundle;
}

export function publicKeyFingerprint(spkiBase64: string): `ed25519-spki-sha256:${string}` {
  return `ed25519-spki-sha256:${createHash("sha256")
    .update(Uint8Array.from(Buffer.from(spkiBase64, "base64")))
    .digest("hex")}`;
}

export function validateTrustStore(keys: Readonly<Record<string, ReleaseKeyRecord>> = trustedReleaseKeys): void {
  const fingerprints = new Set<string>();
  for (const [id, key] of Object.entries(keys)) {
    if (id !== key.keyId || !KEY_ID.test(id)) throw new Error(`invalid release key ID: ${id}`);
    if (key.algorithm !== "Ed25519" || key.purpose !== "mission-agent-release")
      throw new Error(`invalid release key purpose: ${id}`);
    if (
      key.kms &&
      (key.kms.provider !== "aws-kms" ||
        !/^\d{12}$/.test(key.kms.accountId) ||
        key.kms.region === "" ||
        key.kms.keyArn !== `arn:aws:kms:${key.kms.region}:${key.kms.accountId}:key/${key.kms.keyId}` ||
        key.kms.keySpec !== "ECC_NIST_EDWARDS25519" ||
        key.kms.keyUsage !== "SIGN_VERIFY" ||
        key.kms.signingAlgorithm !== "ED25519_SHA_512" ||
        key.kms.origin !== "AWS_KMS" ||
        key.kms.keyManager !== "CUSTOMER" ||
        key.kms.multiRegion !== false)
    )
      throw new Error(`invalid AWS KMS provenance: ${id}`);
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
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

export function verifyReleaseManifestV2(
  bundle: unknown,
  options: { now?: Date; keys?: Readonly<Record<string, ReleaseKeyRecord>> } = {},
): ReleaseManifestV2 {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    throw new Error("signed manifest must be an object");
  const { signature, ...unsigned } = bundle as Record<string, unknown>;
  if (typeof signature !== "string" || signature === "") throw new Error("manifest signature is required");
  const manifest = parseReleaseManifestV2(unsigned);
  const keys = options.keys ?? trustedReleaseKeys;
  validateTrustStore(keys);
  const key = keys[manifest.signingKeyId];
  if (!key) throw new Error("manifest signing key is unknown");
  if (key.status === "revoked") throw new Error("manifest signing key is revoked");
  if (key.status !== "active") throw new Error(`manifest signing key is ${key.status}`);
  if (key.activatedAt && Date.parse(key.activatedAt) > (options.now ?? new Date()).getTime())
    throw new Error("manifest signing key is not active yet");
  if (key.retiresAt && Date.parse(key.retiresAt) <= (options.now ?? new Date()).getTime())
    throw new Error("manifest signing key is retired");
  if (Date.parse(manifest.expiresAt) <= (options.now ?? new Date()).getTime()) throw new Error("manifest is expired");
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature)
    throw new Error("manifest signature must be canonical Ed25519 base64");
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Uint8Array.from(Buffer.from(canonicalJson(manifest))), publicKey, Uint8Array.from(signatureBytes)))
    throw new Error("manifest signature verification failed");
  return manifest;
}

export function verifyReleaseManifestV3(
  bundle: unknown,
  options: { now?: Date; keys?: Readonly<Record<string, ReleaseKeyRecord>> } = {},
): ReleaseManifestV3 {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    throw new Error("signed manifest v3 must be an object");
  const { signature, ...unsigned } = bundle as Record<string, unknown>;
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
  const now = options.now ?? new Date();
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
    type: "spki",
  });
  if (
    !verify(
      null,
      Uint8Array.from(Buffer.from(canonicalReleaseManifestV3(manifest), "utf8")),
      publicKey,
      Uint8Array.from(signatureBytes),
    )
  )
    throw new Error("manifest signature verification failed");
  return manifest;
}

export function verifyNewProductionReleaseManifest(
  bundle: unknown,
  options: { now?: Date; keys?: Readonly<Record<string, ReleaseKeyRecord>> } = {},
): ReleaseManifestV3 {
  if ((bundle as { manifestVersion?: unknown } | null)?.manifestVersion !== RELEASE_MANIFEST_V3_VERSION)
    throw new Error("new production releases require Manifest v3");
  return verifyReleaseManifestV3(bundle, options);
}

export function supportsManifestV3ProductionRelease(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const release = value as Record<string, unknown>;
  return (
    release.authorityVersion === "v2" &&
    release.manifestVersion === "3" &&
    release.canonicalizationVersion === RELEASE_CANONICALIZATION_V3 &&
    release.minimumProductionManifestVersion === "3" &&
    release.signingKeyId === "mission-agent-release-2026-01" &&
    release.publicKeyFingerprint ===
      "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b"
  );
}
