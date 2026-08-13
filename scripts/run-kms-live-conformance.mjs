import {
  DescribeKeyCommand,
  KMSClient,
  ListResourceTagsCommand,
  SignCommand,
  VerifyCommand,
} from "@aws-sdk/client-kms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalJson,
  parseCanonicalSignedReleaseManifestJson,
  publicKeyFingerprint,
  verifyReleaseManifestV2 as verifyMissionControl,
} from "../integrations/mission-agent/release-authority";
import {
  verifyReleaseManifestText as verifyMissionAgentText,
  verifyReleaseManifestV2 as verifyMissionAgent,
} from "../public/mission-agent-0.7.0.mjs";

async function main() {
  const keyArn = process.env.KMS_CONFORMANCE_KEY_ARN ?? "";
  const expectedCallerArn = process.env.KMS_CONFORMANCE_CALLER_ARN ?? "";
  const publicKeyPath = process.env.KMS_CONFORMANCE_PUBLIC_KEY_PATH ?? "";
  const outputPath = process.env.KMS_CONFORMANCE_REPORT_PATH ?? "";
  if (
    !/^arn:aws:kms:us-east-1:661452835066:key\/[0-9a-f-]{36}$/.test(keyArn) ||
    !/^arn:aws:sts::661452835066:assumed-role\/AWSReservedSSO_MissionAgentReleaseConformance_[0-9a-f]+\/[^/]+$/.test(
      expectedCallerArn,
    ) ||
    !publicKeyPath ||
    !outputPath
  )
    throw new Error("Exact conformance key ARN, caller ARN, DER public-key path, and report path are required");

  const keyId = "mission-agent-release-2099-99";
  const publicKeyDer = await readFile(publicKeyPath);
  const publicKeySpkiBase64 = publicKeyDer.toString("base64");
  const fingerprint = publicKeyFingerprint(publicKeySpkiBase64);
  const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("KMS public key is not Ed25519");

  const manifest = {
    activationProtocolVersion: "1",
    agentVersion: "99.0.0",
    artifactPath: "/mission-agent-99.0.0.mjs",
    artifactSha256: createHash("sha256").update("disposable-release-authority-conformance-artifact-v1").digest("hex"),
    buildId: "release-authority-conformance-2026-07",
    createdAt: "2026-07-26T20:20:00.000Z",
    expiresAt: "2026-08-25T20:20:00.000Z",
    identityProtocolVersion: "2",
    manifestVersion: "2",
    minimumMissionControlVersion: "0.1.0",
    signingKeyId: keyId,
    sourceCommit: "c".repeat(40),
  };
  const canonicalManifest = canonicalJson(manifest);
  const message = Buffer.from(canonicalManifest, "utf8");
  const kms = new KMSClient({ region: "us-east-1" });
  const caller = await new STSClient({ region: "us-east-1" }).send(new GetCallerIdentityCommand({}));
  if (caller.Account !== "661452835066" || caller.Arn !== expectedCallerArn)
    throw new Error("Live conformance caller is not the approved temporary Identity Center role");
  const [keyDescription, keyTags] = await Promise.all([
    kms.send(new DescribeKeyCommand({ KeyId: keyArn })),
    kms.send(new ListResourceTagsCommand({ KeyId: keyArn })),
  ]);
  const metadata = keyDescription.KeyMetadata;
  const tags = Object.fromEntries((keyTags.Tags ?? []).map(({ TagKey, TagValue }) => [TagKey, TagValue]));
  if (
    metadata?.Arn !== keyArn ||
    metadata.KeySpec !== "ECC_NIST_EDWARDS25519" ||
    metadata.KeyUsage !== "SIGN_VERIFY" ||
    metadata.Origin !== "AWS_KMS" ||
    metadata.KeyManager !== "CUSTOMER" ||
    metadata.MultiRegion !== false ||
    metadata.Enabled !== true ||
    tags.environment !== "disposable" ||
    tags.purpose !== "release-authority-conformance" ||
    tags["cleanup-intent"] !== "schedule-deletion-7-days"
  )
    throw new Error("KMS key is not the exact enabled disposable conformance signing key");
  const signed = await kms.send(
    new SignCommand({
      KeyId: keyArn,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    }),
  );
  if (!signed.Signature || signed.Signature.byteLength !== 64 || !signed.$metadata.requestId)
    throw new Error("KMS did not return a canonical raw Ed25519 signature and request ID");
  const signature = Buffer.from(signed.Signature);
  const signatureBase64 = signature.toString("base64");
  const bundle = { ...manifest, signature: signatureBase64 };
  const canonicalBundle = canonicalJson(bundle);

  const trustRecord = {
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64,
    publicKeyFingerprint: fingerprint,
    status: "active",
    purpose: "mission-agent-release",
    createdAt: "2026-07-26T20:20:00.000Z",
    activatedAt: "2026-07-26T20:20:01.000Z",
    retiresAt: null,
    revokedAt: null,
    replacedBy: null,
    historicalVersions: [],
    kms: {
      provider: "aws-kms",
      accountId: "661452835066",
      region: "us-east-1",
      keyArn,
      keyId: keyArn.split("/").at(-1) ?? "",
      keySpec: "ECC_NIST_EDWARDS25519",
      keyUsage: "SIGN_VERIFY",
      signingAlgorithm: "ED25519_SHA_512",
      origin: "AWS_KMS",
      keyManager: "CUSTOMER",
      multiRegion: false,
    },
  };
  const keys = { [keyId]: trustRecord };
  const now = new Date("2026-07-27T00:00:00.000Z");

  const kmsVerified = await kms.send(
    new VerifyCommand({
      KeyId: keyArn,
      Message: message,
      MessageType: "RAW",
      Signature: signature,
      SigningAlgorithm: "ED25519_SHA_512",
    }),
  );
  const localVerified = verify(null, message, publicKey, signature);
  const missionControlVerified =
    verifyMissionControl(parseCanonicalSignedReleaseManifestJson(canonicalBundle), { keys, now }).agentVersion ===
    "99.0.0";
  const missionAgentVerified =
    verifyMissionAgent(bundle, { trustStore: keys, now }).version === "99.0.0" &&
    verifyMissionAgentText(canonicalBundle, { trustStore: keys, now }).version === "99.0.0";
  if (!kmsVerified.SignatureValid || !localVerified || !missionControlVerified || !missionAgentVerified)
    throw new Error("Positive cross-verifier conformance failed");

  const negatives = {};
  function rejectedByBoth(candidate) {
    let centralRejected = false;
    let agentRejected = false;
    try {
      verifyMissionControl(candidate, { keys, now });
    } catch {
      centralRejected = true;
    }
    try {
      verifyMissionAgent(candidate, { trustStore: keys, now });
    } catch {
      agentRejected = true;
    }
    return centralRejected && agentRejected;
  }
  for (const [name, candidate] of Object.entries({
    modifiedArtifactChecksum: { ...bundle, artifactSha256: "a".repeat(64) },
    modifiedSourceSha: { ...bundle, sourceCommit: "d".repeat(40) },
    modifiedVersion: { ...bundle, agentVersion: "99.0.1", artifactPath: "/mission-agent-99.0.1.mjs" },
    modifiedSigningKeyId: { ...bundle, signingKeyId: "mission-agent-release-2099-98" },
    modifiedIdentityProtocol: { ...bundle, identityProtocolVersion: "1" },
    modifiedActivationProtocol: { ...bundle, activationProtocolVersion: "2" },
    invalidSignature: { ...bundle, signature: Buffer.alloc(64, 1).toString("base64") },
    truncatedSignature: { ...bundle, signature: signature.subarray(0, 63).toString("base64") },
    unknownField: { ...bundle, unexpected: "rejected" },
    missingRequiredField: Object.fromEntries(Object.entries(bundle).filter(([field]) => field !== "sourceCommit")),
  }))
    negatives[name] = rejectedByBoth(candidate);

  let kmsRejectedModifiedByte = false;
  try {
    kmsRejectedModifiedByte = !(
      await kms.send(
        new VerifyCommand({
          KeyId: keyArn,
          Message: Buffer.from(`${canonicalManifest} `),
          MessageType: "RAW",
          Signature: signature,
          SigningAlgorithm: "ED25519_SHA_512",
        }),
      )
    ).SignatureValid;
  } catch {
    kmsRejectedModifiedByte = true;
  }
  negatives.modifiedManifestByte =
    !verify(null, Buffer.from(`${canonicalManifest} `), publicKey, signature) && kmsRejectedModifiedByte;
  negatives.wrongPublicKey = !verify(null, message, generateKeyPairSync("ed25519").publicKey, signature);
  try {
    await kms.send(
      new VerifyCommand({
        KeyId: "arn:aws:kms:us-east-1:661452835066:key/00000000-0000-0000-0000-000000000000",
        Message: message,
        MessageType: "RAW",
        Signature: signature,
        SigningAlgorithm: "ED25519_SHA_512",
      }),
    );
    negatives.wrongKmsKey = false;
  } catch {
    negatives.wrongKmsKey = true;
  }
  try {
    verifyMissionAgentText(JSON.stringify(bundle, null, 2), { trustStore: keys, now });
    negatives.noncanonicalSerialization = false;
  } catch {
    negatives.noncanonicalSerialization = true;
  }
  try {
    verifyMissionAgentText(
      canonicalBundle.replace('"agentVersion":"99.0.0"', '"agentVersion":"99.0.0","agentVersion":"99.0.1"'),
      {
        trustStore: keys,
        now,
      },
    );
    negatives.duplicateField = false;
  } catch {
    negatives.duplicateField = true;
  }
  if (Object.values(negatives).some((passed) => !passed)) throw new Error("One or more negative cases failed open");

  const report = {
    reportVersion: "1",
    testReleaseIdentifier: "release-authority-conformance-2026-07",
    releaseVersion: manifest.agentVersion,
    sourceSha: manifest.sourceCommit,
    artifactSha256: manifest.artifactSha256,
    canonicalManifestSha256: createHash("sha256").update(message).digest("hex"),
    releaseAuthorityKeyId: keyId,
    kmsKeyArn: keyArn,
    publicKeyFingerprint: fingerprint,
    signingAlgorithm: "ED25519_SHA_512",
    messageType: "RAW",
    awsRequestId: signed.$metadata.requestId,
    signerPrincipalArn: caller.Arn,
    signingTime: new Date().toISOString(),
    signatureSha256: createHash("sha256").update(signature).digest("hex"),
    signatureLengthBytes: signature.byteLength,
    verification: {
      awsKms: true,
      standaloneLocalEd25519: true,
      missionControl: true,
      missionAgent070: true,
    },
    negativeCases: negatives,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(JSON.stringify(report));
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      metadata: error?.$metadata
        ? { httpStatusCode: error.$metadata.httpStatusCode, requestId: error.$metadata.requestId }
        : undefined,
    }),
  );
  process.exitCode = 1;
});
