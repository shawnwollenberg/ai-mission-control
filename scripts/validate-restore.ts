import { closeDatabasePool, getDatabasePool } from "../lib/database";
async function main() {
  const db = getDatabasePool();
  await db.query("SELECT 1");
  const migrations = await db.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
  const brokenArtifacts = await db.query(
    "SELECT count(*)::int n FROM artifacts WHERE deleted_at IS NULL AND (storage_key='' OR checksum_sha256 !~ '^[0-9a-f]{64}$')",
  );
  const brokenSchedules = await db.query(
    "SELECT count(*)::int n FROM schedule_projections WHERE enabled=true AND paused=false AND deleted_at IS NULL AND next_run_at IS NULL AND schedule_rule->>'type'<>'once'",
  );
  const duplicateRuns = await db.query(
    "SELECT count(*)::int n FROM (SELECT workspace_id,schedule_id,intended_run_at,template_version,count(*) FROM schedule_run_projections GROUP BY 1,2,3,4 HAVING count(*)>1) x",
  );
  const checks = {
    database: true,
    latestMigration: migrations.rows[0]?.name,
    artifactReferences: brokenArtifacts.rows[0].n === 0,
    scheduleCoherence: brokenSchedules.rows[0].n === 0,
    duplicateScheduleRuns: duplicateRuns.rows[0].n === 0,
  };
  console.log(JSON.stringify({ event: "restore_validation", checks }));
  if (Object.values(checks).includes(false)) process.exitCode = 2;
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
