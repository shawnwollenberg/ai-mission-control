import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getDatabasePool } from "@/lib/database";

type ArtifactRow = { storage_provider: string; storage_key: string; checksum_sha256: string; [key: string]: unknown };
const artifactProvider = () => process.env.ARTIFACT_STORAGE_PROVIDER ?? "local";
function objectClient() {
  return new S3Client({
    region: process.env.ARTIFACT_S3_REGION!,
    endpoint: process.env.ARTIFACT_S3_ENDPOINT,
    forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
    credentials: process.env.ARTIFACT_S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.ARTIFACT_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.ARTIFACT_S3_SECRET_ACCESS_KEY!,
        }
      : undefined,
  });
}

export async function storeExecutionArtifact(input: {
  workspaceId: string;
  missionId: string;
  taskId: string;
  executionId: string;
  kind: string;
  mediaType: string;
  body: string | Buffer;
  metadata?: Record<string, unknown>;
  maxBytes?: number;
}) {
  const provider = artifactProvider();
  if (process.env.APP_ENV === "production" && provider !== "s3")
    throw new Error("Production artifacts require object storage");
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
  const bytes = new Uint8Array(body);
  const budget = (
    await getDatabasePool().query(
      `SELECT COALESCE(sum(a.byte_size),0)::bigint used,r.execution_budget FROM execution_projections e JOIN repositories r ON r.workspace_id=e.workspace_id AND r.repository_id=e.repository_id LEFT JOIN artifacts a ON a.workspace_id=e.workspace_id AND a.execution_id=e.execution_id AND a.deleted_at IS NULL WHERE e.workspace_id=$1 AND e.execution_id=$2 GROUP BY r.execution_budget`,
      [input.workspaceId, input.executionId],
    )
  ).rows[0];
  const maximum = input.maxBytes ?? Number(budget?.execution_budget?.maxArtifactBytes ?? 10_000_000),
    used = Number(budget?.used ?? 0);
  if (body.byteLength > maximum || used + body.byteLength > maximum)
    throw new Error("Artifact exceeds configured execution limit");
  const artifactId = randomUUID(),
    checksum = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `${process.env.APP_ENV ?? "local"}/${input.workspaceId}/${input.executionId}/${artifactId}.artifact`;
  if (provider === "s3") {
    if (!process.env.ARTIFACT_S3_BUCKET) throw new Error("ARTIFACT_S3_BUCKET is required");
    await objectClient().send(
      new PutObjectCommand({
        Bucket: process.env.ARTIFACT_S3_BUCKET,
        Key: storageKey,
        Body: bytes,
        ContentType: input.mediaType,
        ServerSideEncryption: "AES256",
        Metadata: { checksumSha256: checksum, workspaceId: input.workspaceId },
      }),
    );
  } else {
    if (!process.env.ARTIFACT_STORAGE_ROOT) throw new Error("ARTIFACT_STORAGE_ROOT is required");
    await mkdir(process.env.ARTIFACT_STORAGE_ROOT, { recursive: true });
    const root = await realpath(process.env.ARTIFACT_STORAGE_ROOT),
      target = path.join(root, storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  await getDatabasePool().query(
    `INSERT INTO artifacts(workspace_id,artifact_id,mission_id,task_id,execution_id,kind,media_type,byte_size,checksum_sha256,storage_provider,storage_key,provenance,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'live',$12)`,
    [
      input.workspaceId,
      artifactId,
      input.missionId,
      input.taskId,
      input.executionId,
      input.kind,
      input.mediaType,
      body.byteLength,
      checksum,
      provider,
      storageKey,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { artifactId, kind: input.kind, byteSize: body.byteLength, checksum, storageKey };
}

export async function readExecutionArtifact(workspaceId: string, artifactId: string) {
  const row = (
    await getDatabasePool().query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE workspace_id=$1 AND artifact_id=$2 AND deleted_at IS NULL",
      [workspaceId, artifactId],
    )
  ).rows[0];
  if (!row) return;
  let body: Buffer;
  if (row.storage_provider === "s3") {
    const response = await objectClient().send(
      new GetObjectCommand({ Bucket: process.env.ARTIFACT_S3_BUCKET!, Key: row.storage_key }),
    );
    body = Buffer.from(await response.Body!.transformToByteArray());
  } else {
    const root = await realpath(process.env.ARTIFACT_STORAGE_ROOT!);
    body = await readFile(path.join(root, row.storage_key));
  }
  if (createHash("sha256").update(new Uint8Array(body)).digest("hex") !== row.checksum_sha256)
    throw new Error("Artifact checksum mismatch");
  return { metadata: row, body };
}
