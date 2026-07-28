import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "./v1-production-runtime-identity";

export const V1_HOST_IDENTITY_PROTOCOL = "mission-agent-operator-host-identity-v1";
export const V1_HOST_PRIVATE_KEY_PATH =
  "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/host-identity.pk8";
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type V1HostStartupEvidence = {
  protocolVersion: typeof V1_HOST_IDENTITY_PROTOCOL;
  challengeId: string;
  challengeNonce: string;
  challengeExpiresAt: string;
  hostPublicKeySpki: string;
  hostFingerprint: string;
  operatorArtifactSha256: string;
  operatorProtocolVersion: string;
  macOSUserId: number;
  agentId: string;
  installationPath: string;
  launchAgentLabel: string;
  journalGeneration: number;
  observedAt: string;
};

export type SignedV1HostStartupEvidence = V1HostStartupEvidence & {
  signature: string;
};

export function v1HostFingerprint(publicKeySpki: Uint8Array): string {
  return `ed25519-spki-sha256:${createHash("sha256").update(publicKeySpki).digest("hex")}`;
}

export async function createV1HostIdentityKey(path = V1_HOST_PRIVATE_KEY_PATH): Promise<{
  publicKeySpki: string;
  fingerprint: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateBytes = privateKey.export({ type: "pkcs8", format: "der" }) as Uint8Array<ArrayBuffer>;
  const publicBytes = publicKey.export({ type: "spki", format: "der" }) as Uint8Array<ArrayBuffer>;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(Uint8Array.from(privateBytes));
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o600);
  return {
    publicKeySpki: Buffer.from(publicBytes).toString("base64"),
    fingerprint: v1HostFingerprint(Uint8Array.from(publicBytes)),
  };
}

function unsignedEvidence(evidence: SignedV1HostStartupEvidence): V1HostStartupEvidence {
  const unsigned = { ...evidence };
  delete (unsigned as Partial<SignedV1HostStartupEvidence>).signature;
  return unsigned;
}

export async function signV1HostStartupEvidence(
  evidence: V1HostStartupEvidence,
  privateKeyPath = V1_HOST_PRIVATE_KEY_PATH,
): Promise<SignedV1HostStartupEvidence> {
  const privateKey = createPrivateKey({
    key: await readFile(privateKeyPath),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("V1 host identity key is not Ed25519.");
  return {
    ...evidence,
    signature: sign(null, new TextEncoder().encode(canonicalJson(evidence)), privateKey).toString("base64"),
  };
}

export function verifyV1HostStartupEvidence(input: {
  evidence: SignedV1HostStartupEvidence;
  expectedChallengeId: string;
  expectedChallengeNonce: string;
  expectedHostFingerprint: string;
  expectedAgentId: string;
  expectedOperatorArtifactSha256: string;
  expectedOperatorProtocolVersion: string;
  expectedInstallationPath: string;
  expectedLaunchAgentLabel: string;
  expectedUserId: number;
  minimumJournalGeneration: number;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  const evidence = input.evidence;
  const publicBytes = Buffer.from(evidence.hostPublicKeySpki, "base64");
  const publicKey = createPublicKey({ key: publicBytes, format: "der", type: "spki" });
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.challengeExpiresAt);
  if (
    evidence.protocolVersion !== V1_HOST_IDENTITY_PROTOCOL ||
    !UUID.test(evidence.challengeId) ||
    evidence.challengeId !== input.expectedChallengeId ||
    evidence.challengeNonce !== input.expectedChallengeNonce ||
    evidence.hostFingerprint !== input.expectedHostFingerprint ||
    evidence.hostFingerprint !== v1HostFingerprint(Uint8Array.from(publicBytes)) ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    evidence.agentId !== input.expectedAgentId ||
    evidence.operatorArtifactSha256 !== input.expectedOperatorArtifactSha256 ||
    evidence.operatorProtocolVersion !== input.expectedOperatorProtocolVersion ||
    evidence.installationPath !== input.expectedInstallationPath ||
    evidence.launchAgentLabel !== input.expectedLaunchAgentLabel ||
    evidence.macOSUserId !== input.expectedUserId ||
    evidence.macOSUserId <= 0 ||
    evidence.journalGeneration < input.minimumJournalGeneration ||
    !SHA256.test(evidence.operatorArtifactSha256) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > now.getTime() + 60_000 ||
    now.getTime() - observedAt > 5 * 60_000 ||
    expiresAt <= now.getTime() ||
    expiresAt - observedAt > 5 * 60_000 ||
    !verify(
      null,
      new TextEncoder().encode(canonicalJson(unsignedEvidence(evidence))),
      publicKey,
      Uint8Array.from(Buffer.from(evidence.signature, "base64")),
    )
  )
    throw new Error("V1 operator host startup evidence is stale, malformed, or unauthenticated.");
}

export async function signV1HostBoundPayload(
  payload: Record<string, unknown>,
  privateKeyPath = V1_HOST_PRIVATE_KEY_PATH,
): Promise<string> {
  const privateKey = createPrivateKey({ key: await readFile(privateKeyPath), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("V1 host identity key is not Ed25519.");
  return sign(null, new TextEncoder().encode(canonicalJson(payload)), privateKey).toString("base64");
}

export function verifyV1HostBoundPayload(input: {
  payload: Record<string, unknown>;
  signature: string;
  publicKeySpki: string;
}): void {
  const key = createPublicKey({ key: Buffer.from(input.publicKeySpki, "base64"), format: "der", type: "spki" });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      new TextEncoder().encode(canonicalJson(input.payload)),
      key,
      Uint8Array.from(Buffer.from(input.signature, "base64")),
    )
  )
    throw new Error("V1 host-bound payload signature is invalid.");
}
