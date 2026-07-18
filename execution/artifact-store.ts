import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDatabasePool } from "@/lib/database";
type ArtifactRow = { storage_key: string; checksum_sha256: string; [key: string]: unknown };
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
  const configured = process.env.ARTIFACT_STORAGE_ROOT;
  if (!configured) throw new Error("ARTIFACT_STORAGE_ROOT is required");
  await mkdir(configured, { recursive: true });
  const root = await realpath(configured),
    artifactId = randomUUID(),
    relative = path.join(input.workspaceId, input.executionId, `${artifactId}.artifact`),
    target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
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
  await writeFile(target, bytes, { flag: "wx" });
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await getDatabasePool().query(
    `INSERT INTO artifacts(workspace_id,artifact_id,mission_id,task_id,execution_id,kind,media_type,byte_size,checksum_sha256,storage_provider,storage_key,provenance,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'local',$10,'live',$11)`,
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
      relative,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { artifactId, kind: input.kind, byteSize: body.byteLength, checksum, storageKey: relative };
}
export async function readExecutionArtifact(workspaceId: string, artifactId: string) {
  const row = (
    await getDatabasePool().query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE workspace_id=$1 AND artifact_id=$2 AND deleted_at IS NULL",
      [workspaceId, artifactId],
    )
  ).rows[0];
  if (!row) return;
  const root = await realpath(process.env.ARTIFACT_STORAGE_ROOT!);
  const target = path.join(root, row.storage_key),
    body = await readFile(target);
  if (createHash("sha256").update(new Uint8Array(body)).digest("hex") !== row.checksum_sha256)
    throw new Error("Artifact checksum mismatch");
  return { metadata: row, body };
}
