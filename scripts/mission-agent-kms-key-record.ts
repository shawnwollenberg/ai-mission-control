import { DescribeKeyCommand, GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { writeFile } from "node:fs/promises";
import { parseKmsKeyArn, pendingKmsReleaseKeyRecord } from "../integrations/mission-agent/kms-release-signer";
import { canonicalJson, validatePendingReleaseKey } from "../integrations/mission-agent/release-authority";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const kmsKeyArn = option("--kms-key-arn");
  const output = option("--output");
  const releaseAuthorityKeyId = option("--release-authority-key-id");
  const { region, keyId } = parseKmsKeyArn(kmsKeyArn);
  const kms = new KMSClient({ region });
  const described = await kms.send(new DescribeKeyCommand({ KeyId: kmsKeyArn }));
  if (
    described.KeyMetadata?.Arn !== kmsKeyArn ||
    described.KeyMetadata.KeyId !== keyId ||
    described.KeyMetadata.KeySpec !== "ECC_NIST_EDWARDS25519" ||
    described.KeyMetadata.KeyUsage !== "SIGN_VERIFY" ||
    described.KeyMetadata.Enabled !== true ||
    described.KeyMetadata.KeyState !== "Enabled" ||
    described.KeyMetadata.Origin !== "AWS_KMS" ||
    described.KeyMetadata.KeyManager !== "CUSTOMER" ||
    described.KeyMetadata.MultiRegion !== false
  )
    throw new Error("KMS key metadata is incompatible with Release Authority v2");
  const publicKey = await kms.send(new GetPublicKeyCommand({ KeyId: kmsKeyArn }));
  if (
    publicKey.KeySpec !== "ECC_NIST_EDWARDS25519" ||
    publicKey.KeyUsage !== "SIGN_VERIFY" ||
    !publicKey.SigningAlgorithms?.includes("ED25519_SHA_512") ||
    !publicKey.PublicKey
  )
    throw new Error("KMS public key is incompatible with Release Authority v2");
  const record = validatePendingReleaseKey(
    pendingKmsReleaseKeyRecord({
      releaseAuthorityKeyId,
      kmsKeyArn,
      publicKeySpkiDer: publicKey.PublicKey,
      createdAt:
        described.KeyMetadata.CreationDate?.toISOString() ??
        (() => {
          throw new Error("KMS key metadata lacks CreationDate");
        })(),
    }),
  );
  await writeFile(output, `${canonicalJson(record)}\n`, { flag: "wx", mode: 0o644 });
  console.log(
    JSON.stringify({
      output,
      keyId: record.keyId,
      kmsKeyArn: record.kms?.keyArn,
      publicKeyFingerprint: record.publicKeyFingerprint,
      status: record.status,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
