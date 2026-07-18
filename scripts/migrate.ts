import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { closeDatabasePool, getDatabasePool } from "../lib/database";

const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");

async function migrate() {
  const pool = getDatabasePool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrationNames) {
    const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_296_743_201]);
      const existing = await client.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum_sha256 !== checksum) throw new Error(`Applied migration changed: ${name}`);
      } else {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum_sha256) VALUES ($1, $2)", [name, checksum]);
        console.log(JSON.stringify({ event: "migration_applied", migration: name }));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

migrate()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
