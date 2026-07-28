import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);
const databasePort = 55443;
const appPort = 3411;
const httpsPort = 3444;
const databaseName = "mission_control_replacement_disposable_http_e2e";
const databaseUrl = `postgresql://postgres:e2etest@127.0.0.1:${databasePort}/${databaseName}`;
const container = `mc-replacement-http-e2e-${randomBytes(5).toString("hex")}`;
const disposableEnvironment = {
  MISSION_CONTROL_ENVIRONMENT: "disposable-test",
  MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION: "explicitly-authorized-non-production-only",
  MISSION_CONTROL_INSTANCE_ID: "mission-control-disposable-replacement-bootstrap-v1",
};
const root = await mkdtemp(join(tmpdir(), "replacement-bootstrap-disposable-http-e2e-"));
let app;
let proxy;

async function run(command, args, options = {}) {
  return exec(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function scenario(client, resourceFingerprint, name, options = {}) {
  await client.query("TRUNCATE workspaces CASCADE");
  const prefix = join(root, name);
  await run(
    "node",
    [
      "--import",
      "tsx",
      "scripts/setup-replacement-bootstrap-disposable-e2e.ts",
      "--output",
      prefix,
      "--mission-control-url",
      `https://127.0.0.1:${httpsPort}/`,
      "--resource-fingerprint",
      resourceFingerprint,
    ],
    { env: { DATABASE_URL: databaseUrl } },
  );
  const args = [
    "--import",
    "tsx",
    "scripts/run-replacement-bootstrap-disposable-e2e.ts",
    "--package",
    `${prefix}.package.json`,
    "--replacement-secret",
    `${prefix}.replacement-secret`,
    "--agent-fixture",
    `${prefix}.agent-fixture.json`,
    "--journal",
    `${prefix}.journal.json`,
    "--state",
    `${prefix}.replacement-bootstrap-disposable-state.json`,
    "--evidence",
    `${prefix}.evidence.json`,
  ];
  if (options.failAt) args.push("--fail-at", options.failAt);
  if (options.dropReceiptAfter) args.push("--drop-receipt-after", options.dropReceiptAfter);
  const execution = await run("node", args, {
    env: {
      ...disposableEnvironment,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
  });
  const summary = JSON.parse(await readFile(`${prefix}.summary.json`, "utf8"));
  const evidence = JSON.parse(await readFile(`${prefix}.evidence.json`, "utf8"));
  const provider = JSON.parse(await readFile(`${prefix}.replacement-bootstrap-disposable-state.json`, "utf8"));
  const canonical = (
    await client.query(
      `SELECT c.state,c.completed_at,b.state authorization_state,rc.consumed_at,
              p.status assignment_status,p.lease_expires_at,
              (SELECT count(*)::int FROM mission_agent_replacement_receipts r
                WHERE r.workspace_id=c.workspace_id AND r.authorization_id=c.authorization_id
                  AND r.execution_id=c.execution_id) receipt_count,
              (SELECT count(*)::int FROM mission_agent_replacement_evidence e
                WHERE e.workspace_id=c.workspace_id AND e.authorization_id=c.authorization_id
                  AND e.execution_id=c.execution_id AND e.evidence_type='smoke') smoke_count,
              (SELECT count(*)::int FROM artifacts a
                JOIN execution_projections x ON x.workspace_id=a.workspace_id AND x.execution_id=a.execution_id
                WHERE a.workspace_id=c.workspace_id AND x.mission_id IN (
                  SELECT mission_id FROM mission_projections
                  WHERE workspace_id=c.workspace_id
                    AND name='Mission Agent replacement read-only acceptance'
                ) AND a.deleted_at IS NULL) artifact_count
              ,(SELECT count(*)::int FROM outbox o
                  WHERE o.workspace_id=c.workspace_id
                    AND (o.payload->>'executionId')=p.execution_id::text) outbox_count
              ,(SELECT count(*)::int FROM jobs j
                  WHERE j.workspace_id=c.workspace_id
                    AND (j.payload->>'executionId')=p.execution_id::text) job_count
              ,(SELECT a.storage_key FROM artifacts a
                  WHERE a.workspace_id=c.workspace_id AND a.execution_id=p.execution_id
                    AND a.deleted_at IS NULL LIMIT 1) artifact_storage_key
              ,(SELECT a.checksum_sha256 FROM artifacts a
                  WHERE a.workspace_id=c.workspace_id AND a.execution_id=p.execution_id
                    AND a.deleted_at IS NULL LIMIT 1) artifact_checksum
         FROM mission_agent_replacement_execution_claims c
         JOIN mission_agent_replacement_bootstraps b
           ON b.workspace_id=c.workspace_id AND b.authorization_id=c.authorization_id
         JOIN mission_agent_replacement_credentials rc
           ON rc.workspace_id=c.workspace_id AND rc.credential_id=c.credential_id
         LEFT JOIN pull_assignments p
           ON p.workspace_id=c.workspace_id
          AND (p.payload->>'replacementExecutionId')=c.execution_id::text
        WHERE c.workspace_id=$1 AND c.execution_id=$2`,
      [summary.workspaceId, summary.executionId],
    )
  ).rows[0];
  assert.ok(canonical.completed_at);
  assert.ok(canonical.consumed_at);
  assert.equal(evidence.disposition, options.failAt ? "rolled_back" : "completed");
  assert.equal(evidence.authenticatedCredentialSubstitutionRejected, true);
  assert.equal(canonical.state, options.failAt ? "rolled-back" : "completed");
  assert.equal(canonical.authorization_state, options.failAt ? "rolled_back" : "completed");
  assert.equal(canonical.smoke_count, options.failAt ? 0 : 1);
  assert.equal(canonical.artifact_count, options.failAt ? 0 : 1);
  assert.equal(canonical.outbox_count, 0);
  assert.equal(canonical.job_count, 0);
  if (!options.failAt) {
    assert.equal(canonical.assignment_status, "completed");
    assert.equal(canonical.lease_expires_at, null);
    const artifactBytes = await readFile(join(root, "artifacts", canonical.artifact_storage_key));
    assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), canonical.artifact_checksum);
  }
  const projectionEvidence = (
    await client.query(
      `SELECT evidence_type,evidence_checksum,evidence
         FROM mission_agent_replacement_evidence
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
          AND evidence_type IN ('projection','rollback-equivalence')
        ORDER BY evidence_type`,
      [summary.workspaceId, summary.authorizationId, summary.executionId],
    )
  ).rows;
  assert.equal(projectionEvidence.length, 1);
  const projection = projectionEvidence[0].evidence;
  assert.equal(projection.liveProjectionChecksum, projection.replayedProjectionChecksum);
  assert.equal(projection.repositoryIdentitySourceChecksum, projection.repositoryIdentityEventReplayChecksum);
  if (options.failAt) {
    assert.equal(projection.projectionReplayEqual, true);
    assert.equal(projection.rollbackInventoryExact, true);
  }
  for (const operation of [
    "extract_node_runtime",
    "stop_service",
    "replace_artifact",
    "replace_plist",
    "start_service",
  ])
    assert.equal(provider.operationCounts[operation], 1, `${name}: ${operation}`);
  if (options.failAt)
    for (const operation of ["restore_artifact", "restore_plist", "restart_prior_service"])
      assert.equal(provider.operationCounts[operation], 1, `${name}: ${operation}`);
  if (options.failAt) {
    assert.equal(
      provider.currentInventoryChecksum,
      provider.priorInventoryChecksum,
      `${name}: exact inventory rollback`,
    );
    assert.equal(provider.targetArtifactActive, false);
    assert.equal(provider.targetPlistActive, false);
    assert.equal(provider.targetRunning, false);
    assert.equal(provider.priorRunning, true);
  } else {
    assert.notEqual(provider.currentInventoryChecksum, provider.priorInventoryChecksum, `${name}: host was mutated`);
  }
  assert.match(execution.stdout, /"disposition"/);
  return {
    name,
    disposition: evidence.disposition,
    evidenceChecksum: evidence.evidenceChecksum,
    receiptCount: canonical.receipt_count,
    smokeCount: canonical.smoke_count,
    artifactCount: canonical.artifact_count,
    rollbackInventoryEquivalent: options.failAt
      ? provider.currentInventoryChecksum === provider.priorInventoryChecksum
      : null,
    targetProcessAbsent: options.failAt ? !provider.targetRunning : null,
    authorizationState: canonical.authorization_state,
    claimState: canonical.state,
    credentialConsumed: canonical.consumed_at !== null,
    assignmentState: canonical.assignment_status ?? null,
    assignmentLeaseReleased: canonical.lease_expires_at === null,
    outboxCount: canonical.outbox_count,
    jobCount: canonical.job_count,
    artifactChecksum: canonical.artifact_checksum ?? null,
    projectionEvidenceChecksum: projectionEvidence[0].evidence_checksum,
    liveProjectionChecksum: projection.liveProjectionChecksum,
    replayedProjectionChecksum: projection.replayedProjectionChecksum,
    repositoryIdentitySourceChecksum: projection.repositoryIdentitySourceChecksum,
    repositoryIdentityEventReplayChecksum: projection.repositoryIdentityEventReplayChecksum,
    authenticatedCredentialSubstitutionRejected: true,
    operationCounts: provider.operationCounts,
  };
}

test(
  "actual HTTPS routes, PostgreSQL, stateful provider, leases, artifacts, recovery, and rollback",
  async () => {
    await run("docker", [
      "run",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=e2etest",
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      `127.0.0.1:${databasePort}:5432`,
      "-d",
      "postgres:17-alpine",
    ]);
    await waitFor(async () => {
      const result = await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
      return result.stdout.includes("accepting connections");
    }, "disposable PostgreSQL");
    const migrations = await run("npm", ["run", "db:migrate"], {
      env: { DATABASE_URL: databaseUrl },
    });
    assert.match(migrations.stdout, /"migration":"0029_mission_agent_replacement_bootstrap.sql"/);
    assert.match(migrations.stdout, /"pendingMigrations":0/);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          databaseHost: "127.0.0.1",
          databaseName,
          instanceIdentity: "mission-control-disposable-replacement-bootstrap-v1",
          mode: "disposable-test",
        }),
      )
      .digest("hex");
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ]);
    app = spawn("npm", ["run", "dev", "--", "-p", String(appPort)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...disposableEnvironment,
        DATABASE_URL: databaseUrl,
        MISSION_AGENT_REPLACEMENT_BOOTSTRAP_RESOURCE_FINGERPRINT: fingerprint,
        ARTIFACT_STORAGE_PROVIDER: "local",
        ARTIFACT_STORAGE_ROOT: join(root, "artifacts"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(
      async () =>
        (
          await fetch(`http://127.0.0.1:${appPort}/api/mission-agent/replacement-bootstrap/claim`, {
            method: "POST",
          })
        ).status !== 404,
      "Next.js replacement routes",
    );
    proxy = spawn(
      "node",
      ["scripts/replacement-disposable-https-proxy.mjs", String(httpsPort), String(appPort), key, cert],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const results = [];
      results.push(await scenario(client, fingerprint, "success"));
      results.push(await scenario(client, fingerprint, "rollback", { failAt: "verify_version" }));
      for (const operation of [
        "extract_node_runtime",
        "stop_service",
        "replace_artifact",
        "replace_plist",
        "start_service",
      ])
        results.push(
          await scenario(client, fingerprint, `loss-${operation}`, {
            dropReceiptAfter: operation,
          }),
        );
      for (const operation of ["restore_artifact", "restore_plist", "restart_prior_service"])
        results.push(
          await scenario(client, fingerprint, `rollback-loss-${operation}`, {
            failAt: "verify_version",
            dropReceiptAfter: operation,
          }),
        );
      const acceptanceEvidence = `${JSON.stringify(
        {
          evidenceVersion: "replacement-http-e2e-v1",
          generatedAt: new Date().toISOString(),
          sourceBaseCommit: "9abc71da235f63c6ce2e4b0197ecfdd53d3015ed",
          sourceFiles: Object.fromEntries(
            await Promise.all(
              [
                "app/api/mission-agent/replacement-bootstrap/claim/route.ts",
                "app/api/mission-agent/replacement-bootstrap/decision/route.ts",
                "app/api/mission-agent/replacement-bootstrap/failure/route.ts",
                "app/api/mission-agent/replacement-bootstrap/intent/route.ts",
                "app/api/mission-agent/replacement-bootstrap/receipt/route.ts",
                "app/api/mission-agent/replacement-bootstrap/status/route.ts",
                "application/execution-commands.ts",
                "application/mission-agent-capability-projector.ts",
                "application/pull-assignments.ts",
                "application/remote-agent-registry.ts",
                "application/replacement-bootstrap-backup.ts",
                "application/replacement-bootstrap-credential.ts",
                "db/migrations/0029_mission_agent_replacement_bootstrap.sql",
                "application/replacement-bootstrap-disposable-local.ts",
                "application/replacement-bootstrap-governance.ts",
                "application/replacement-bootstrap-local-client.ts",
                "application/replacement-bootstrap-local-journal.ts",
                "application/replacement-bootstrap-local-operator.ts",
                "application/replacement-bootstrap-macos-local.ts",
                "application/replacement-bootstrap-operator.ts",
                "application/replacement-bootstrap-postgres-session.ts",
                "application/replacement-bootstrap-safety-gate.ts",
                "application/replacement-bootstrap-smoke.ts",
                "application/replacement-bootstrap-state-machine.ts",
                "integrations/mission-agent/artifact-manifest.ts",
                "integrations/mission-agent/replacement-authorization-package.ts",
                "integrations/mission-agent/replacement-bootstrap.ts",
                "release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist",
                "release/mission-agent-0.7.2/replacement-bootstrap/launchd-service.json",
                "release/mission-agent-0.7.2/replacement-bootstrap/migration-history.json",
                "release/mission-agent-0.7.2/replacement-bootstrap/node-runtime.json",
                "release/mission-agent-0.7.2/replacement-bootstrap/postgresql-tools.json",
                "release/mission-agent-0.7.2/replacement-bootstrap/read-only-smoke-template.json",
                "release/mission-agent-0.7.2/replacement-bootstrap/rollback-0.6.8-inventory.json",
                "release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json",
                "release/schemas/mission-agent-replacement-authorization-package.schema.json",
                "release/schemas/mission-agent-replacement-bootstrap-authorization.schema.json",
                "remote-agent/replacement-bootstrap-authenticate.ts",
                "scripts/apply-disposable-migrations-through.ts",
                "scripts/mission-agent-replacement-bootstrap-local.ts",
                "scripts/replacement-disposable-https-proxy.mjs",
                "scripts/run-replacement-bootstrap-disposable-e2e.ts",
                "scripts/run-replacement-migration-acceptance.mjs",
                "scripts/setup-replacement-bootstrap-disposable-e2e.ts",
                "tests/replacement-http-e2e.test.mjs",
              ].map(async (path) => [
                path,
                createHash("sha256")
                  .update(await readFile(path))
                  .digest("hex"),
              ]),
            ),
          ),
          command: "npm run test:replacement:http-e2e",
          runtime: { node: process.version, platform: process.platform, architecture: process.arch },
          database: {
            image: "postgres:17-alpine",
            topology: "loopback-disposable",
            migrationChecksum: createHash("sha256")
              .update(await readFile("db/migrations/0029_mission_agent_replacement_bootstrap.sql"))
              .digest("hex"),
          },
          resourceFingerprint: fingerprint,
          productionContacted: false,
          namedCanaryContacted: false,
          migration: "0001-0029",
          scenarioCount: results.length,
          results,
        },
        null,
        2,
      )}\n`;
      await writeFile(join(root, "acceptance-summary.json"), acceptanceEvidence, { mode: 0o600 });
      if (process.env.REPLACEMENT_HTTP_E2E_EVIDENCE_OUTPUT) {
        await mkdir(dirname(process.env.REPLACEMENT_HTTP_E2E_EVIDENCE_OUTPUT), {
          recursive: true,
        });
        await writeFile(process.env.REPLACEMENT_HTTP_E2E_EVIDENCE_OUTPUT, acceptanceEvidence, {
          mode: 0o600,
        });
      }
      assert.equal(results.length, 10);
    } finally {
      await client.end();
    }
  },
  { timeout: 180_000 },
);

test.after(async () => {
  for (const child of [proxy, app]) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});
