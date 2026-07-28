import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";

async function main() {
  const parsed = parseArgs({
    options: {
      through: { type: "string" },
      "staging-run-id": { type: "string" },
      "expected-host": { type: "string" },
      "expected-database": { type: "string" },
    },
    strict: true,
  });
  const through = parsed.values.through;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !through) throw new Error("DATABASE_URL and --through are required.");
  const database = new URL(databaseUrl);
  const loopback =
    ["127.0.0.1", "localhost", "::1"].includes(database.hostname) &&
    database.pathname.slice(1).startsWith("mission_control_replacement_disposable_");
  const staging =
    process.env.MC_V1_STAGING_ISOLATION === "required" &&
    /^[a-z0-9][a-z0-9-]{7,15}$/.test(parsed.values["staging-run-id"] ?? "") &&
    database.hostname === parsed.values["expected-host"] &&
    database.pathname.slice(1) === parsed.values["expected-database"] &&
    database.hostname.startsWith(`mission-control-v1-staging-${parsed.values["staging-run-id"]}-postgres.`) &&
    database.pathname.slice(1) ===
      `mission_control_v1_staging_${parsed.values["staging-run-id"]?.replaceAll("-", "_")}_upgrade`;
  if (!loopback && !staging)
    throw new Error("Partial migration rehearsal only supports a loopback disposable database.");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum_sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const directory = resolve("db/migrations");
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".sql") && name.slice(0, 4) <= through)
      .sort();
    if (!names.length || !names.at(-1)?.startsWith(through))
      throw new Error("Requested disposable migration boundary does not exist.");
    for (const name of names) {
      const sql = await readFile(resolve(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name,checksum_sha256) VALUES($1,$2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    process.stdout.write(
      `${JSON.stringify({ event: "disposable_migration_boundary_ready", through, count: names.length })}\n`,
    );
  } finally {
    await client.end();
  }
}

void main();
