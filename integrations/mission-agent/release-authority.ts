import { createHash, createPublicKey, verify } from "node:crypto";

export const RELEASE_AUTHORITY_VERSION = "2" as const;
export const RELEASE_MANIFEST_VERSION = "2" as const;

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
