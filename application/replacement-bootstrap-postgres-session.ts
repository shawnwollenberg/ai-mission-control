import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import {
  NAMED_CANARY_ID,
  authorizationChecksum,
  validateReplacementAuthorization,
  type ReplacementAuthorization,
  type ReplacementState,
} from "../integrations/mission-agent/replacement-bootstrap";
import type { ReplacementAuthorizationPackage } from "../integrations/mission-agent/replacement-authorization-package";

export const MIGRATION_FIXTURE_PATH =
  "release/mission-agent-0.7.2/replacement-bootstrap/migration-history.json" as const;
export const MIGRATION_0029_PATH = "db/migrations/0029_mission_agent_replacement_bootstrap.sql" as const;
export const MIGRATION_0029_SHA256 = "c58f48d1455489af81eef8efd3143fd54595f278d8d675e8aa08d3e9a2a09caa";
export const REPLACEMENT_ADVISORY_LOCK = 1_296_743_229;

type MigrationFixtureEntry = {
  number: number;
  filename: string;
  sha256: string;
  requiredInProduction: boolean;
};
export type MigrationHistoryFixture = {
  fixtureVersion: "1";
  canonicalization: "sha256-of-exact-repository-file-bytes";
  requiredPreExecutionVersion: 28;
  targetVersion: 29;
  migrations: MigrationFixtureEntry[];
};

export type LiveMigration = { name: string; checksum_sha256: string };
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function loadAndVerifyMigrationFixture(): Promise<MigrationHistoryFixture> {
  const fixture = JSON.parse(await readFile(MIGRATION_FIXTURE_PATH, "utf8")) as MigrationHistoryFixture;
  if (
    fixture.fixtureVersion !== "1" ||
    fixture.canonicalization !== "sha256-of-exact-repository-file-bytes" ||
    fixture.requiredPreExecutionVersion !== 28 ||
    fixture.targetVersion !== 29 ||
    fixture.migrations.length !== 29
  )
    throw new Error("Migration history fixture metadata is invalid.");
  for (let index = 0; index < fixture.migrations.length; index += 1) {
    const entry = fixture.migrations[index]!;
    const number = index + 1;
    if (
      entry.number !== number ||
      !entry.filename.startsWith(String(number).padStart(4, "0") + "_") ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.requiredInProduction !== number <= 28 ||
      sha256(Uint8Array.from(await readFile(`db/migrations/${entry.filename}`))) !== entry.sha256
    )
      throw new Error(`Migration fixture entry ${number} does not match exact repository bytes.`);
  }
  if (fixture.migrations[28]?.filename !== "0029_mission_agent_replacement_bootstrap.sql")
    throw new Error("Migration fixture target is not exact migration 0029.");
  return fixture;
}

export function validateLiveMigrationHistory(
  live: readonly LiveMigration[],
  fixture: MigrationHistoryFixture,
  expectedVersion: 28 | 29,
): void {
  const expected = fixture.migrations.slice(0, expectedVersion);
  if (live.length !== expected.length) throw new Error("Live migration history has missing or unexpected entries.");
  for (let index = 0; index < live.length; index += 1) {
    const row = live[index]!;
    const required = expected[index];
    if (!required || row.name !== required.filename || row.checksum_sha256 !== required.sha256)
      throw new Error(`Live migration history differs at ordered entry ${index + 1}.`);
  }
}

export interface DedicatedSessionPool {
  connect(): Promise<PoolClient>;
}

export type SessionEvidence = {
  sessionBackendPid: number;
  databaseTime: string;
  authorizationFingerprint: string;
  claimed: true;
  migrationApplied: true;
  schemaVersion: 29;
};

export async function executeReplacementClaimAndMigration(input: {
  pool: DedicatedSessionPool;
  authorization: ReplacementAuthorization;
  authenticatedOperator: string;
  approvalEvidenceChecksum: string;
  beforeCommit?: (client: PoolClient) => Promise<void>;
}): Promise<SessionEvidence> {
  const client = await input.pool.connect();
  let transaction = false;
  try {
    await client.query("BEGIN");
    transaction = true;
    const identity = await client.query<{ backend_pid: number; database_time: Date }>(
      "SELECT pg_backend_pid() AS backend_pid,clock_timestamp() AS database_time",
    );
    const firstIdentity = identity.rows[0];
    if (!firstIdentity || !(firstIdentity.database_time instanceof Date))
      throw new Error("Dedicated PostgreSQL session identity or clock is unavailable.");
    validateReplacementAuthorization(input.authorization, { now: firstIdentity.database_time });
    if (
      input.authenticatedOperator !== input.authorization.operatorIdentity ||
      !/^[a-f0-9]{64}$/.test(input.approvalEvidenceChecksum) ||
      !input.authorization.evidenceReferences.includes(`sha256:${input.approvalEvidenceChecksum}`)
    )
      throw new Error("Replacement execution operator or evidence is unauthorized.");
    await client.query("SELECT pg_advisory_xact_lock($1)", [REPLACEMENT_ADVISORY_LOCK]);
    const secondIdentity = await client.query<{ backend_pid: number }>("SELECT pg_backend_pid() AS backend_pid");
    if (secondIdentity.rows[0]?.backend_pid !== firstIdentity.backend_pid)
      throw new Error("PostgreSQL replacement session changed after lock acquisition.");

    const fixture = await loadAndVerifyMigrationFixture();
    const migrationRows = await client.query<LiveMigration>(
      "SELECT name,checksum_sha256 FROM schema_migrations ORDER BY name",
    );
    validateLiveMigrationHistory(migrationRows.rows, fixture, 28);
    const fingerprint = authorizationChecksum(input.authorization);
    const approval = await client.query<{
      status: string;
      decided_by: string | null;
      action_hash: string;
      expires_at: Date | null;
    }>(
      "SELECT status,decided_by,action_hash,expires_at FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2 FOR UPDATE",
      [input.authorization.workspaceId, input.authorization.approvalId],
    );
    const approved = approval.rows[0];
    if (
      !approved ||
      approved.status !== "granted" ||
      approved.decided_by !== input.authorization.approvedBy ||
      approved.action_hash !== fingerprint ||
      (approved.expires_at !== null && approved.expires_at <= firstIdentity.database_time)
    )
      throw new Error("Replacement approval is absent, expired, or has a different fingerprint.");
    const migration = await readFile(MIGRATION_0029_PATH, "utf8");
    if (sha256(migration) !== MIGRATION_0029_SHA256) throw new Error("Migration 0029 repository checksum mismatch.");
    await client.query(migration);
    await client.query("INSERT INTO schema_migrations(name,checksum_sha256) VALUES($1,$2)", [
      fixture.migrations[28]?.filename,
      MIGRATION_0029_SHA256,
    ]);
    const concurrent = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mission_agent_replacement_bootstraps
        WHERE workspace_id=$1 AND agent_id=$2
          AND state IN ('prepared','approved','draining','verified','staged','replacing','starting','connected','accepted')`,
      [input.authorization.workspaceId, NAMED_CANARY_ID],
    );
    if (Number(concurrent.rows[0]?.count ?? "0") !== 0)
      throw new Error("A concurrent replacement authorization already exists.");
    await client.query(
      `INSERT INTO mission_agent_replacement_bootstraps(
        workspace_id,authorization_id,approval_id,agent_id,protocol_version,authorization_record,authorization_checksum,
        state,aggregate_version,execution_count,expires_at,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'approved',1,0,$8,$9,$9)`,
      [
        input.authorization.workspaceId,
        input.authorization.authorizationId,
        input.authorization.approvalId,
        input.authorization.agentId,
        input.authorization.protocolVersion,
        JSON.stringify(input.authorization),
        fingerprint,
        input.authorization.expiresAt,
        firstIdentity.database_time.toISOString(),
      ],
    );
    await client.query(
      `INSERT INTO agent_protocol_receipts(
        workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        input.authorization.workspaceId,
        input.authorization.agentId,
        randomUUID(),
        input.authorization.authorizationId,
        fingerprint,
        JSON.stringify({ type: "replacement-bootstrap-claim", authorizationId: input.authorization.authorizationId }),
        input.authorization.expiresAt,
      ],
    );
    if (input.beforeCommit) await input.beforeCommit(client);
    const finalIdentity = await client.query<{ backend_pid: number }>("SELECT pg_backend_pid() AS backend_pid");
    if (finalIdentity.rows[0]?.backend_pid !== firstIdentity.backend_pid)
      throw new Error("PostgreSQL replacement session changed before commit.");
    await client.query("COMMIT");
    transaction = false;
    return {
      sessionBackendPid: firstIdentity.backend_pid,
      databaseTime: firstIdentity.database_time.toISOString(),
      authorizationFingerprint: fingerprint,
      claimed: true,
      migrationApplied: true,
      schemaVersion: 29,
    };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function persistReplacementOperationReceipt(input: {
  client: PoolClient;
  authorization: ReplacementAuthorization;
  operationId: string;
  nonce: string;
  receiptChecksum: string;
  sequence: number;
  state: ReplacementState;
}): Promise<void> {
  if (
    !/^[a-f0-9-]{36,80}$/.test(input.operationId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce) ||
    !/^[a-f0-9]{64}$/.test(input.receiptChecksum) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1
  )
    throw new Error("Replacement operation receipt is malformed.");
  await input.client.query(
    `INSERT INTO agent_protocol_receipts(
      workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      input.authorization.workspaceId,
      input.authorization.agentId,
      input.operationId,
      input.nonce,
      input.receiptChecksum,
      JSON.stringify({
        type: "replacement-bootstrap-operation",
        authorizationId: input.authorization.authorizationId,
        sequence: input.sequence,
        state: input.state,
      }),
      input.authorization.expiresAt,
    ],
  );
}

export async function persistReplacementPackageIssue(input: {
  client: PoolClient;
  pkg: ReplacementAuthorizationPackage;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO agent_protocol_receipts(
      workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      input.pkg.authorization.workspaceId,
      input.pkg.authorization.agentId,
      input.pkg.executionId,
      input.pkg.nonce,
      input.pkg.packageChecksum,
      JSON.stringify({
        type: "replacement-bootstrap-package-issued",
        authorizationId: input.pkg.authorization.authorizationId,
        credentialId: input.pkg.credentialId,
        maximumUseCount: 1,
      }),
      input.pkg.expiresAt,
    ],
  );
}
