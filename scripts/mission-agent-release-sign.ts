import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  awsKmsSigningClients,
  humanSigningConfirmation,
  parseKmsKeyArn,
  signReleaseWithKms,
} from "../integrations/mission-agent/kms-release-signer";
import {
  parseCanonicalReleaseManifestV3Json,
  type ReleaseKeyRecord,
} from "../integrations/mission-agent/release-authority";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("KMS release signing requires an interactive human terminal");
  const manifestPath = option("--manifest");
  const artifactPath = option("--artifact");
  const keyRecordPath = option("--pending-key-record");
  const kmsKeyArn = option("--kms-key-arn");
  const manifest = parseCanonicalReleaseManifestV3Json(await readFile(manifestPath, "utf8"));
  const pendingKeyRecord = JSON.parse(await readFile(keyRecordPath, "utf8")) as ReleaseKeyRecord;
  const trustActivationEvidence = JSON.parse(
    await readFile(option("--trust-activation-evidence"), "utf8"),
  ) as Parameters<typeof signReleaseWithKms>[0]["trustActivationEvidence"];
  const confirmation = humanSigningConfirmation({
    releaseVersion: manifest.releaseVersion,
    artifactSha256: manifest.artifactSha256,
    releaseAuthorityKeyId: manifest.signingKeyId,
  });
  stdout.write(
    `${JSON.stringify(
      {
        releaseVersion: manifest.releaseVersion,
        sourceCommit: manifest.build.sourceCommit,
        artifactSha256: manifest.artifactSha256,
        signingKeyId: manifest.signingKeyId,
        kmsKeyArn,
      },
      null,
      2,
    )}\n`,
  );
  const prompt = createInterface({ input: stdin, output: stdout });
  const entered = await prompt.question(`Type exactly:\n${confirmation}\n> `);
  prompt.close();
  const { region } = parseKmsKeyArn(kmsKeyArn);
  const receipt = await signReleaseWithKms(
    {
      manifestPath,
      artifactPath,
      outputBundlePath: option("--output-bundle"),
      outputSignaturePath: option("--output-signature"),
      outputReceiptPath: option("--output-receipt"),
      expectedArtifactSha256: option("--expected-artifact-sha256"),
      expectedSourceCommit: option("--expected-source-commit"),
      expectedReleaseVersion: option("--expected-release-version"),
      releaseAuthorityKeyId: option("--release-authority-key-id"),
      kmsKeyArn,
      pendingKeyRecord,
      trustActivationEvidence,
      expectedSignerRoleArn: option("--expected-signer-role-arn"),
      approvalReference: option("--approval-reference"),
      humanConfirmation: entered,
    },
    awsKmsSigningClients({ region }),
  );
  stdout.write(`${JSON.stringify(receipt)}\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
