import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { validateProductionConfiguration } from "../lib/production-config";
async function main() {
  if (
    process.env.APP_ENV !== "production" ||
    process.env.PRODUCTION_CONFIRMATION !== "VALIDATE_MISSION_CONTROL_ARTIFACTS"
  )
    throw new Error("Artifact validation requires explicit production confirmation");
  const validation = await validateProductionConfiguration("codex");
  if (!validation.ready) throw new Error(`Configuration failed: ${validation.failed.join(", ")}`);
  const client = new S3Client({
    region: process.env.ARTIFACT_S3_REGION!,
    endpoint: process.env.ARTIFACT_S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.ARTIFACT_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.ARTIFACT_S3_SECRET_ACCESS_KEY!,
    },
  });
  const key = `production/smoke/${randomUUID()}.txt`,
    body = Buffer.from("mission-control-artifact-smoke-v1"),
    checksum = createHash("sha256").update(new Uint8Array(body)).digest("hex"),
    bucket = process.env.ARTIFACT_S3_BUCKET!;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: new Uint8Array(body),
        ContentType: "text/plain",
        ServerSideEncryption: "AES256",
        Metadata: { checksumSha256: checksum },
      }),
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (head.Metadata?.checksumsha256 !== checksum && head.Metadata?.checksumSha256 !== checksum)
      throw new Error("Stored checksum metadata mismatch");
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      received = new Uint8Array(await result.Body!.transformToByteArray());
    if (createHash("sha256").update(received).digest("hex") !== checksum)
      throw new Error("Retrieved checksum mismatch");
    console.log(
      JSON.stringify({
        event: "production_artifact_validated",
        prefix: "production/smoke",
        contentType: head.ContentType,
        encrypted: Boolean(head.ServerSideEncryption),
        secretPrinted: false,
      }),
    );
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "production_artifact_validation_failed",
      message: error instanceof Error ? error.message : String(error),
      secretPrinted: false,
    }),
  );
  process.exitCode = 1;
});
