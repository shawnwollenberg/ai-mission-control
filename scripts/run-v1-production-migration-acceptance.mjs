import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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
      `INSERT INTO mission_agent_v1_operator_identities(
        workspace_id,operator_id,agent_id,deployment_id,implementation,version,executable_checksum,
        executable_path,owner_uid,journal_schema_version,launch_agent_label,credential_id,
        verified_at,verification_checksum
      ) VALUES($1,$2,$3,$4,'mission-agent-replacement-operator-v1','1.0.0',$5,
        '/Users/owner/Library/Application Support/WallyWeb/MissionAgentReplacement/operator',
        501,'replacement-operator-journal-v1','com.wallyweb.mission-agent.replacement-operator',
        $6,clock_timestamp(),$7)`,
      [workspaceId, ids.operator, agentId, ids.deployment, digest("a"), pkg.credentialId, digest("b")],
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
            workspace_id,authorization_id,execution_id,agent_id,operator_id,deployment_id,configuration_id,
            authorization_fingerprint,target_artifact_checksum,prior_inventory_checksum,claim_generation,
            fencing_namespace,initial_fencing_epoch,state,forward_expires_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,
            '108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09',
            $9,1,$10,1,'prepared',clock_timestamp()+interval '1 hour')`,
          [
            workspaceId,
            authorizationId,
            executionId,
            agentId,
            ids.operator,
            ids.deployment,
            ids.config4,
            fingerprint,
            digest("c"),
            ids.namespace,
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
        workspace_id,authorization_id,execution_id,agent_id,operator_id,deployment_id,configuration_id,
        authorization_fingerprint,target_artifact_checksum,prior_inventory_checksum,claim_generation,
        fencing_namespace,initial_fencing_epoch,state,forward_expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,
        '108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09',
        $9,1,$10,1,'prepared',clock_timestamp()+interval '1 hour')`,
      [
        workspaceId,
        authorizationId,
        executionId,
        agentId,
        ids.operator,
        ids.deployment,
        ids.config4,
        fingerprint,
        digest("c"),
        ids.namespace,
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
    await client.query(
      `UPDATE mission_agent_v1_rollout_operations SET state='drain_requested'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [workspaceId, authorizationId, executionId],
    );
    await client.query(
      `UPDATE mission_agent_v1_rollout_operations SET state='drained_verified',drain_evidence_checksum=$4
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [workspaceId, authorizationId, executionId, digest("f")],
    );
    await client.query(
      `UPDATE mission_agent_v1_rollout_operations SET state='forward_active'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [workspaceId, authorizationId, executionId],
    );
    const operationId = "50000000-0000-4000-8000-000000000009";
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO mission_agent_replacement_mutation_intents(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,claim_generation,
        sequence,operation,fixed_arguments_checksum,expected_precondition_checksum,
        expected_postcondition_checksum,from_state,to_state,retry_policy,rollback_obligation,
        intent_checksum,status,created_at
      ) VALUES($1,$2,$3,$4,$5,1,1,'stage_artifact',$6,$7,$8,'ready','staged',
        'inspect-then-once',true,$9,'prepared',clock_timestamp())`,
      [
        workspaceId,
        authorizationId,
        executionId,
        operationId,
        pkg.credentialId,
        digest("1"),
        digest("2"),
        digest("3"),
        digest("4"),
      ],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_rollback_obligations(
        workspace_id,authorization_id,execution_id,obligation_id,authorization_fingerprint,
        prior_inventory_checksum,inverse_protocol,inverse_operations,opened_by_operation_id,
        opened_by_intent_checksum,state
      ) VALUES($1,$2,$3,$4,$5,$6,'mission-agent-v1-rollback-sequence-v1',$7::jsonb,$8,$9,'open')`,
      [
        workspaceId,
        authorizationId,
        executionId,
        ids.obligation,
        fingerprint,
        digest("c"),
        JSON.stringify([
          "remove_staged_artifact",
          "stop_agent",
          "restore_previous_version",
          "restore_previous_launch_configuration",
          "install_launch_configuration",
          "start_agent",
          "verify_process",
          "collect_heartbeats",
          "verify_capabilities",
          "verify_rollback",
        ]),
        operationId,
        digest("4"),
      ],
    );
    await client.query("COMMIT");
    const secondIntent = "50000000-0000-4000-8000-00000000000a";
    await client.query(
      `INSERT INTO mission_agent_replacement_mutation_intents(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,claim_generation,
        sequence,operation,fixed_arguments_checksum,expected_precondition_checksum,
        expected_postcondition_checksum,from_state,to_state,retry_policy,rollback_obligation,
        intent_checksum,status,created_at
      ) VALUES($1,$2,$3,$4,$5,1,2,'install_agent',$6,$7,$8,'staged','installed',
        'inspect-then-once',true,$9,'prepared',clock_timestamp())`,
      [
        workspaceId,
        authorizationId,
        executionId,
        secondIntent,
        pkg.credentialId,
        digest("5"),
        digest("6"),
        digest("7"),
        digest("8"),
      ],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_provider_mutations(
        workspace_id,authorization_id,execution_id,provider_mutation_id,operation_id,obligation_id,
        authorization_fingerprint,prior_inventory_checksum,phase,phase_sequence,operation,sequence,
        fencing_namespace,fencing_epoch,intent_checksum,operator_journal_checksum
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'forward',1,'stage_artifact',1,$9,2,$10,$11)`,
      [
        workspaceId,
        authorizationId,
        executionId,
        "50000000-0000-4000-8000-00000000000b",
        operationId,
        ids.obligation,
        fingerprint,
        digest("c"),
        ids.namespace,
        digest("4"),
        digest("9"),
      ],
    );
    await client.query(
      `INSERT INTO mission_agent_replacement_receipts(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,agent_id,
        provider_identifier,authorization_fingerprint,claim_generation,sequence,request_nonce,
        receipt_nonce,operation,operation_checksum,result_checksum,host_journal_checksum,
        authentication_tag,received_at,acknowledgement
      ) VALUES($1,$2,$3,$4,$5,$6,'disposable-v1-provider',$7,1,1,
        'v1-request-1','v1-receipt-1','stage_artifact',$8,$9,$10,$11,clock_timestamp(),
        '{"accepted":true}'::jsonb)`,
      [
        workspaceId,
        authorizationId,
        executionId,
        operationId,
        pkg.credentialId,
        agentId,
        fingerprint,
        digest("4"),
        digest("5"),
        digest("9"),
        digest("a"),
      ],
    );
    await client.query(
      `INSERT INTO mission_agent_v1_provider_receipts(
        workspace_id,authorization_id,execution_id,provider_mutation_id,operation_id,
        receipt_checksum,receipt_bytes,authenticated_receipt_tag,verification_evidence_checksum
      ) VALUES($1,$2,$3,$4,$5,encode(digest(convert_to($6,'UTF8'),'sha256'),'hex'),$6,$7,$8)`,
      [
        workspaceId,
        authorizationId,
        executionId,
        "50000000-0000-4000-8000-00000000000b",
        operationId,
        '{"providerMutationId":"50000000-0000-4000-8000-00000000000b","result":"staged"}',
        digest("a"),
        digest("b"),
      ],
    );
    await client.query("BEGIN");
    await client.query("SAVEPOINT wrong_rollback_plan");
    await assert.rejects(
      () =>
        client.query(
          `UPDATE mission_agent_v1_rollback_obligations
              SET state='executing',
                  required_inverse_operations='["stop_agent","restore_previous_version","start_agent"]'::jsonb,
                  rollback_plan_checksum=encode(digest(convert_to(
                    '["stop_agent","restore_previous_version","start_agent"]'::jsonb::text,
                    'UTF8'
                  ),'sha256'),'hex')
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND obligation_id=$4`,
          [workspaceId, authorizationId, executionId, ids.obligation],
        ),
      /does not match the completed forward prefix/i,
    );
    await client.query("ROLLBACK TO SAVEPOINT wrong_rollback_plan");
    await client.query(
      `UPDATE mission_agent_v1_rollback_obligations
          SET state='executing',
              required_inverse_operations='["remove_staged_artifact"]'::jsonb,
              rollback_plan_checksum=encode(digest(convert_to(
                '["remove_staged_artifact"]'::jsonb::text,'UTF8'
              ),'sha256'),'hex')
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND obligation_id=$4`,
      [workspaceId, authorizationId, executionId, ids.obligation],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT required_inverse_operations FROM mission_agent_v1_rollback_obligations
            WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND obligation_id=$4`,
          [workspaceId, authorizationId, executionId, ids.obligation],
        )
      ).rows[0].required_inverse_operations,
      ["remove_staged_artifact"],
    );
    await client.query(
      `UPDATE mission_agent_v1_rollout_operations SET state='recovery_only'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [workspaceId, authorizationId, executionId],
    );
    await client.query(
      `INSERT INTO mission_agent_replacement_mutation_intents(
        workspace_id,authorization_id,execution_id,operation_id,credential_id,claim_generation,
        sequence,operation,fixed_arguments_checksum,expected_precondition_checksum,
        expected_postcondition_checksum,from_state,to_state,retry_policy,rollback_obligation,
        intent_checksum,status,created_at
      ) VALUES($1,$2,$3,$4,$5,1,3,'remove_staged_artifact',$6,$7,$8,'staged','ready',
        'inspect-then-once',true,$9,'prepared',clock_timestamp())`,
      [
        workspaceId,
        authorizationId,
        executionId,
        ids.rollbackIntent,
        pkg.credentialId,
        digest("1"),
        digest("2"),
        digest("3"),
        digest("4"),
      ],
    );
    await client.query("SAVEPOINT wrong_rollback_operation");
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO mission_agent_v1_provider_mutations(
            workspace_id,authorization_id,execution_id,provider_mutation_id,operation_id,obligation_id,
            authorization_fingerprint,prior_inventory_checksum,phase,phase_sequence,operation,sequence,
            fencing_namespace,fencing_epoch,intent_checksum,operator_journal_checksum
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'rollback',1,'stop_agent',3,$9,2,$10,$11)`,
          [
            workspaceId,
            authorizationId,
            executionId,
            ids.rollbackMutation,
            ids.rollbackIntent,
            ids.obligation,
            fingerprint,
            digest("c"),
            ids.namespace,
            digest("4"),
            digest("9"),
          ],
        ),
      /contradictory intent|outside inverse authority/i,
    );
    await client.query("ROLLBACK TO SAVEPOINT wrong_rollback_operation");
    await client.query(
      `INSERT INTO mission_agent_v1_provider_mutations(
        workspace_id,authorization_id,execution_id,provider_mutation_id,operation_id,obligation_id,
        authorization_fingerprint,prior_inventory_checksum,phase,phase_sequence,operation,sequence,
        fencing_namespace,fencing_epoch,intent_checksum,operator_journal_checksum
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'rollback',1,'remove_staged_artifact',3,$9,2,$10,$11)`,
      [
        workspaceId,
        authorizationId,
        executionId,
        ids.rollbackMutation,
        ids.rollbackIntent,
        ids.obligation,
        fingerprint,
        digest("c"),
        ids.namespace,
        digest("4"),
        digest("9"),
      ],
    );
    assert.equal(
      Number(
        (
          await client.query(
            `SELECT count(*)::int count FROM mission_agent_v1_provider_mutations
              WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
                AND phase='rollback' AND operation='remove_staged_artifact'`,
            [workspaceId, authorizationId, executionId],
          )
        ).rows[0].count,
      ),
      1,
    );
    await client.query("ROLLBACK");
    const evidenceReceipts = [
      ["process", "verify_process", ids.processEvidence, { status: "running" }, 2],
      ["heartbeat-capability", "collect_heartbeats", ids.heartbeatEvidence, { count: 3, compatible: true }, 3],
      ["projection", "verify_projection", ids.projectionEvidence, { replay: "equal" }, 4],
      ["smoke", "read_only_smoke", ids.smokeEvidence, { mode: "read-only", result: "pass" }, 5],
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
          digest(String(sequence)),
          JSON.stringify(evidence),
          digest("9"),
          digest(String(sequence)),
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
      ) VALUES($1,$2,$3,$4,$5,$6,'disposable-v1-verifier',$7,1,6,
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
              digest(String(sequence)),
            ],
          )
        ).rows[0].checksum;
      }
    } finally {
      await client.query("RESET ROLE");
    }
    await client.query(
      `UPDATE mission_agent_v1_rollout_operations SET state='observing'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [workspaceId, authorizationId, executionId],
    );
    await client.query("SET ROLE mission_control_v1_verifier");
    try {
      const closureChecksum = (
        await client.query(
          `SELECT close_mission_agent_v1_rollout($1,$2,$3,'success_verified',$4,$5,$6,$7) AS checksum`,
          [
            workspaceId,
            authorizationId,
            executionId,
            verifiedChecksums.process,
            verifiedChecksums["heartbeat-capability"],
            verifiedChecksums.projection,
            verifiedChecksums.smoke,
          ],
        )
      ).rows[0].checksum;
      assert.match(closureChecksum, /^[a-f0-9]{64}$/);
    } finally {
      await client.query("RESET ROLE");
    }
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
  process.stderr.write(`${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
}
