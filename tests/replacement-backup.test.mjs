import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PG_DUMP,
  PG_RESTORE,
  createAndRestoreVerifiedBackup,
  validateBoundPostgresTools,
} from "../application/replacement-bootstrap-backup.ts";

const fixture = JSON.parse(
  await readFile("release/mission-agent-0.7.2/replacement-bootstrap/migration-history.json", "utf8"),
);

function dependencies(options = {}) {
  const calls = [];
  let destroyed = false;
  const bytes = Uint8Array.from(Buffer.from("disposable-custom-format-backup"));
  return {
    calls,
    get destroyed() {
      return destroyed;
    },
    runner: {
      async runtimeIdentity() {
        return {
          imageDigest: options.wrongImage ?? "sha256:d4eceb7552a57997fff2e9ceb1a624210e61b6432a2a1f7934a418c27bfe1406",
          platform: "linux/amd64",
          immutable: true,
        };
      },
      async executableMetadata() {
        return {
          sha256: options.wrongBinary ?? "fc00112585bd75eb9eb6fcd11ca4cf7222acf10259a1f21eea4889536dee640a",
          version: "17.4",
          owner: "root",
          mode: "0755",
          symbolicLink: false,
        };
      },
      async execute(input) {
        calls.push(input);
        if (options.failExecutable === input.executable) throw new Error("injected backup tool failure");
        return {
          exitStatus: 0,
          startedAt: "2026-07-28T00:00:00.000Z",
          completedAt: "2026-07-28T00:00:01.000Z",
          safeStdoutSummary: "fixed tool passed",
          safeStderrSummary: "",
        };
      },
      async readFile() {
        return bytes;
      },
      async fileMetadata() {
        return { byteLength: bytes.byteLength, mode: options.mode ?? "0600", owner: "root:root" };
      },
    },
    encryption: {
      async verify() {
        if (options.unencrypted) return { encrypted: false };
        return {
          encrypted: true,
          volumeId: "vol-disposable",
          kmsKeyArn: "arn:aws:kms:us-east-1:661452835066:key/disposable",
          region: "us-east-1",
        };
      },
    },
    restore: {
      async create() {
        return { databaseReference: "disposable_restore" };
      },
      async migrationHistory() {
        const rows = fixture.migrations.slice(0, 28).map((item) => ({
          name: item.filename,
          checksum_sha256: item.sha256,
        }));
        if (options.wrongHistory) rows[10].checksum_sha256 = "0".repeat(64);
        return rows;
      },
      async validate() {
        return {
          connected: true,
          requiredTablesPresent: true,
          representativeRowCountsMatch: !options.rowMismatch,
          repositoryFingerprintsPreserved: true,
          authorizationTablesAbsent: true,
        };
      },
      async destroy() {
        destroyed = true;
      },
    },
  };
}

test("PostgreSQL tools are absolute, version-bound, and immutable-image-bound", async () => {
  await validateBoundPostgresTools();
  await validateBoundPostgresTools(dependencies().runner);
  await assert.rejects(
    () => validateBoundPostgresTools(dependencies({ wrongBinary: "0".repeat(64) }).runner),
    /bytes/i,
  );
  await assert.rejects(
    () => validateBoundPostgresTools(dependencies({ wrongImage: "sha256:" + "0".repeat(64) }).runner),
    /image/i,
  );
});

test("backup proves encryption and disposable restore before returning receipt", async () => {
  const deps = dependencies();
  const receipt = await createAndRestoreVerifiedBackup({
    authorizationId: "11111111-1111-4111-8111-111111111111",
    runner: deps.runner,
    encryption: deps.encryption,
    restore: deps.restore,
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(receipt.encrypted, true);
  assert.equal(receipt.disposableRestore, "passed");
  assert.equal(deps.destroyed, true);
  assert.deepEqual(
    deps.calls.map((call) => call.executable),
    [PG_DUMP, PG_RESTORE, PG_RESTORE],
  );
  assert.equal(
    deps.calls.flatMap((call) => call.arguments).some((arg) => arg.includes("postgresql://")),
    false,
  );
});

test("unencrypted destination, restore failure, history mismatch, and data mismatch fail closed and clean up", async () => {
  for (const options of [
    { unencrypted: true },
    { failExecutable: PG_RESTORE },
    { wrongHistory: true },
    { rowMismatch: true },
    { mode: "0644" },
  ]) {
    const deps = dependencies(options);
    await assert.rejects(
      () =>
        createAndRestoreVerifiedBackup({
          authorizationId: "11111111-1111-4111-8111-111111111111",
          runner: deps.runner,
          encryption: deps.encryption,
          restore: deps.restore,
          now: new Date("2026-07-28T00:00:00.000Z"),
        }),
      /encrypt|failure|differs|validation|permissions/i,
    );
    if (!options.unencrypted && options.mode !== "0644" && options.failExecutable !== PG_RESTORE)
      assert.equal(deps.destroyed, true);
  }
});
