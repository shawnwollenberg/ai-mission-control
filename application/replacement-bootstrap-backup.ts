import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  loadAndVerifyMigrationFixture,
  validateLiveMigrationHistory,
  type LiveMigration,
} from "./replacement-bootstrap-postgres-session";

export const POSTGRES_TOOL_MANIFEST =
  "release/mission-agent-0.7.2/replacement-bootstrap/postgresql-tools.json" as const;
export const PRODUCTION_BACKUP_ROOT = "/opt/mission-control/backups/replacement-bootstrap" as const;
export const PG_DUMP = "/usr/bin/pg_dump" as const;
export const PG_RESTORE = "/usr/bin/pg_restore" as const;
export const PSQL = "/usr/bin/psql" as const;
export const PG_SERVICE = "mission-control-production-release-bootstrap" as const;

type ProgramResult = {
  exitStatus: 0;
  startedAt: string;
  completedAt: string;
  safeStdoutSummary: string;
  safeStderrSummary: "";
};
export interface BoundProgramRunner {
  runtimeIdentity(): Promise<{
    imageDigest: string;
    platform: "linux/amd64";
    immutable: true;
  }>;
  executableMetadata(path: typeof PG_DUMP | typeof PG_RESTORE | typeof PSQL): Promise<{
    sha256: string;
    version: "17.4";
    owner: "root";
    mode: "0755";
    symbolicLink: false;
  }>;
  execute(input: {
    executable: typeof PG_DUMP | typeof PG_RESTORE | typeof PSQL;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
  }): Promise<ProgramResult>;
  readFile(path: string): Promise<Uint8Array>;
  fileMetadata(path: string): Promise<{ byteLength: number; mode: "0600"; owner: string }>;
}
export interface EncryptionVerifier {
  verify(path: string): Promise<{
    encrypted: true;
    volumeId: string;
    kmsKeyArn: string;
    region: "us-east-1";
  }>;
}
export interface DisposableRestoreTarget {
  create(): Promise<{ databaseReference: string }>;
  migrationHistory(): Promise<LiveMigration[]>;
  validate(): Promise<{
    connected: true;
    requiredTablesPresent: true;
    representativeRowCountsMatch: true;
    repositoryFingerprintsPreserved: true;
    authorizationTablesAbsent: true;
  }>;
  destroy(): Promise<void>;
}

export type VerifiedBackupReceipt = {
  backupId: string;
  path: string;
  sha256: string;
  byteLength: number;
  mode: "0600";
  owner: string;
  schemaVersion: 28;
  encrypted: true;
  volumeId: string;
  kmsKeyArn: string;
  region: "us-east-1";
  structuralVerification: "pg_restore-list-passed";
  disposableRestore: "passed";
  postRestoreValidation: "passed";
  startedAt: string;
  completedAt: string;
  offHostRetention: "follow-up-required";
};

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function validateBoundPostgresTools(runner?: BoundProgramRunner): Promise<void> {
  const manifest = JSON.parse(await readFile(POSTGRES_TOOL_MANIFEST, "utf8")) as {
    productionExecutionBoundary: { imageDigest: string };
    tools: Array<{
      name: string;
      absolutePath: string;
      version: string;
      expectedMajorVersion: number;
      binarySha256: string;
    }>;
  };
  if (
    manifest.productionExecutionBoundary.imageDigest !==
      "sha256:d4eceb7552a57997fff2e9ceb1a624210e61b6432a2a1f7934a418c27bfe1406" ||
    manifest.tools.length !== 3
  )
    throw new Error("PostgreSQL tool manifest image binding is invalid.");
  const expected = [
    ["pg_dump", PG_DUMP],
    ["pg_restore", PG_RESTORE],
    ["psql", PSQL],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const tool = manifest.tools[index];
    if (
      tool?.name !== expected[index]?.[0] ||
      tool.absolutePath !== expected[index]?.[1] ||
      tool.version !== "17.4" ||
      tool.expectedMajorVersion !== 17 ||
      tool.binarySha256 !== "fc00112585bd75eb9eb6fcd11ca4cf7222acf10259a1f21eea4889536dee640a" ||
      !tool.absolutePath.startsWith("/")
    )
      throw new Error("PostgreSQL tool path or version binding is invalid.");
    if (runner) {
      const actual = await runner.executableMetadata(tool.absolutePath as typeof PG_DUMP);
      if (
        actual.sha256 !== tool.binarySha256 ||
        actual.version !== "17.4" ||
        actual.owner !== "root" ||
        actual.mode !== "0755" ||
        actual.symbolicLink
      )
        throw new Error("PostgreSQL executable runtime bytes or metadata mismatch.");
    }
  }
  if (runner) {
    const runtime = await runner.runtimeIdentity();
    if (
      !runtime.immutable ||
      runtime.platform !== "linux/amd64" ||
      runtime.imageDigest !== manifest.productionExecutionBoundary.imageDigest
    )
      throw new Error("PostgreSQL runner is outside the immutable authorized image.");
  }
}

export async function createAndRestoreVerifiedBackup(input: {
  authorizationId: string;
  runner: BoundProgramRunner;
  encryption: EncryptionVerifier;
  restore: DisposableRestoreTarget;
  now: Date;
}): Promise<VerifiedBackupReceipt> {
  await validateBoundPostgresTools(input.runner);
  if (!/^[a-f0-9-]{36}$/.test(input.authorizationId)) throw new Error("Backup authorization ID is invalid.");
  const directory = resolve(PRODUCTION_BACKUP_ROOT, input.authorizationId);
  const filename = `mission-control-0028-${input.now.toISOString().replaceAll(/[:.]/g, "-")}.dump`;
  const path = join(directory, filename);
  if (!path.startsWith(`${PRODUCTION_BACKUP_ROOT}/`) || resolve(path) !== path)
    throw new Error("Backup path escaped the approved production root.");
  const environment = { PGSERVICE: PG_SERVICE, PGAPPNAME: "mission-agent-replacement-backup" };
  const dump = await input.runner.execute({
    executable: PG_DUMP,
    arguments: ["--format=custom", "--compress=9", `--file=${path}`, `--dbname=${PG_SERVICE}`],
    environment,
  });
  const metadata = await input.runner.fileMetadata(path);
  const bytes = await input.runner.readFile(path);
  if (metadata.mode !== "0600" || metadata.byteLength !== bytes.byteLength || bytes.byteLength === 0)
    throw new Error("Backup permissions, length, or content is invalid.");
  const encryption = await input.encryption.verify(path);
  if (!encryption.encrypted || !encryption.volumeId || !encryption.kmsKeyArn)
    throw new Error("Backup destination encryption could not be proven.");
  await input.runner.execute({
    executable: PG_RESTORE,
    arguments: ["--list", path],
    environment,
  });
  const target = await input.restore.create();
  let restoreValidated = false;
  try {
    await input.runner.execute({
      executable: PG_RESTORE,
      arguments: [
        "--exit-on-error",
        "--clean",
        "--if-exists",
        "--no-owner",
        `--dbname=${target.databaseReference}`,
        path,
      ],
      environment,
    });
    const fixture = await loadAndVerifyMigrationFixture();
    validateLiveMigrationHistory(await input.restore.migrationHistory(), fixture, 28);
    const validation = await input.restore.validate();
    restoreValidated =
      validation.connected &&
      validation.requiredTablesPresent &&
      validation.representativeRowCountsMatch &&
      validation.repositoryFingerprintsPreserved &&
      validation.authorizationTablesAbsent;
    if (!restoreValidated) throw new Error("Disposable backup restore validation failed.");
  } finally {
    await input.restore.destroy();
  }
  return {
    backupId: basename(path, ".dump"),
    path,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mode: "0600",
    owner: metadata.owner,
    schemaVersion: 28,
    encrypted: true,
    volumeId: encryption.volumeId,
    kmsKeyArn: encryption.kmsKeyArn,
    region: encryption.region,
    structuralVerification: "pg_restore-list-passed",
    disposableRestore: "passed",
    postRestoreValidation: restoreValidated ? "passed" : ("" as never),
    startedAt: dump.startedAt,
    completedAt: new Date().toISOString(),
    offHostRetention: "follow-up-required",
  };
}
