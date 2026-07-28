import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);
const port = 55447;
const container = `mc-v1-migration-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const rootUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
const emptyDatabase = "mission_control_v1_empty";
const upgradeDatabase = "mission_control_replacement_disposable_v1_upgrade";
const invariantDatabase = "mission_control_replacement_disposable_v1_invariants";
const roleBoundaryDatabase = "mission_control_replacement_disposable_v1_role_boundary";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, args, env = {}) =>
  exec(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
const url = (database) => `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;

async function ready() {
  let consecutive = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
      const probe = new pg.Client({ connectionString: rootUrl });
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      consecutive += 1;
      if (consecutive >= 3) return;
    } catch {
      consecutive = 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Disposable PostgreSQL did not become ready.");
}

async function migrate(databaseUrl) {
  return run("npm", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
}

async function verifyEmpty() {
  const first = await migrate(url(emptyDatabase));
  if (
    !first.stdout.includes('"migration":"0030_mission_agent_v1_production_rollout.sql"') ||
    !first.stdout.includes('"pendingMigrations":0')
  )
    throw new Error("Empty database did not migrate through 0030.");
  const second = await migrate(url(emptyDatabase));
  if (!second.stdout.includes('"pendingMigrations":0') || second.stdout.includes('"migration_applied"'))
    throw new Error("Migration runner is not idempotent.");
  const client = new pg.Client({ connectionString: url(emptyDatabase) });
  await client.connect();
  try {
    const count = Number((await client.query("SELECT count(*)::int count FROM schema_migrations")).rows[0].count);
    if (count !== 30) throw new Error(`Expected 30 migrations, found ${count}.`);
  } finally {
    await client.end();
  }
}

async function verifyPreexistingRoleMembershipFailsClosed() {
  await run("node", ["--import", "tsx", "scripts/apply-disposable-migrations-through.ts", "--through", "0029"], {
    DATABASE_URL: url(roleBoundaryDatabase),
  });
  const client = new pg.Client({ connectionString: rootUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE ROLE mission_control_v1_controller NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    await client.query(
      `CREATE ROLE mission_control_v1_verifier NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    await client.query(
      `CREATE ROLE mission_control_v1_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    await client.query(`CREATE ROLE mission_control_v1_unapproved_parent NOLOGIN`);
    await client.query(`GRANT mission_control_v1_unapproved_parent TO mission_control_v1_runtime`);
    await assert.rejects(() => migrate(url(roleBoundaryDatabase)), /unauthorized members|Command failed/i);
    const roleBoundaryClient = new pg.Client({ connectionString: url(roleBoundaryDatabase) });
    await roleBoundaryClient.connect();
    const applied = Number(
      (
        await roleBoundaryClient.query(
          `SELECT count(*)::int count
             FROM schema_migrations
            WHERE name='0030_mission_agent_v1_production_rollout.sql'`,
        )
      ).rows[0].count,
    );
    await roleBoundaryClient.end();
    assert.equal(applied, 0);
  } finally {
    await client.query(`REVOKE mission_control_v1_unapproved_parent FROM mission_control_v1_runtime`);
    await client.query(`DROP ROLE mission_control_v1_unapproved_parent`);
    await client.query(`DROP ROLE mission_control_v1_controller`);
    await client.query(`DROP ROLE mission_control_v1_verifier`);
    await client.query(`DROP ROLE mission_control_v1_runtime`);
    await client.end();
  }
}

async function verifyUpgradeAndInvariants() {
  await run("node", ["--import", "tsx", "scripts/apply-disposable-migrations-through.ts", "--through", "0028"], {
    DATABASE_URL: url(upgradeDatabase),
  });
  const client = new pg.Client({ connectionString: url(upgradeDatabase) });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO workspaces(id,slug,name)
       VALUES('10000000-0000-4000-8000-000000000001','v1-upgrade','V1 upgrade')`,
    );
    await client.query(
      `INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch)
       VALUES(
         '10000000-0000-4000-8000-000000000001',
         '30000000-0000-4000-8000-000000000001',
         'v1-upgrade-repository','/disposable/v1-upgrade','main'
       )`,
    );
    const before = (
      await client.query(
        `SELECT w.id,w.slug,w.name,r.repository_id,r.name repository_name,r.local_path,r.default_branch
           FROM workspaces w JOIN repositories r ON r.workspace_id=w.id
          WHERE w.id='10000000-0000-4000-8000-000000000001'`,
      )
    ).rows[0];
    const beforeChecksum = hash(JSON.stringify(before));
    const migrated = await migrate(url(upgradeDatabase));
    if (
      !migrated.stdout.includes('"migration":"0029_mission_agent_replacement_bootstrap.sql"') ||
      !migrated.stdout.includes('"migration":"0030_mission_agent_v1_production_rollout.sql"')
    )
      throw new Error("0028 upgrade did not apply exactly 0029 and 0030.");
    const after = (
      await client.query(
        `SELECT w.id,w.slug,w.name,r.repository_id,r.name repository_name,r.local_path,r.default_branch
           FROM workspaces w JOIN repositories r ON r.workspace_id=w.id
          WHERE w.id='10000000-0000-4000-8000-000000000001'`,
      )
    ).rows[0];
    if (beforeChecksum !== hash(JSON.stringify(after))) throw new Error("Representative 0028 data changed.");
    for (const table of [
      "mission_control_production_deployments",
      "mission_agent_v1_operator_identities",
      "mission_agent_v1_rollout_operations",
      "mission_agent_v1_rollback_obligations",
      "mission_agent_v1_provider_mutations",
    ]) {
      const rows = Number((await client.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count);
      if (rows !== 0) throw new Error(`Migration unexpectedly populated ${table}.`);
    }
    return beforeChecksum;
  } finally {
    await client.end();
  }
}

async function verifyDatabaseInvariants() {
  await migrate(url(invariantDatabase));
  const runtimePassword = randomBytes(24).toString("base64url");
  const clusterAdmin = new pg.Client({ connectionString: rootUrl });
  await clusterAdmin.connect();
  await clusterAdmin.query(`CREATE ROLE mission_control_v1_acceptance_runtime LOGIN PASSWORD '${runtimePassword}'`);
  await clusterAdmin.query(`GRANT mission_control_v1_runtime TO mission_control_v1_acceptance_runtime`);
  await clusterAdmin.end();
  const root = await mkdtemp(join(tmpdir(), "mission-control-v1-invariants-"));
  const prefix = join(root, "fixture");
  const executionId = "33333333-3333-4333-8333-333333333333";
  await run(
    "node",
    [
      "--import",
      "tsx",
      "scripts/setup-replacement-bootstrap-disposable-e2e.ts",
      "--output",
      prefix,
      "--mission-control-url",
      "https://127.0.0.1:3444/",
      "--resource-fingerprint",
      "f".repeat(64),
      "--execution-id",
      executionId,
    ],
    { DATABASE_URL: url(invariantDatabase) },
  );
  const pkg = JSON.parse(await readFile(`${prefix}.package.json`, "utf8"));
  const workspaceId = pkg.authorization.workspaceId;
  const authorizationId = pkg.authorization.authorizationId;
  const agentId = pkg.authorization.agentId;
  const fingerprint = pkg.authorizationFingerprint;
  const client = new pg.Client({ connectionString: url(invariantDatabase) });
  const runtimeClient = new pg.Client({
    connectionString: `postgresql://mission_control_v1_acceptance_runtime:${runtimePassword}@127.0.0.1:${port}/${invariantDatabase}`,
  });
  await client.connect();
  await runtimeClient.connect();
  const ids = {
    deployment: "50000000-0000-4000-8000-000000000001",
    config1: "50000000-0000-4000-8000-000000000002",
    config2: "50000000-0000-4000-8000-000000000003",
    config3: "50000000-0000-4000-8000-000000000004",
    config4: "50000000-0000-4000-8000-000000000005",
    operator: "50000000-0000-4000-8000-000000000006",
    operatorRelease: "50000000-0000-4000-8000-000000000022",
    host: "50000000-0000-4000-8000-000000000023",
    hostChallenge: "50000000-0000-4000-8000-000000000024",
    hostMeasurement: "50000000-0000-4000-8000-000000000025",
    hostMessage: "50000000-0000-4000-8000-000000000026",
    namespace: "50000000-0000-4000-8000-000000000007",
    obligation: "50000000-0000-4000-8000-000000000008",
    fenceMessage1: "50000000-0000-4000-8000-000000000011",
    fenceMessage2: "50000000-0000-4000-8000-000000000012",
    fenceMessage3: "50000000-0000-4000-8000-000000000020",
    fenceMessage4: "50000000-0000-4000-8000-000000000021",
    processEvidence: "50000000-0000-4000-8000-000000000013",
    heartbeatEvidence: "50000000-0000-4000-8000-000000000014",
    projectionEvidence: "50000000-0000-4000-8000-000000000015",
    smokeEvidence: "50000000-0000-4000-8000-000000000016",
    staleEvidence: "50000000-0000-4000-8000-000000000017",
    rollbackIntent: "50000000-0000-4000-8000-000000000018",
    rollbackMutation: "50000000-0000-4000-8000-000000000019",
  };
  const digest = (character) => character.repeat(64);
  try {
    for (const [forward, inverse] of [
      [["stage_artifact"], ["remove_staged_artifact"]],
      [
        ["stage_artifact", "stop_agent"],
        ["start_agent", "remove_staged_artifact"],
      ],
      [
        ["stage_artifact", "stop_agent", "install_agent"],
        ["restore_previous_version", "start_agent", "remove_staged_artifact"],
      ],
      [
        ["stage_artifact", "stop_agent", "install_agent", "install_launch_configuration"],
        ["restore_previous_launch_configuration", "restore_previous_version", "start_agent", "remove_staged_artifact"],
      ],
      [
        ["stage_artifact", "stop_agent", "install_agent", "install_launch_configuration", "start_agent"],
        [
          "stop_agent",
          "restore_previous_launch_configuration",
          "restore_previous_version",
          "start_agent",
          "remove_staged_artifact",
        ],
      ],
    ]) {
      assert.deepEqual(
        (await client.query(`SELECT mission_agent_v1_rollback_plan($1::jsonb) plan`, [JSON.stringify(forward)])).rows[0]
          .plan,
        inverse,
      );
    }
    assert.equal(
      (await client.query(`SELECT mission_agent_v1_rollback_plan('["install_agent"]'::jsonb) plan`)).rows[0].plan,
      null,
    );
    await client.query(
      `INSERT INTO mission_control_production_deployments(
        deployment_id,environment,aws_account_id,aws_region,ecs_cluster_arn,ecs_service_arn,
        ecs_deployment_id,task_definition_arn,task_arn,ecr_repository_arn,image_digest,
        task_role_arn,execution_role_arn,application_commit,build_identity_checksum,
        configuration_checksum,database_identity_checksum,attestation_checksum,attestation_expires_at
      ) VALUES($1,'production','661452835066','us-east-1','arn:aws:ecs:us-east-1:661452835066:cluster/v1',
        'arn:aws:ecs:us-east-1:661452835066:service/v1','ecs-svc/1',
        'arn:aws:ecs:us-east-1:661452835066:task-definition/v1:1',
        'arn:aws:ecs:us-east-1:661452835066:task/v1/one',
        'arn:aws:ecr:us-east-1:661452835066:repository/mission-control',$2,
        'arn:aws:iam::661452835066:role/v1-task','arn:aws:iam::661452835066:role/v1-execution',
        $3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour')`,
      [ids.deployment, `sha256:${digest("a")}`, "b".repeat(40), digest("c"), digest("d"), digest("e"), digest("f")],
    );
    for (const [index, id, predecessor, state] of [
      [1, ids.config1, null, "disabled"],
      [2, ids.config2, ids.config1, "read_only_preflight"],
      [3, ids.config3, ids.config2, "migration_ready"],
    ])
      await client.query(
        `INSERT INTO mission_control_v1_production_configurations(
          configuration_id,deployment_id,version,predecessor_id,configuration_checksum,state,evidence_checksum
        ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, ids.deployment, index, predecessor, digest(String(index)), state, digest(String(index + 4))],
      );
    await client.query(
      `INSERT INTO mission_agent_v1_operator_releases(
        release_id,protocol_version,artifact_checksum,executable_path,launch_agent_label,
        manifest_checksum,status,approved_by,approved_at
      ) VALUES($1,'1',$2,
        '/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs',
        'com.wallyweb.mission-agent.replacement-operator',$3,'approved','migration-acceptance',clock_timestamp())`,
      [ids.operatorRelease, digest("a"), digest("b")],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_host_identities(
        workspace_id,host_id,agent_id,public_key_spki,public_key_fingerprint,owner_uid,status
      ) VALUES($1,$2,$3,'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',$4,501,'active')`,
      [workspaceId, ids.host, agentId, `ed25519-spki-sha256:${digest("c")}`],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_host_challenges(
        workspace_id,challenge_id,host_id,challenge_nonce,expires_at,consumed_at,request_message_id
      ) VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes',clock_timestamp(),$5)`,
      [workspaceId, ids.hostChallenge, ids.host, digest("d"), ids.hostMessage],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_host_measurements(
        workspace_id,measurement_id,challenge_id,host_id,operator_release_id,
        startup_evidence_checksum,startup_evidence,signature,journal_generation,observed_at,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,'fixture-signature',1,
        clock_timestamp(),clock_timestamp()+interval '15 minutes')`,
      [workspaceId, ids.hostMeasurement, ids.hostChallenge, ids.host, ids.operatorRelease, digest("e")],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_operator_identities(
        workspace_id,operator_id,host_id,operator_release_id,host_measurement_id,
        agent_id,deployment_id,implementation,version,executable_checksum,
        executable_path,owner_uid,journal_schema_version,launch_agent_label,credential_id,
        verified_at,verification_checksum
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'mission-agent-replacement-operator-v1','1.0.0',$8,
        '/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs',
        501,'mission-agent-v1-operator-journal-v1','com.wallyweb.mission-agent.replacement-operator',
        $9,clock_timestamp(),$10)`,
      [
        workspaceId,
        ids.operator,
        ids.host,
        ids.operatorRelease,
        ids.hostMeasurement,
        agentId,
        ids.deployment,
        digest("a"),
        pkg.credentialId,
        digest("b"),
      ],
    );
    await client.query("BEGIN");
    await client.query("SAVEPOINT mismatched_configuration");
    await client.query(
      `INSERT INTO mission_control_v1_production_configurations(
        configuration_id,deployment_id,version,predecessor_id,configuration_checksum,state,evidence_checksum
      ) VALUES($1,$2,4,$3,$4,'canary_authorized',$5)`,
      [ids.config4, ids.deployment, ids.config3, digest("4"), digest("8")],
    );
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO mission_agent_v1_rollout_operations(
            workspace_id,authorization_id,execution_id,agent_id,operator_id,host_id,
            deployment_id,current_controller_deployment_id,configuration_id,
            authorization_fingerprint,target_artifact_checksum,prior_inventory_checksum,rollback_obligation_id,claim_generation,
            fencing_namespace,initial_fencing_epoch,operator_journal_checksum,state,forward_expires_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,
            '108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09',
            $10,$11,1,$12,1,$13,'prepared',clock_timestamp()+interval '1 hour')`,
          [
            workspaceId,
            authorizationId,
            executionId,
            agentId,
            ids.operator,
            ids.host,
            ids.deployment,
            ids.config4,
            fingerprint,
            digest("c"),
            ids.obligation,
            ids.namespace,
            digest("0"),
          ],
        ),
      /identity binding is invalid/i,
    );
    await client.query("ROLLBACK TO SAVEPOINT mismatched_configuration");
    await client.query(
      `INSERT INTO mission_control_v1_production_configurations(
        configuration_id,deployment_id,version,predecessor_id,configuration_checksum,state,evidence_checksum
      ) VALUES($1,$2,4,$3,$4,'canary_authorized',$5)`,
      [ids.config4, ids.deployment, ids.config3, digest("d"), digest("8")],
    );
    await client.query("COMMIT");
    await client.query(
      `INSERT INTO mission_agent_v1_rollout_operations(
        workspace_id,authorization_id,execution_id,agent_id,operator_id,host_id,
        deployment_id,current_controller_deployment_id,configuration_id,
        authorization_fingerprint,target_artifact_checksum,prior_inventory_checksum,rollback_obligation_id,claim_generation,
        fencing_namespace,initial_fencing_epoch,operator_journal_checksum,state,forward_expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,
        '108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09',
        $10,$11,1,$12,1,$13,'prepared',clock_timestamp()+interval '1 hour')`,
      [
        workspaceId,
        authorizationId,
        executionId,
        agentId,
        ids.operator,
        ids.host,
        ids.deployment,
        ids.config4,
        fingerprint,
        digest("c"),
        ids.obligation,
        ids.namespace,
        digest("0"),
      ],
    );
    assert.equal(
      Number(
        (
          await client.query("SELECT advance_mission_agent_v1_fencing_epoch($1,$2,$3,$4,$5,$6,$7,$8,$9) epoch", [
            workspaceId,
            authorizationId,
            executionId,
            ids.namespace,
            0,
            "arn:aws:ecs:us-east-1:661452835066:task/v1/one",
            ids.fenceMessage1,
            "fence-nonce-1",
            digest("f"),
          ])
        ).rows[0].epoch,
      ),
      1,
    );
    await assert.rejects(
      () =>
        client.query("SELECT advance_mission_agent_v1_fencing_epoch($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          workspaceId,
          authorizationId,
          executionId,
          ids.namespace,
          0,
          "arn:aws:ecs:us-east-1:661452835066:task/v1/one",
          ids.fenceMessage2,
          "fence-nonce-2",
          digest("0"),
        ]),
      /evidence is invalid/i,
    );
    await client.query("SET ROLE mission_control_v1_verifier");
    try {
      await assert.rejects(
        () =>
          client.query("SELECT advance_mission_agent_v1_fencing_epoch($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
            workspaceId,
            authorizationId,
            executionId,
            ids.namespace,
            1,
            "arn:aws:ecs:us-east-1:661452835066:task/v1/one",
            ids.fenceMessage2,
            "fence-nonce-2",
            digest("f"),
          ]),
        /permission denied/i,
      );
    } finally {
      await client.query("RESET ROLE");
    }
    await assert.rejects(
      () =>
        client.query("SELECT advance_mission_agent_v1_fencing_epoch($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          workspaceId,
          authorizationId,
          executionId,
          ids.namespace,
          0,
          "arn:aws:ecs:us-east-1:661452835066:task/v1/one",
          ids.fenceMessage2,
          "fence-nonce-2",
          digest("f"),
        ]),
      /compare-and-set failed/i,
    );
    const competingClient = new pg.Client({ connectionString: url(invariantDatabase) });
    await competingClient.connect();
    const contenders = await Promise.allSettled([
      client.query("SELECT advance_mission_agent_v1_fencing_epoch($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        workspaceId,
        authorizationId,
        executionId,
        ids.namespace,
        1,
        "arn:aws:ecs:us-east-1:661452835066:task/v1/one",
        ids.fenceMessage3,
        "fence-nonce-3",
        digest("f"),
      ]),
      competingClient.query("SELECT advance_mission_agent_v1_fencing_epoch($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        workspaceId,
        authorizationId,
        executionId,
        ids.namespace,
        1,
        "arn:aws:ecs:us-east-1:661452835066:task/v1/one",
        ids.fenceMessage4,
        "fence-nonce-4",
        digest("f"),
      ]),
    ]);
    await competingClient.end();
    assert.equal(contenders.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(contenders.filter(({ status }) => status === "rejected").length, 1);
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO mission_agent_v1_fencing_epochs(
            workspace_id,authorization_id,execution_id,fencing_namespace,epoch,predecessor_epoch,
            controller_identity,request_message_id,request_nonce,evidence_checksum
          ) VALUES($1,$2,$3,$4,4,3,'wrong','50000000-0000-4000-8000-000000000022','bad-nonce',$5)`,
          [workspaceId, authorizationId, executionId, ids.namespace, digest("e")],
        ),
      /successor|foreign key/i,
    );
    const transitionFixture = async (action, expectedState, expectedSequence, extra = {}) => {
      const payload = {
        authorizationFingerprint: fingerprint,
        expectedState,
        expectedSequence,
        fencingGeneration: 2,
        eventId: randomUUID(),
        ...extra,
      };
      return client.query(
        `SELECT execute_mission_agent_v1_handler(
          $1,$2,$3,$4,$5,'claim',$6,$7::jsonb,$8,$9,$10
        ) result`,
        [
          workspaceId,
          pkg.credentialId,
          agentId,
          authorizationId,
          executionId,
          action,
          JSON.stringify(payload),
          randomUUID(),
          `fixture-${action}-${expectedSequence}`,
          hash(String(expectedSequence + 1)),
        ],
      );
    };
    await transitionFixture("preflight", "prepared", 0);
    await transitionFixture("request_drain", "preflight_verified", 1);
    await transitionFixture("verify_drain", "drain_requested", 2, { drainEvidenceChecksum: digest("f") });
    await transitionFixture("acquire_lease", "drained_verified", 3);
    const operationId = "50000000-0000-4000-8000-000000000009";
    const grantId = "50000000-0000-4000-8000-00000000002a";
    const providerMutationId = "50000000-0000-4000-8000-00000000000b";
    const grantBytes = JSON.stringify({ grantId, operation: "stage_artifact", operationId, providerMutationId });
    const executeFixture = async (handler, action, expectedState, expectedSequence, extra = {}) => {
      const payload = {
        authorizationFingerprint: fingerprint,
        expectedState,
        expectedSequence,
        fencingGeneration: 2,
        eventId: randomUUID(),
        ...extra,
      };
      return client.query(
        `SELECT execute_mission_agent_v1_handler(
          $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11
        ) result`,
        [
          workspaceId,
          pkg.credentialId,
          agentId,
          authorizationId,
          executionId,
          handler,
          action,
          JSON.stringify(payload),
          randomUUID(),
          `fixture-${handler}-${action}-${expectedSequence}`,
          hash(String(expectedSequence + 1)),
        ],
      );
    };
    await executeFixture("intent", "propose_grant", "forward_active", 4, {
      grantId,
      grantKind: "forward",
      operationId,
      providerMutationId,
      operation: "stage_artifact",
      operationSequence: 1,
      grantChecksum: hash(grantBytes),
      grantBytes,
      grantExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    await executeFixture("status", "record_grant_delivery", "grant_issued", 5, {
      grantId,
      grantChecksum: hash(grantBytes),
    });
    await executeFixture("status", "acknowledge_grant", "grant_delivered", 6, {
      grantId,
      grantChecksum: hash(grantBytes),
      acknowledgementChecksum: digest("5"),
      hostSignature: "migration-fixture-host-signature",
      operatorJournalChecksum: digest("6"),
    });
    await executeFixture("intent", "commit_mutation_intent", "grant_acknowledged", 7, {
      grantId,
      operationId,
      operation: "stage_artifact",
      fixedArgumentsChecksum: digest("1"),
      expectedPreconditionChecksum: digest("2"),
      expectedPostconditionChecksum: digest("3"),
      fromState: "ready",
      toState: "staged",
      intentChecksum: digest("4"),
    });
    const operatorRequestMessageId = randomUUID();
    await executeFixture("status", "operator_journal_head", "mutation_intent_committed", 8, {
      grantId,
      operatorRequestChecksum: digest("7"),
      operatorRequestMessageId,
      operatorRequestNonce: "operator-stage-request",
      operatorJournalChecksum: digest("8"),
    });
    const receiptBytes = JSON.stringify({ providerMutationId, result: "staged" });
    await executeFixture("receipt", "accept_provider_receipt", "awaiting_provider_receipt", 9, {
      grantId,
      providerMutationId,
      operation: "stage_artifact",
      priorStateChecksum: digest("9"),
      resultingStateChecksum: digest("a"),
      localJournalEntryId: randomUUID(),
      executedAt: new Date().toISOString(),
      operatorRequestMessageId,
      operatorRequestNonce: "operator-stage-request",
      priorOperatorJournalChecksum: digest("8"),
      operatorJournalChecksum: digest("8"),
      receiptBytes,
      receiptChecksum: hash(receiptBytes),
      authenticatedReceiptTag: digest("b"),
      verificationEvidenceChecksum: digest("c"),
      outcome: "succeeded",
      hostSignature: "migration-fixture-host-signature",
    });
    await executeFixture("decision", "verify_provider_receipt", "provider_receipt_accepted", 10);
    await executeFixture("decision", "continue_forward", "verifying", 11);
    let lifecycleSequence = 12;
    for (const [operationSequence, operation] of [
      [2, "stop_agent"],
      [3, "install_agent"],
      [4, "install_launch_configuration"],
      [5, "start_agent"],
    ]) {
      const nextOperationId = randomUUID();
      const nextMutationId = randomUUID();
      const nextGrantId = randomUUID();
      const nextGrantBytes = JSON.stringify({
        grantId: nextGrantId,
        operation,
        operationId: nextOperationId,
        providerMutationId: nextMutationId,
      });
      await executeFixture("intent", "propose_grant", "forward_active", lifecycleSequence, {
        grantId: nextGrantId,
        grantKind: "forward",
        operationId: nextOperationId,
        providerMutationId: nextMutationId,
        operation,
        operationSequence,
        grantChecksum: hash(nextGrantBytes),
        grantBytes: nextGrantBytes,
        grantExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      await executeFixture("status", "record_grant_delivery", "grant_issued", lifecycleSequence + 1, {
        grantId: nextGrantId,
        grantChecksum: hash(nextGrantBytes),
      });
      await executeFixture("status", "acknowledge_grant", "grant_delivered", lifecycleSequence + 2, {
        grantId: nextGrantId,
        grantChecksum: hash(nextGrantBytes),
        acknowledgementChecksum: hash(String(operationSequence)),
        hostSignature: "migration-fixture-host-signature",
        operatorJournalChecksum: hash(String(operationSequence + 5)),
      });
      await executeFixture("intent", "commit_mutation_intent", "grant_acknowledged", lifecycleSequence + 3, {
        grantId: nextGrantId,
        operationId: nextOperationId,
        operation,
        fixedArgumentsChecksum: digest("1"),
        expectedPreconditionChecksum: digest("2"),
        expectedPostconditionChecksum: digest("3"),
        fromState: `before-${operation}`,
        toState: `after-${operation}`,
        intentChecksum: hash(`${operation}:intent`),
      });
      const nextOperatorRequestMessageId = randomUUID();
      await executeFixture("status", "operator_journal_head", "mutation_intent_committed", lifecycleSequence + 4, {
        grantId: nextGrantId,
        operatorRequestChecksum: hash(`${operation}:request`),
        operatorRequestMessageId: nextOperatorRequestMessageId,
        operatorRequestNonce: `${operation}-request`,
        operatorJournalChecksum: hash(`${operation}:journal`),
      });
      const nextReceiptBytes = JSON.stringify({ providerMutationId: nextMutationId, result: "succeeded" });
      await executeFixture("receipt", "accept_provider_receipt", "awaiting_provider_receipt", lifecycleSequence + 5, {
        grantId: nextGrantId,
        providerMutationId: nextMutationId,
        operation,
        priorStateChecksum: hash(`${operation}:before`),
        resultingStateChecksum: hash(`${operation}:after`),
        localJournalEntryId: randomUUID(),
        executedAt: new Date().toISOString(),
        operatorRequestMessageId: nextOperatorRequestMessageId,
        operatorRequestNonce: `${operation}-request`,
        priorOperatorJournalChecksum: hash(`${operation}:journal`),
        operatorJournalChecksum: hash(`${operation}:journal`),
        receiptBytes: nextReceiptBytes,
        receiptChecksum: hash(nextReceiptBytes),
        authenticatedReceiptTag: hash(`${operation}:receipt-tag`),
        verificationEvidenceChecksum: hash(`${operation}:verification`),
        outcome: "succeeded",
        hostSignature: "migration-fixture-host-signature",
      });
      await executeFixture("decision", "verify_provider_receipt", "provider_receipt_accepted", lifecycleSequence + 6);
      const finalMutation = operationSequence === 5;
      await executeFixture(
        "decision",
        finalMutation ? "observe_stability" : "continue_forward",
        "verifying",
        lifecycleSequence + 7,
      );
      lifecycleSequence += 8;
    }
    const evidenceReceipts = [
      ["process", "verify_process", ids.processEvidence, { status: "running" }, 101],
      ["heartbeat-capability", "collect_heartbeats", ids.heartbeatEvidence, { count: 3, compatible: true }, 102],
      ["projection", "verify_projection", ids.projectionEvidence, { replay: "equal" }, 103],
      ["smoke", "read_only_smoke", ids.smokeEvidence, { mode: "read-only", result: "pass" }, 104],
    ];
    for (const [type, operation, evidenceOperationId, evidence, sequence] of evidenceReceipts) {
      await client.query(
        `INSERT INTO mission_agent_replacement_receipts(
          workspace_id,authorization_id,execution_id,operation_id,credential_id,agent_id,
          provider_identifier,authorization_fingerprint,claim_generation,sequence,request_nonce,
          receipt_nonce,operation,operation_checksum,result_checksum,host_journal_checksum,
          authentication_tag,received_at,acknowledgement
        ) VALUES($1,$2,$3,$4,$5,$6,'disposable-v1-verifier',$7,1,$8,$9,$10,$11,$12,
          encode(digest(convert_to(($13::jsonb)::text,'UTF8'),'sha256'),'hex'),$14,$15,
          clock_timestamp(),jsonb_build_object('evidence_type',$16::text,'evidence',$13::jsonb))`,
        [
          workspaceId,
          authorizationId,
          executionId,
          evidenceOperationId,
          pkg.credentialId,
          agentId,
          fingerprint,
          sequence,
          `v1-evidence-request-${sequence}`,
          `v1-evidence-receipt-${sequence}`,
          operation,
          hash(String(sequence)),
          JSON.stringify(evidence),
          digest("9"),
          hash(String(sequence)),
          type,
        ],
      );
    }
    await client.query(
      `INSERT INTO mission_agent_replacement_receipts(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,agent_id,
        provider_identifier,authorization_fingerprint,claim_generation,sequence,request_nonce,
        receipt_nonce,operation,operation_checksum,result_checksum,host_journal_checksum,
        authentication_tag,received_at,acknowledgement
      ) VALUES($1,$2,$3,$4,$5,$6,'disposable-v1-verifier',$7,1,105,
        'v1-evidence-request-stale','v1-evidence-receipt-stale','verify_process',$8,
        encode(digest(convert_to(('{"status":"running"}'::jsonb)::text,'UTF8'),'sha256'),'hex'),
        $9,$10,clock_timestamp()-interval '1 hour','{"evidence_type":"process"}'::jsonb)`,
      [
        workspaceId,
        authorizationId,
        executionId,
        ids.staleEvidence,
        pkg.credentialId,
        agentId,
        fingerprint,
        digest("6"),
        digest("9"),
        digest("6"),
      ],
    );
    await assert.rejects(
      () =>
        client.query(
          `UPDATE mission_agent_replacement_mutation_intents SET operation='restore_previous_version'
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND operation_id=$4`,
          [workspaceId, authorizationId, executionId, operationId],
        ),
      /immutable/i,
    );
    await assert.rejects(
      () =>
        client.query(
          `UPDATE mission_agent_v1_rollback_obligations
              SET state='verified_closed',closed_at=clock_timestamp(),closure_outcome='rollback_verified',
                  closure_evidence_checksum=$5
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND obligation_id=$4`,
          [workspaceId, authorizationId, executionId, ids.obligation, digest("a")],
        ),
      /canonical evidence|receipt/i,
    );
    await assert.rejects(
      () =>
        client.query(
          `DELETE FROM mission_agent_v1_rollback_obligations
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND obligation_id=$4`,
          [workspaceId, authorizationId, executionId, ids.obligation],
        ),
      /cannot be deleted/i,
    );
    await assert.rejects(
      () =>
        runtimeClient.query(
          `INSERT INTO mission_agent_v1_verified_evidence(
              workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
              producer_operation_id,authenticated_receipt_tag,observed_at,expires_at
            ) VALUES($1,$2,$3,'process',$4,'{}'::jsonb,$5,$6,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,
          [workspaceId, authorizationId, executionId, digest("f"), operationId, digest("a")],
        ),
      /permission denied/i,
    );
    await assert.rejects(
      () =>
        runtimeClient.query(
          `INSERT INTO mission_agent_v1_closure_evidence(
              workspace_id,authorization_id,execution_id,outcome,evidence_checksum,process_checksum,
              heartbeat_checksum,capability_checksum,projection_checksum,inventory_checksum,
              evidence_bytes,verified_at
            ) VALUES($1,$2,$3,'success_verified',$4,$4,$4,$4,$4,$4,'forged',clock_timestamp())`,
          [workspaceId, authorizationId, executionId, digest("f")],
        ),
      /permission denied/i,
    );
    await client.query("SET ROLE mission_control_v1_controller");
    try {
      await assert.rejects(
        () =>
          client.query(
            `UPDATE mission_agent_v1_rollout_operations SET state='human_intervention_required'
              WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
            [workspaceId, authorizationId, executionId],
          ),
        /permission denied/i,
      );
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO mission_agent_v1_lifecycle_events(
              workspace_id,authorization_id,execution_id,event_id,sequence,handler,action,
              from_state,to_state,fencing_generation,request_message_id,request_nonce,
              event_checksum,audit_reference
            ) VALUES($1,$2,$3,$4,999,'failure','require_human_intervention',
              'observing','human_intervention_required',2,$5,'forged',$6,'forged')`,
            [workspaceId, authorizationId, executionId, randomUUID(), randomUUID(), digest("f")],
          ),
        /permission denied/i,
      );
      await assert.rejects(
        () =>
          client.query(
            `SELECT advance_mission_agent_v1_lifecycle(
              $1,$2,$3,'failure','require_human_intervention','observing',44,2,
              '{}'::jsonb,$4,$5,'forged','forged'
            )`,
            [workspaceId, authorizationId, executionId, randomUUID(), randomUUID()],
          ),
        /permission denied/i,
      );
      await assert.rejects(
        () =>
          client.query(
            `SELECT execute_mission_agent_v1_handler(
              $1,$2,$3,$4,$5,'claim','preflight',$6::jsonb,$7,'controller-boundary',$8
            )`,
            [
              workspaceId,
              pkg.credentialId,
              agentId,
              authorizationId,
              executionId,
              JSON.stringify({
                authorizationFingerprint: digest("f"),
                expectedState: "prepared",
                expectedSequence: 0,
                fencingGeneration: 2,
                eventId: randomUUID(),
              }),
              randomUUID(),
              digest("e"),
            ],
          ),
        /identity|contradictory/i,
      );
    } finally {
      await client.query("RESET ROLE");
    }
    await client.query("SET ROLE mission_control_v1_verifier");
    const verifiedChecksums = {};
    try {
      await assert.rejects(
        () =>
          client.query(
            `SELECT record_mission_agent_v1_verified_evidence(
              $1,$2,$3,'process','{"status":"running"}'::jsonb,$4,$5,
              clock_timestamp(),clock_timestamp()+interval '5 minutes'
            )`,
            [workspaceId, authorizationId, executionId, operationId, digest("0")],
          ),
        /not bound to its authenticated producer receipt/i,
      );
      await assert.rejects(
        () =>
          client.query(
            `SELECT record_mission_agent_v1_verified_evidence(
              $1,$2,$3,'process','{"status":"running"}'::jsonb,$4,$5,
              clock_timestamp(),clock_timestamp()+interval '5 minutes'
            )`,
            [workspaceId, authorizationId, executionId, ids.staleEvidence, digest("6")],
          ),
        /not bound to its authenticated producer receipt/i,
      );
      for (const [type, , evidenceOperationId, evidence, sequence] of evidenceReceipts) {
        verifiedChecksums[type] = (
          await client.query(
            `SELECT record_mission_agent_v1_verified_evidence(
              $1,$2,$3,$4,$5::jsonb,$6,$7,clock_timestamp(),clock_timestamp()+interval '5 minutes'
            ) AS checksum`,
            [
              workspaceId,
              authorizationId,
              executionId,
              type,
              JSON.stringify(evidence),
              evidenceOperationId,
              hash(String(sequence)),
            ],
          )
        ).rows[0].checksum;
      }
    } finally {
      await client.query("RESET ROLE");
    }
    const recoveryDeployment = randomUUID();
    await client.query(
      `INSERT INTO mission_control_production_deployments(
        deployment_id,environment,aws_account_id,aws_region,ecs_cluster_arn,ecs_service_arn,
        ecs_deployment_id,task_definition_arn,task_arn,ecr_repository_arn,image_digest,
        task_role_arn,execution_role_arn,application_commit,build_identity_checksum,
        configuration_checksum,database_identity_checksum,attestation_checksum,attestation_expires_at
      ) SELECT $1,environment,aws_account_id,aws_region,ecs_cluster_arn,ecs_service_arn,
        'ecs-svc/recovery','arn:aws:ecs:us-east-1:661452835066:task-definition/v1:2',
        'arn:aws:ecs:us-east-1:661452835066:task/v1/recovery',ecr_repository_arn,image_digest,
        task_role_arn,execution_role_arn,application_commit,build_identity_checksum,
        configuration_checksum,database_identity_checksum,$2,clock_timestamp()+interval '1 hour'
        FROM mission_control_production_deployments WHERE deployment_id=$3`,
      [recoveryDeployment, hash("recovery-attestation"), ids.deployment],
    );
    await client.query("SET ROLE mission_control_v1_controller");
    try {
      assert.equal(
        Number(
          (
            await client.query(`SELECT adopt_mission_agent_v1_recovery_controller($1,$2,$3,$4,2,$5,$6,$7) generation`, [
              workspaceId,
              authorizationId,
              executionId,
              recoveryDeployment,
              randomUUID(),
              "recovery-controller-adoption",
              hash("recovery-attestation"),
            ])
          ).rows[0].generation,
        ),
        3,
      );
    } finally {
      await client.query("RESET ROLE");
    }
    await assert.rejects(
      () =>
        executeFixture("decision", "close_success", "observing", lifecycleSequence, {
          processChecksum: verifiedChecksums.process,
          heartbeatChecksum: verifiedChecksums["heartbeat-capability"],
          projectionChecksum: verifiedChecksums.projection,
          inventoryChecksum: verifiedChecksums.smoke,
        }),
      /fence|contradictory/i,
    );
    const closure = await executeFixture("decision", "close_success", "observing", lifecycleSequence, {
      fencingGeneration: 3,
      processChecksum: verifiedChecksums.process,
      heartbeatChecksum: verifiedChecksums["heartbeat-capability"],
      projectionChecksum: verifiedChecksums.projection,
      inventoryChecksum: verifiedChecksums.smoke,
    });
    assert.match(closure.rows[0].result.eventChecksum, /^[a-f0-9]{64}$/);
    assert.equal(
      (
        await client.query(
          `SELECT state FROM mission_agent_v1_rollout_operations
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
          [workspaceId, authorizationId, executionId],
        )
      ).rows[0].state,
      "success_verified",
    );
  } finally {
    await runtimeClient.end();
    await client.end();
    const cleanupAdmin = new pg.Client({ connectionString: rootUrl });
    await cleanupAdmin.connect();
    await cleanupAdmin.query(`REVOKE mission_control_v1_runtime FROM mission_control_v1_acceptance_runtime`);
    await cleanupAdmin.query(`DROP ROLE mission_control_v1_acceptance_runtime`);
    await cleanupAdmin.end();
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await run("docker", [
    "run",
    "--name",
    container,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-p",
    `127.0.0.1:${port}:5432`,
    "-d",
    "postgres:17-alpine",
  ]);
  await ready();
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${emptyDatabase}`);
    await root.query(`CREATE DATABASE ${upgradeDatabase}`);
    await root.query(`CREATE DATABASE ${invariantDatabase}`);
    await root.query(`CREATE DATABASE ${roleBoundaryDatabase}`);
  } finally {
    await root.end();
  }
  await verifyPreexistingRoleMembershipFailsClosed();
  await verifyEmpty();
  const dataChecksum = await verifyUpgradeAndInvariants();
  await verifyDatabaseInvariants();
  process.stdout.write(
    `${JSON.stringify({
      result: "pass",
      emptyDatabase: "0001-0030",
      upgrade: "0028-0030",
      dataPreserved: true,
      databaseInvariants: true,
      dataChecksum,
      productionContacted: false,
    })}\n`,
  );
} catch (error) {
  const databaseLogs = await run("docker", ["logs", "--tail", "80", container]).catch(() => ({
    stdout: "",
    stderr: "",
  }));
  process.stderr.write(
    `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.stack ?? error}\n${databaseLogs.stdout}${databaseLogs.stderr}`,
  );
  process.exitCode = 1;
} finally {
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
}
