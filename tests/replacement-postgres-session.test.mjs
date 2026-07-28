import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  executeReplacementClaimAndMigration,
  loadAndVerifyMigrationFixture,
  validateLiveMigrationHistory,
} from "../application/replacement-bootstrap-postgres-session.ts";
import {
  authorizationChecksum,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap.ts";

const authorization = validateReplacementAuthorization(
  JSON.parse(await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8")),
  { now: new Date("2026-07-28T00:00:00.000Z") },
);

function fakeSession(options = {}) {
  const queries = [];
  let pidReads = 0;
  let released = false;
  const client = {
    async query(statement, values = []) {
      queries.push({ statement, values });
      if (options.failOn && statement.includes(options.failOn)) throw new Error("injected connection loss");
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK")
        return { rows: [], rowCount: null };
      if (statement.includes("pg_backend_pid() AS backend_pid,clock_timestamp")) {
        return {
          rows: [{ backend_pid: 7001, database_time: options.databaseTime ?? new Date("2026-07-28T00:00:00.000Z") }],
          rowCount: 1,
        };
      }
      if (statement === "SELECT pg_backend_pid() AS backend_pid") {
        pidReads += 1;
        return { rows: [{ backend_pid: options.sessionChanged && pidReads > 1 ? 7002 : 7001 }], rowCount: 1 };
      }
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (statement.includes("FROM schema_migrations ORDER BY name")) {
        const fixture = JSON.parse(
          await readFile("release/mission-agent-0.7.2/replacement-bootstrap/migration-history.json", "utf8"),
        );
        return {
          rows: fixture.migrations.slice(0, 28).map((item) => ({
            name: options.wrongMigration && item.number === 12 ? "0012_wrong.sql" : item.filename,
            checksum_sha256: item.sha256,
          })),
          rowCount: 28,
        };
      }
      if (statement.includes("FROM approval_projections")) {
        return {
          rows: [
            {
              status: "granted",
              decided_by: authorization.approvedBy,
              action_hash: authorizationChecksum(authorization),
              expires_at: new Date(authorization.expiresAt),
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("count(*)::text")) {
        return { rows: [{ count: options.concurrent ? "1" : "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    queries,
    get released() {
      return released;
    },
  };
}

test("authoritative migration fixture matches exact repository bytes and ordered live history", async () => {
  const fixture = await loadAndVerifyMigrationFixture();
  const live = fixture.migrations.slice(0, 28).map((item) => ({
    name: item.filename,
    checksum_sha256: item.sha256,
  }));
  validateLiveMigrationHistory(live, fixture, 28);
  for (const changed of [
    live.slice(0, 27),
    [...live, { name: "0030_unexpected.sql", checksum_sha256: "0".repeat(64) }],
    live.map((row, index) => (index === 3 ? { ...row, checksum_sha256: "0".repeat(64) } : row)),
    live.map((row, index) => (index === 5 ? live[4] : row)),
  ])
    assert.throws(() => validateLiveMigrationHistory(changed, fixture, 28), /missing|unexpected|differs/i);
});

test("one checked-out PostgreSQL session owns clock, lock, validation, migration, claim, and commit", async () => {
  const context = fakeSession();
  const result = await executeReplacementClaimAndMigration({
    pool: context.pool,
    authorization,
    authenticatedOperator: authorization.operatorIdentity,
    approvalEvidenceChecksum: "a".repeat(64),
  });
  assert.equal(result.sessionBackendPid, 7001);
  assert.equal(result.schemaVersion, 29);
  assert.equal(context.released, true);
  assert.equal(
    context.queries.some((item) => item.statement === "BEGIN"),
    true,
  );
  assert.equal(
    context.queries.some((item) => item.statement === "COMMIT"),
    true,
  );
  assert.equal(
    context.queries.some((item) => item.statement.includes("pg_advisory_xact_lock")),
    true,
  );
});

test("session change, connection loss, concurrent claimant, migration drift, and expiry roll back", async () => {
  const cases = [
    { sessionChanged: true },
    { failOn: "approval_projections" },
    { concurrent: true },
    { wrongMigration: true },
    { databaseTime: new Date("2026-08-04T00:00:00.000Z") },
  ];
  for (const options of cases) {
    const context = fakeSession(options);
    await assert.rejects(
      () =>
        executeReplacementClaimAndMigration({
          pool: context.pool,
          authorization,
          authenticatedOperator: authorization.operatorIdentity,
          approvalEvidenceChecksum: "a".repeat(64),
        }),
      /session changed|connection loss|concurrent|differs|expired/i,
    );
    assert.equal(
      context.queries.some((item) => item.statement === "ROLLBACK"),
      true,
    );
    assert.equal(context.released, true);
  }
});
