import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  VerifyCommand,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";
import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from "@aws-sdk/client-sts";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  canonicalReleaseManifestV3,
  canonicalJson,
  parseCanonicalReleaseManifestJson,
  parseCanonicalReleaseManifestV3Json,
  publicKeyFingerprint,
  type KmsReleaseKeyProvenance,
  type ReleaseKeyRecord,
} from "./release-authority";

const SHA256 = /^[a-f0-9]{64}$/;
const KMS_KEY_ARN = /^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/([0-9a-f-]{36})$/;
const RELEASE_KEY_ID = /^mission-agent-release-\d{4}-\d{2}$/;

export type KmsCommandClient = {
  send(command: unknown): Promise<Record<string, unknown>>;
};

export type KmsSigningReceipt = {
  receiptVersion: "1";
  releaseVersion: string;
  sourceSha: string;
  artifactSha256: string;
  canonicalManifestSha256: string;
  releaseAuthorityKeyId: string;
  kmsKeyArn: string;
  publicKeyFingerprint: string;
  signingAlgorithm: "ED25519_SHA_512";
  awsRequestId: string;
  awsVerifyRequestId: string;
  signerPrincipalArn: string;
  signingTime: string;
  signatureSha256: string;
  independentVerification: {
    localEd25519: true;
    awsKms: true;
  };
  approvalReference: string;
};

export type KmsSignReleaseInput = {
  manifestPath: string;
  artifactPath: string;
  outputBundlePath: string;
  outputSignaturePath: string;
  outputReceiptPath: string;
  expectedArtifactSha256: string;
  expectedSourceCommit: string;
  expectedReleaseVersion: string;
  releaseAuthorityKeyId: string;
  kmsKeyArn: string;
  pendingKeyRecord: ReleaseKeyRecord;
  trustActivationEvidence: TrustActivationEvidence;
  expectedSignerRoleArn: string;
  approvalReference: string;
  humanConfirmation: string;
  allowHistoricalManifestV2?: boolean;
  signingTime?: Date;
};

export type TrustActivationEvidence = {
  evidenceVersion: "1";
  status: "active";
  releaseAuthorityKeyId: string;
  publicKeyFingerprint: string;
  kmsKeyArn: string;
  missionControlReleaseSha: string;
  activatedAt: string;
  approvalReference: string;
};

export type KmsSignReleaseDependencies = {
  kms: KmsCommandClient;
  sts: KmsCommandClient;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`AWS response lacks ${field}`);
  return value;
}

function requiredBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(`AWS response lacks ${field}`);
  return value;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseKmsKeyArn(keyArn: string): { region: string; accountId: string; keyId: string } {
  const match = KMS_KEY_ARN.exec(keyArn);
  if (!match) throw new Error("KMS key ARN must identify one concrete AWS KMS key");
  return { region: match[1], accountId: match[2], keyId: match[3] };
}

export function pendingKmsReleaseKeyRecord(input: {
  releaseAuthorityKeyId: string;
  kmsKeyArn: string;
  publicKeySpkiDer: Uint8Array;
  createdAt: string;
}): ReleaseKeyRecord {
  if (!RELEASE_KEY_ID.test(input.releaseAuthorityKeyId)) throw new Error("invalid Release Authority key ID");
  const { region, accountId, keyId } = parseKmsKeyArn(input.kmsKeyArn);
  const publicKey = createPublicKey({ key: Buffer.from(input.publicKeySpkiDer), format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("KMS public key is not Ed25519");
  const publicKeySpkiBase64 = Buffer.from(input.publicKeySpkiDer).toString("base64");
  const kms: KmsReleaseKeyProvenance = {
    provider: "aws-kms",
    accountId,
    region,
    keyArn: input.kmsKeyArn,
    keyId,
    keySpec: "ECC_NIST_EDWARDS25519",
    keyUsage: "SIGN_VERIFY",
    signingAlgorithm: "ED25519_SHA_512",
    origin: "AWS_KMS",
    keyManager: "CUSTOMER",
    multiRegion: false,
  };
  return {
    keyId: input.releaseAuthorityKeyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64,
    publicKeyFingerprint: publicKeyFingerprint(publicKeySpkiBase64),
    status: "pending",
    purpose: "mission-agent-release",
    createdAt: input.createdAt,
    activatedAt: null,
    retiresAt: null,
    revokedAt: null,
    replacedBy: null,
    historicalVersions: [],
    kms,
  };
}

export function humanSigningConfirmation(input: {
  releaseVersion: string;
  artifactSha256: string;
  releaseAuthorityKeyId: string;
}): string {
  return `SIGN ${input.releaseVersion} ${input.artifactSha256} WITH ${input.releaseAuthorityKeyId}`;
}

export function validateSignerPrincipal(input: {
  callerArn: string;
  expectedRoleArn: string;
  expectedAccountId: string;
}): void {
  const roleMatch = /^arn:aws:iam::(\d{12}):role\/(.+)$/.exec(input.expectedRoleArn);
  if (!roleMatch || roleMatch[1] !== input.expectedAccountId)
    throw new Error("Expected signer role ARN is invalid for the KMS account");
  const roleName = roleMatch[2].split("/").at(-1);
  const callerMatch = /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(input.callerArn);
  if (!callerMatch || callerMatch[1] !== input.expectedAccountId || callerMatch[2] !== roleName)
    throw new Error("AWS caller is not the approved human release-signer role");
}

export function validateTrustActivationEvidence(
  evidence: TrustActivationEvidence,
  pendingRecord: ReleaseKeyRecord,
): void {
  if (
    evidence.evidenceVersion !== "1" ||
    evidence.status !== "active" ||
    evidence.releaseAuthorityKeyId !== pendingRecord.keyId ||
    evidence.publicKeyFingerprint !== pendingRecord.publicKeyFingerprint ||
    evidence.kmsKeyArn !== pendingRecord.kms?.keyArn ||
    !/^[a-f0-9]{40}$/.test(evidence.missionControlReleaseSha) ||
    !evidence.approvalReference.trim() ||
    Number.isNaN(Date.parse(evidence.activatedAt)) ||
    new Date(evidence.activatedAt).toISOString() !== evidence.activatedAt
  )
    throw new Error("Trust-activation evidence is incomplete or does not match the pending key");
}

export async function signReleaseWithKms(
  input: KmsSignReleaseInput,
  dependencies: KmsSignReleaseDependencies,
): Promise<KmsSigningReceipt> {
  if (process.env.APP_ENV === "production" || process.env.CI)
    throw new Error("Human-authorized KMS signing is disabled in production and CI");
  if (!SHA256.test(input.expectedArtifactSha256)) throw new Error("Expected artifact checksum is malformed");
  if (!/^[a-f0-9]{40}$/.test(input.expectedSourceCommit)) throw new Error("Expected source commit is malformed");
  if (!/^\d+\.\d+\.\d+$/.test(input.expectedReleaseVersion)) throw new Error("Expected release version is malformed");
  if (!input.approvalReference.trim()) throw new Error("Approval reference is required");
  validateTrustActivationEvidence(input.trustActivationEvidence, input.pendingKeyRecord);

  const manifestText = await readFile(resolve(input.manifestPath), "utf8");
  const parsedVersion = (JSON.parse(manifestText) as { manifestVersion?: unknown }).manifestVersion;
  const manifest =
    parsedVersion === "3"
      ? parseCanonicalReleaseManifestV3Json(manifestText)
      : input.allowHistoricalManifestV2 === true
        ? parseCanonicalReleaseManifestJson(manifestText)
        : (() => {
            throw new Error("New production KMS signing requires Manifest v3");
          })();
  const isV3 = manifest.manifestVersion === "3";
  const canonicalManifest = isV3 ? canonicalReleaseManifestV3(manifest) : canonicalJson(manifest);
  const artifactSha256 = manifest.artifactSha256;
  const sourceCommit = isV3 ? manifest.build.sourceCommit : manifest.sourceCommit;
  const releaseVersion = isV3 ? manifest.releaseVersion : manifest.agentVersion;
  const artifactName = isV3 ? manifest.artifactName : manifest.artifactPath.slice(1);
  if (artifactSha256 !== input.expectedArtifactSha256)
    throw new Error("Explicit artifact-checksum confirmation failed");
  if (sourceCommit !== input.expectedSourceCommit) throw new Error("Source-commit confirmation failed");
  if (releaseVersion !== input.expectedReleaseVersion) throw new Error("Release-version confirmation failed");
  if (manifest.signingKeyId !== input.releaseAuthorityKeyId)
    throw new Error("Release Authority key-ID confirmation failed");
  const expectedConfirmation = humanSigningConfirmation({
    releaseVersion,
    artifactSha256,
    releaseAuthorityKeyId: manifest.signingKeyId,
  });
  if (input.humanConfirmation !== expectedConfirmation) throw new Error("Explicit human confirmation failed");

  const artifactBytes = Uint8Array.from(await readFile(resolve(input.artifactPath)));
  if (sha256(artifactBytes) !== artifactSha256) throw new Error("Artifact bytes do not match manifest checksum");
  if (isV3 && artifactBytes.byteLength !== manifest.artifactByteLength)
    throw new Error("Artifact bytes do not match manifest byte length");
  if (basename(input.artifactPath) !== artifactName) throw new Error("Artifact filename does not match manifest path");

  const arn = parseKmsKeyArn(input.kmsKeyArn);
  const described = await dependencies.kms.send(new DescribeKeyCommand({ KeyId: input.kmsKeyArn }));
  const metadata = described.KeyMetadata as Record<string, unknown> | undefined;
  if (!metadata) throw new Error("AWS response lacks KMS key metadata");
  if (metadata.Arn !== input.kmsKeyArn || metadata.KeyId !== arn.keyId) throw new Error("KMS key identity mismatch");
  if (metadata.KeySpec !== "ECC_NIST_EDWARDS25519") throw new Error("KMS key spec must be ECC_NIST_EDWARDS25519");
  if (metadata.KeyUsage !== "SIGN_VERIFY") throw new Error("KMS key usage must be SIGN_VERIFY");
  if (metadata.Enabled !== true) throw new Error("KMS release key is not enabled");
  if (metadata.KeyState !== "Enabled") throw new Error("KMS release key state must be Enabled");
  if (metadata.Origin !== "AWS_KMS") throw new Error("KMS key material must be generated by AWS KMS");
  if (metadata.KeyManager !== "CUSTOMER") throw new Error("KMS release key must be customer managed");
  if (metadata.MultiRegion !== false) throw new Error("KMS release key must be single-region");

  const publicResponse = await dependencies.kms.send(new GetPublicKeyCommand({ KeyId: input.kmsKeyArn }));
  if (publicResponse.KeySpec !== "ECC_NIST_EDWARDS25519") throw new Error("KMS public-key spec mismatch");
  if (publicResponse.KeyUsage !== "SIGN_VERIFY") throw new Error("KMS public-key usage mismatch");
  const algorithms = publicResponse.SigningAlgorithms;
  if (!Array.isArray(algorithms) || !algorithms.includes("ED25519_SHA_512"))
    throw new Error("KMS key does not support ED25519_SHA_512");
  const publicKeySpkiDer = requiredBytes(publicResponse.PublicKey, "DER public key");
  const pendingRecord = pendingKmsReleaseKeyRecord({
    releaseAuthorityKeyId: input.releaseAuthorityKeyId,
    kmsKeyArn: input.kmsKeyArn,
    publicKeySpkiDer,
    createdAt: input.pendingKeyRecord.createdAt,
  });
  if (
    pendingRecord.publicKeyFingerprint !== input.pendingKeyRecord.publicKeyFingerprint ||
    pendingRecord.publicKeySpkiBase64 !== input.pendingKeyRecord.publicKeySpkiBase64 ||
    canonicalJson(pendingRecord.kms) !== canonicalJson(input.pendingKeyRecord.kms) ||
    input.pendingKeyRecord.status !== "pending"
  )
    throw new Error("KMS public key does not match the pending trust record");
  if (isV3 && pendingRecord.publicKeyFingerprint !== manifest.publicKeyFingerprint)
    throw new Error("KMS public key does not match the signed manifest fingerprint");

  const caller = await dependencies.sts.send(new GetCallerIdentityCommand({}));
  const signerPrincipalArn = requiredString(caller.Arn, "signer principal ARN");
  validateSignerPrincipal({
    callerArn: signerPrincipalArn,
    expectedRoleArn: input.expectedSignerRoleArn,
    expectedAccountId: arn.accountId,
  });
  const message = Uint8Array.from(Buffer.from(canonicalManifest, "utf8"));
  const signed = await dependencies.kms.send(
    new SignCommand({
      KeyId: input.kmsKeyArn,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    }),
  );
  const signature = requiredBytes(signed.Signature, "signature");
  if (signature.byteLength !== 64) throw new Error("KMS signature is not raw Ed25519 format");
  const requestId = requiredString(
    (signed.$metadata as Record<string, unknown> | undefined)?.requestId,
    "KMS request ID",
  );

  const publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiDer), format: "der", type: "spki" });
  if (!verify(null, message, publicKey, signature)) throw new Error("Independent local Ed25519 verification failed");
  const kmsVerification = await dependencies.kms.send(
    new VerifyCommand({
      KeyId: input.kmsKeyArn,
      Message: message,
      MessageType: "RAW",
      Signature: signature,
      SigningAlgorithm: "ED25519_SHA_512",
    }),
  );
  if (kmsVerification.SignatureValid !== true) throw new Error("Independent AWS KMS verification failed");
  const verifyRequestId = requiredString(
    (kmsVerification.$metadata as Record<string, unknown> | undefined)?.requestId,
    "KMS verify request ID",
  );
  const signatureBase64 = Buffer.from(signature).toString("base64");
  const receipt: KmsSigningReceipt = {
    receiptVersion: "1",
    releaseVersion,
    sourceSha: sourceCommit,
    artifactSha256,
    canonicalManifestSha256: sha256(canonicalManifest),
    releaseAuthorityKeyId: manifest.signingKeyId,
    kmsKeyArn: input.kmsKeyArn,
    publicKeyFingerprint: pendingRecord.publicKeyFingerprint,
    signingAlgorithm: "ED25519_SHA_512",
    awsRequestId: requestId,
    awsVerifyRequestId: verifyRequestId,
    signerPrincipalArn,
    signingTime: (input.signingTime ?? new Date()).toISOString(),
    signatureSha256: sha256(signature),
    independentVerification: { localEd25519: true, awsKms: true },
    approvalReference: input.approvalReference,
  };

  // The authoritative signed bundle is deliberately written last. An
  // interrupted write can leave non-authoritative evidence, never a bundle
  // that appears complete while its receipt is absent.
  await writeFile(resolve(input.outputReceiptPath), `${canonicalJson(receipt)}\n`, { flag: "wx", mode: 0o644 });
  await writeFile(resolve(input.outputSignaturePath), `${signatureBase64}\n`, { flag: "wx", mode: 0o644 });
  await writeFile(resolve(input.outputBundlePath), canonicalJson({ ...manifest, signature: signatureBase64 }), {
    flag: "wx",
    mode: 0o644,
  });
  return receipt;
}

export function awsKmsSigningClients(input: {
  region: string;
  kmsConfig?: Omit<KMSClientConfig, "region">;
  stsConfig?: Omit<STSClientConfig, "region">;
}): KmsSignReleaseDependencies {
  return {
    kms: new KMSClient({ ...input.kmsConfig, region: input.region }),
    sts: new STSClient({ ...input.stsConfig, region: input.region }),
  };
}
