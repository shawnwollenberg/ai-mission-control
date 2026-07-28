import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import pg from "pg";
import { assertV1StagingBootstrapManifestDigest } from "../application/v1-staging-bootstrap-manifest.ts";

const exec = promisify(execFile);
const options = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    manifest: { type: "string" },
    "manifest-digest": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
}).values;
for (const name of ["profile", "region", "manifest", "manifest-digest", "output"])
  if (!options[name]) throw new Error(`--${name} is required.`);
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
assertV1StagingBootstrapManifestDigest(manifest, options["manifest-digest"]);
if (manifest.region !== options.region)
  throw new Error("Database preparation region contradicts the bootstrap manifest.");
const prefix = `mission-control-v1-staging-${manifest.runId}`;
const adminSecret = manifest.resources.secrets.filter(({ name }) => name === `${prefix}-database-admin`);
const runtimeSecret = manifest.resources.secrets.filter(({ name }) => name === `${prefix}-runtime`);
if (adminSecret.length !== 1 || runtimeSecret.length !== 1)
  throw new Error("Exact bootstrap database secrets are absent.");
const aws = async (args) =>
  JSON.parse(
    (
      await exec("aws", [
        "--profile",
        options.profile,
        "--region",
        options.region,
        "--no-cli-pager",
        ...args,
        "--output",
        "json",
      ])
    ).stdout,
  );
const caller = await aws(["sts", "get-caller-identity"]);
const database = (
  await aws(["rds", "describe-db-instances", "--db-instance-identifier", manifest.resources.database.id])
).DBInstances?.[0];
if (
  caller.Account !== manifest.accountId ||
  !database ||
  database.DBInstanceArn !== manifest.resources.database.arn ||
  database.Endpoint?.Address !== manifest.resources.database.endpoint ||
  database.Endpoint?.Port !== 5432 ||
  database.DBName !== manifest.resources.database.databaseName ||
  database.CACertificateIdentifier !== "rds-ca-rsa2048-g1" ||
  database.DBInstanceStatus !== "available"
)
  throw new Error("Database preparation refuses contradictory RDS control-plane evidence.");
const admin = JSON.parse(
  (await aws(["secretsmanager", "get-secret-value", "--secret-id", adminSecret[0].arn])).SecretString,
);
if (
  admin.host !== database.Endpoint.Address ||
  Number(admin.port) !== 5432 ||
  admin.dbname !== database.DBName ||
  admin.username !== "mission_control_staging_admin" ||
  !admin.password
)
  throw new Error("Generated database administrator secret contradicts the exact staging database.");
const runtimePassword = randomBytes(32).toString("base64url");
const controllerPassword = randomBytes(32).toString("base64url");
const encode = encodeURIComponent;
const url = (username, password, databaseName = database.DBName) =>
  `postgresql://${encode(username)}:${encode(password)}@${database.Endpoint.Address}:5432/${databaseName}?sslmode=verify-full`;
// node-postgres lets sslmode from the URL replace the explicit ssl object,
// including its pinned CA. Direct clients therefore omit the URL parameter and
// use the explicit CA below; child processes and stored runtime URLs retain it.
const pgUrl = (username, password, databaseName = database.DBName) =>
  url(username, password, databaseName).replace("?sslmode=verify-full", "");
const scratch = await mkdtemp(join(tmpdir(), "mission-control-v1-staging-database-"));
const caPath = join(scratch, "rds-us-east-1-bundle.pem");
const runtimeSecretPath = join(scratch, "runtime-secret.json");
const run = (command, args, env = {}) =>
  exec(command, args, {
    env: { ...process.env, ...env },
    maxBuffer: 30 * 1024 * 1024,
  });
try {
  await run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem",
    "--output",
    caPath,
  ]);
  const ca = await readFile(caPath);
  if (
    createHash("sha256").update(ca).digest("hex") !== "b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77"
  )
    throw new Error("Pinned AWS RDS trust bundle checksum changed.");
  const adminUrl = url(admin.username, admin.password);
  const adminClient = new pg.Client({
    connectionString: pgUrl(admin.username, admin.password),
    ssl: { ca: ca.toString(), rejectUnauthorized: true },
  });
  await adminClient.connect();
  const server = (
    await adminClient.query(
      `SELECT current_database() database, current_user username,
              inet_server_addr()::text server_address, current_setting('ssl') ssl`,
    )
  ).rows[0];
  if (server.database !== database.DBName || server.username !== admin.username || server.ssl !== "on")
    throw new Error("Connected PostgreSQL identity contradicts staging authority.");
  const emptyDatabase = `${database.DBName}_empty`;
  const upgradeDatabase = `${database.DBName}_upgrade`;
  if (
    !/^mission_control_v1_staging_[a-z0-9_]+_empty$/.test(emptyDatabase) ||
    !/^mission_control_v1_staging_[a-z0-9_]+_upgrade$/.test(upgradeDatabase)
  )
    throw new Error("Disposable rehearsal database name is unsafe.");
  await adminClient.query(`DROP DATABASE IF EXISTS ${emptyDatabase} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${emptyDatabase}`);
  await adminClient.query(`DROP DATABASE IF EXISTS ${upgradeDatabase} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${upgradeDatabase}`);
  await adminClient.end();
  const migrationEnv = { NODE_EXTRA_CA_CERTS: caPath };
  const emptyUrl = url(admin.username, admin.password, emptyDatabase);
  const first = await run("npm", ["run", "db:migrate"], { ...migrationEnv, DATABASE_URL: emptyUrl });
  const second = await run("npm", ["run", "db:migrate"], { ...migrationEnv, DATABASE_URL: emptyUrl });
  const primaryMigration = await run("npm", ["run", "db:migrate"], {
    ...migrationEnv,
    DATABASE_URL: adminUrl,
  });
  if (
    !first.stdout.includes('"migration":"0030_mission_agent_v1_production_rollout.sql"') ||
    !first.stdout.includes('"pendingMigrations":0') ||
    !second.stdout.includes('"pendingMigrations":0') ||
    second.stdout.includes('"migration_applied"') ||
    !primaryMigration.stdout.includes('"pendingMigrations":0')
  )
    throw new Error("Empty staging database migration or idempotent rerun failed.");
  const upgradeUrl = url(admin.username, admin.password, upgradeDatabase);
  await run(
    "node",
    [
      "--import",
      "tsx",
      "scripts/apply-disposable-migrations-through.ts",
      "--through",
      "0028",
      "--staging-run-id",
      manifest.runId,
      "--expected-host",
      database.Endpoint.Address,
      "--expected-database",
      upgradeDatabase,
    ],
    {
      ...migrationEnv,
      MC_V1_STAGING_ISOLATION: "required",
      DATABASE_URL: upgradeUrl,
    },
  );
  const upgradeClient = new pg.Client({
    connectionString: pgUrl(admin.username, admin.password, upgradeDatabase),
    ssl: { ca: ca.toString(), rejectUnauthorized: true },
  });
  await upgradeClient.connect();
  await upgradeClient.query(
    `INSERT INTO workspaces(id,slug,name)
     VALUES('10000000-0000-4000-8000-000000000001','v1-staging-upgrade','V1 staging upgrade')`,
  );
  const before = JSON.stringify(
    (await upgradeClient.query(`SELECT id,slug,name FROM workspaces WHERE slug='v1-staging-upgrade'`)).rows[0],
  );
  await upgradeClient.end();
  const upgraded = await run("npm", ["run", "db:migrate"], {
    ...migrationEnv,
    DATABASE_URL: upgradeUrl,
  });
  if (
    !upgraded.stdout.includes('"migration":"0029_mission_agent_replacement_bootstrap.sql"') ||
    !upgraded.stdout.includes('"migration":"0030_mission_agent_v1_production_rollout.sql"')
  )
    throw new Error("Supported 0028 to 0030 rehearsal failed.");
  const verifyClient = new pg.Client({
    connectionString: pgUrl(admin.username, admin.password, upgradeDatabase),
    ssl: { ca: ca.toString(), rejectUnauthorized: true },
  });
  await verifyClient.connect();
  const after = JSON.stringify(
    (await verifyClient.query(`SELECT id,slug,name FROM workspaces WHERE slug='v1-staging-upgrade'`)).rows[0],
  );
  await verifyClient.end();
  if (before !== after) throw new Error("0028 to 0030 rehearsal changed representative data.");
  const primary = new pg.Client({
    connectionString: pgUrl(admin.username, admin.password),
    ssl: { ca: ca.toString(), rejectUnauthorized: true },
  });
  await primary.connect();
  if (!/^[A-Za-z0-9_-]+$/.test(runtimePassword) || !/^[A-Za-z0-9_-]+$/.test(controllerPassword))
    throw new Error("Generated database credentials are not safe SQL literals.");
  await primary.query(
    `CREATE ROLE mission_control_v1_staging_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${runtimePassword}'`,
  );
  await primary.query(
    `CREATE ROLE mission_control_v1_staging_controller LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${controllerPassword}'`,
  );
  await primary.query(`GRANT mission_control_v1_runtime TO mission_control_v1_staging_runtime`);
  await primary.query(`GRANT mission_control_v1_controller TO mission_control_v1_staging_controller`);
  await primary.query(`GRANT CONNECT ON DATABASE ${database.DBName} TO mission_control_v1_staging_runtime`);
  await primary.query(`GRANT CONNECT ON DATABASE ${database.DBName} TO mission_control_v1_staging_controller`);
  await primary.query(
    `GRANT USAGE ON SCHEMA public TO mission_control_v1_staging_runtime,mission_control_v1_staging_controller`,
  );
  await primary.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO mission_control_v1_staging_runtime,mission_control_v1_staging_controller`,
  );
  await primary.query(
    `GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public
       TO mission_control_v1_staging_runtime,mission_control_v1_staging_controller`,
  );
  await primary.query(`
    DO $grant$
    DECLARE table_name text;
    BEGIN
      FOR table_name IN
        SELECT tablename FROM pg_tables
         WHERE schemaname='public'
           AND tablename <> 'schema_migrations'
           AND tablename <> ALL(ARRAY[
             'mission_agent_v1_rollout_operations','mission_agent_v1_grants',
             'mission_agent_v1_lifecycle_events','mission_agent_v1_fencing_epochs',
             'mission_agent_v1_rollback_obligations','mission_agent_v1_operator_confirmations',
             'mission_agent_v1_durable_receipt_anchors','mission_agent_v1_provider_mutations',
             'mission_agent_v1_provider_receipts','mission_agent_v1_closure_evidence',
             'mission_agent_v1_verified_evidence'
           ])
      LOOP
        EXECUTE format(
          'GRANT INSERT,UPDATE,DELETE ON TABLE public.%I TO mission_control_v1_staging_runtime,mission_control_v1_staging_controller',
          table_name
        );
      END LOOP;
    END $grant$;
  `);
  const migrationCount = Number(
    (await primary.query(`SELECT count(*)::int count FROM schema_migrations`)).rows[0].count,
  );
  await primary.end();
  if (migrationCount !== 30) throw new Error(`Expected 30 migrations, found ${migrationCount}.`);
  const runtimeClient = new pg.Client({
    connectionString: pgUrl("mission_control_v1_staging_runtime", runtimePassword),
    ssl: { ca: ca.toString(), rejectUnauthorized: true },
  });
  await runtimeClient.connect();
  await runtimeClient.query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`);
  await runtimeClient.query(`SELECT id FROM users LIMIT 0`);
  await runtimeClient.query(`SELECT job_id FROM jobs LIMIT 0`);
  await runtimeClient.query(`UPDATE jobs SET updated_at=updated_at WHERE false`);
  let directMutationDenied = false;
  try {
    await runtimeClient.query(`DELETE FROM mission_agent_v1_rollout_operations WHERE false`);
  } catch (error) {
    directMutationDenied = error?.code === "42501";
  }
  await runtimeClient.end();
  if (!directMutationDenied) throw new Error("Staging runtime role could bypass protected lifecycle tables.");
  const controllerClient = new pg.Client({
    connectionString: pgUrl("mission_control_v1_staging_controller", controllerPassword),
    ssl: { ca: ca.toString(), rejectUnauthorized: true },
  });
  await controllerClient.connect();
  const controllerCanExecute = (
    await controllerClient.query(
      `SELECT has_function_privilege(
         current_user,
         'execute_mission_agent_v1_handler(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,uuid,text,text)',
         'EXECUTE'
       ) allowed`,
    )
  ).rows[0].allowed;
  await controllerClient.end();
  if (!controllerCanExecute) throw new Error("Staging controller cannot execute the governed lifecycle boundary.");
  const existingRuntimeSecret = JSON.parse(
    (await aws(["secretsmanager", "get-secret-value", "--secret-id", runtimeSecret[0].arn])).SecretString,
  );
  const updatedSecret = {
    ...existingRuntimeSecret,
    databaseUrl: url("mission_control_v1_staging_runtime", runtimePassword),
    controllerDatabaseUrl: url("mission_control_v1_staging_controller", controllerPassword),
  };
  await writeFile(runtimeSecretPath, JSON.stringify(updatedSecret), { mode: 0o600 });
  await exec("aws", [
    "--profile",
    options.profile,
    "--region",
    options.region,
    "--no-cli-pager",
    "secretsmanager",
    "put-secret-value",
    "--secret-id",
    runtimeSecret[0].arn,
    "--secret-string",
    `file://${runtimeSecretPath}`,
    "--output",
    "json",
  ]);
  const evidence = {
    schemaVersion: "mission-control-v1-staging-database-preparation/1",
    runId: manifest.runId,
    rdsArn: database.DBInstanceArn,
    endpoint: database.Endpoint.Address,
    databaseName: database.DBName,
    caIdentifier: database.CACertificateIdentifier,
    engine: database.Engine,
    engineVersion: database.EngineVersion,
    migrationCount,
    emptyDatabaseThrough: "0030",
    idempotentRerunPending: 0,
    upgradePath: "0028-to-0030",
    representativeDataPreserved: before === after,
    runtimeRole: "mission_control_v1_staging_runtime",
    controllerRole: "mission_control_v1_staging_controller",
    directRuntimeMutationDenied: true,
    positiveRuntimeChecks: ["schema_migrations_read", "authentication_lookup", "worker_read_write"],
    governedControllerFunctionAvailable: true,
    credentialsStoredOnlyInSecret: runtimeSecret[0].arn,
  };
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ output: options.output, migrationCount, directRuntimeMutationDenied: true })}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
