import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);
const port = 55446;
const database = "mission_control_replacement_disposable_upgrade_acceptance";
const container = `mc-replacement-migration-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
const output = resolve(
  process.env.REPLACEMENT_MIGRATION_EVIDENCE_OUTPUT ??
    "release/mission-agent-0.7.2/replacement-bootstrap/evidence/migration-acceptance.json",
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, args, env = {}) =>
  exec(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });

async function waitForDatabase() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await run("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", database]);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready.");
}

async function main() {
  try {
    await run("docker", [
      "run",
      "--name",
      container,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${database}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      "-d",
      "postgres:17-alpine",
    ]);
    await waitForDatabase();
    const imageDigest = (await run("docker", ["inspect", container, "--format", "{{.Image}}"])).stdout.trim();
    const boundary = await run(
      "node",
      ["--import", "tsx", "scripts/apply-disposable-migrations-through.ts", "--through", "0028"],
      { DATABASE_URL: databaseUrl },
    );
    if (!boundary.stdout.includes('"through":"0028"') || !boundary.stdout.includes('"count":28'))
      throw new Error("0028 migration boundary was not established.");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO workspaces(id,slug,name)
         VALUES('10000000-0000-4000-8000-000000000001','upgrade-fixture','Upgrade fixture')`,
      );
      await client.query(
        `INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch)
         VALUES(
           '10000000-0000-4000-8000-000000000001',
           '30000000-0000-4000-8000-000000000001',
           'upgrade-repository','/disposable/upgrade-repository','main'
         )`,
      );
      const row = async () =>
        (
          await client.query(
            `SELECT w.id,w.slug,w.name,r.repository_id,r.name repository_name,r.local_path,r.default_branch
               FROM workspaces w JOIN repositories r ON r.workspace_id=w.id
              WHERE w.id='10000000-0000-4000-8000-000000000001'`,
          )
        ).rows[0];
      const beforeSha256 = hash(JSON.stringify(await row()));
      const first = await run("npm", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
      if (
        !first.stdout.includes('"migration":"0029_mission_agent_replacement_bootstrap.sql"') ||
        !first.stdout.includes('"pendingMigrations":0')
      )
        throw new Error("Current migration 0029 was not applied cleanly.");
      const afterSha256 = hash(JSON.stringify(await row()));
      if (beforeSha256 !== afterSha256) throw new Error("Representative 0028 data changed during migration 0029.");
      const second = await run("npm", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
      if (!second.stdout.includes('"pendingMigrations":0')) throw new Error("Second migration run is not idempotent.");
      const history = (
        await client.query(
          `SELECT name,checksum_sha256 FROM schema_migrations
            WHERE name='0029_mission_agent_replacement_bootstrap.sql'`,
        )
      ).rows[0];
      const claimRows = Number(
        (await client.query("SELECT count(*)::int count FROM mission_agent_replacement_execution_claims")).rows[0]
          .count,
      );
      if (claimRows !== 0) throw new Error("Migration created replacement claims.");
      const migrationBytes = await readFile("db/migrations/0029_mission_agent_replacement_bootstrap.sql");
      const evidence = {
        evidenceVersion: "replacement-migration-acceptance-v2",
        generatedAt: new Date().toISOString(),
        sourceBaseCommit: "9abc71da235f63c6ce2e4b0197ecfdd53d3015ed",
        command: "npm run test:replacement:migration",
        database: {
          image: "postgres:17-alpine",
          imageDigest,
          topology: "loopback-disposable",
          resourceFingerprint: hash(JSON.stringify({ host: "127.0.0.1", database, boundary: "0028", target: "0029" })),
        },
        migration: {
          filename: history.name,
          sourceSha256: hash(migrationBytes),
          recordedChecksum: history.checksum_sha256,
          initialBoundary: "0028",
          initialMigrationCount: 28,
          pendingMigrations: 0,
          secondRunPendingMigrations: 0,
        },
        representativeData: {
          workspaceId: "10000000-0000-4000-8000-000000000001",
          repositoryId: "30000000-0000-4000-8000-000000000001",
          beforeSha256,
          afterSha256,
          preserved: beforeSha256 === afterSha256,
        },
        newReplacementClaimRows: claimRows,
        productionContacted: false,
        namedCanaryContacted: false,
        result: "pass",
      };
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(
        `${JSON.stringify({ result: evidence.result, migration: history.name, dataPreserved: true })}\n`,
      );
    } finally {
      await client.end();
    }
  } finally {
    await run("docker", ["rm", "-f", container]).catch(() => undefined);
  }
}

await main();
