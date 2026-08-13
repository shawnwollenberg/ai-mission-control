import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { registerAgent, registerMissionAgentRepository } = await import("../application/registry.ts");
const {
  applyRepositoryIdentityProjection,
  acknowledgeRepositoryIdentityActivation,
  approveRepositoryIdentityMigration,
  MISSION_AGENT_069_CHECKSUM,
  prepareRepositoryIdentityActivation,
  previewRepositoryIdentityMigration,
  rollbackRepositoryIdentityMigration,
} = await import("../application/repository-identity.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");

const workspaceId = randomUUID();
const ownerId = randomUUID();
const agentId = randomUUID();
const legacyFingerprint = "9".repeat(64);
const registeredPath = "/registered/mission-control-acceptance-07";
const currentHead = "2".repeat(40);

after(closeDatabasePool);

test("governed migration preserves ID, path, permissions, Project Brain state, history, idempotency, and rollback", async () => {
  const pool = getDatabasePool();
  await pool.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)", [
    workspaceId,
    `identity-${workspaceId}`,
    "Identity acceptance",
  ]);
  await registerAgent({
    actor: { workspaceId, userId: ownerId, role: "owner" },
    agentId,
    name: "Migration agent",
    adapterType: "codex",
    capabilities: ["repository.read"],
    supportedDomains: ["software_delivery"],
    trustLevel: "controlled",
  });
  await pool.query(
    "UPDATE agents SET delivery_mode='pull',mission_agent_version='0.6.4' WHERE workspace_id=$1 AND agent_id=$2",
    [workspaceId, agentId],
  );
  const repository = await registerMissionAgentRepository({
    workspaceId,
    agentId,
    name: "mission-control-acceptance-07",
    fingerprint: legacyFingerprint,
    defaultBranch: "main",
    remoteUrl: "git@github.com:wallyweb/mission-control-acceptance-07.git",
    commit: currentHead,
  });
  const before = (
    await pool.query("SELECT * FROM repositories WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repository.repository_id,
    ])
  ).rows[0];

  const preview = await previewRepositoryIdentityMigration({
    workspaceId,
    agentId,
    repositoryId: repository.repository_id,
    registeredPath,
    currentHead,
    repositoryName: "mission-control-acceptance-07",
    agentLegacyFingerprint: legacyFingerprint,
    migrationToolVersion: "1",
    remotes: [
      { name: "upstream", url: "https://github.com/upstream/mission-control-acceptance-07.git" },
      { name: "origin", url: "https://GitHub.com/wallyweb/mission-control-acceptance-07.git/" },
    ],
  });
  assert.equal(preview.safe, true);
  assert.equal(preview.repositoryId, repository.repository_id);
  assert.equal(preview.projectBrainEnabled, false);

  await assert.rejects(
    approveRepositoryIdentityMigration({
      workspaceId,
      migrationId: preview.migrationId,
      requestFingerprint: "0".repeat(64),
      actorId: ownerId,
    }),
    /does not match/,
  );
  await approveRepositoryIdentityMigration({
    workspaceId,
    migrationId: preview.migrationId,
    requestFingerprint: preview.requestFingerprint,
    actorId: ownerId,
  });
  const completion = {
    workspaceId,
    agentId,
    migrationId: preview.migrationId,
    requestFingerprint: preview.requestFingerprint,
    stableFingerprint: preview.stableFingerprint,
    registeredPath,
    currentHead,
    signingKey: "integration-signing-key",
  };
  const missionId = randomUUID();
  const taskId = randomUUID();
  const executionId = randomUUID();
  await pool.query(
    `INSERT INTO mission_projections(
      workspace_id,mission_id,aggregate_version,name,objective,domain,priority,risk_level,status,
      created_by,created_at,updated_at)
     VALUES($1,$2,1,'Migration race','Verify active-work exclusion','software_delivery','normal','low',
      'running',$3,now(),now())`,
    [workspaceId, missionId, ownerId],
  );
  await pool.query(
    `INSERT INTO task_projections(
      workspace_id,task_id,mission_id,aggregate_version,name,instructions,status,priority,risk_level,
      maximum_attempts,created_at,updated_at)
     VALUES($1,$2,$3,1,'Active work','Remain active','running','normal','low',1,now(),now())`,
    [workspaceId, taskId, missionId],
  );
  await pool.query(
    `INSERT INTO execution_projections(
      workspace_id,execution_id,mission_id,task_id,agent_id,aggregate_version,attempt,status,input,
      idempotency_key,repository_id,adapter_type,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,1,1,'running','{}',$6,$7,'codex',now(),now())`,
    [workspaceId, executionId, missionId, taskId, agentId, randomUUID(), repository.repository_id],
  );
  await assert.rejects(prepareRepositoryIdentityActivation(completion), /eligibility changed/);
  await pool.query(
    "UPDATE execution_projections SET status='succeeded',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, executionId],
  );
  const prepared = await prepareRepositoryIdentityActivation(completion);
  const preparedAgain = await prepareRepositoryIdentityActivation(completion);
  assert.deepEqual(preparedAgain, prepared);
  const acknowledgement = {
    migrationId: preview.migrationId,
    requestId: prepared.activationRequest.requestId,
    activationProtocolVersion: "1",
    agentVersion: "0.6.9",
    artifact: { sha256: MISSION_AGENT_069_CHECKSUM, manifestVersion: "1" },
    repositoryId: repository.repository_id,
    legacyFingerprint,
    stableFingerprint: preview.stableFingerprint,
    canonicalRemoteUrl: preview.canonicalRemoteUrl,
    repositoryName: "mission-control-acceptance-07",
    registeredPath,
    currentHead,
    permissionSnapshotHash: prepared.activationRequest.permissionSnapshotHash,
    projectBrainEnabled: false,
    activatedAt: new Date().toISOString(),
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
  };
  await acknowledgeRepositoryIdentityActivation({ workspaceId, agentId, acknowledgement });
  await pool.query(
    `UPDATE agents SET mission_agent_version='0.6.9',mission_agent_artifact_checksum=$3,
      mission_agent_expected_checksum=$3,mission_agent_checksum_status='verified',
      mission_agent_capability_expires_at=now()+interval '5 minutes'
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, agentId, MISSION_AGENT_069_CHECKSUM],
  );
  await registerMissionAgentRepository({
    workspaceId,
    agentId,
    name: "mission-control-acceptance-07",
    fingerprint: preview.stableFingerprint,
    defaultBranch: "main",
    remoteUrl: "https://GitHub.com/wallyweb/mission-control-acceptance-07.git/",
    commit: currentHead,
    identityVersion: "stable-v2",
    canonicalRemoteUrl: preview.canonicalRemoteUrl,
    selectedRemote: "origin",
    remotes: [{ name: "origin", url: "https://GitHub.com/wallyweb/mission-control-acceptance-07.git/" }],
  });

  const afterMigration = (
    await pool.query("SELECT * FROM repositories WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repository.repository_id,
    ])
  ).rows[0];
  assert.equal(afterMigration.repository_id, before.repository_id);
  assert.equal(afterMigration.local_path, `mission-agent://${preview.stableFingerprint}`);
  for (const field of [
    "read_allowed",
    "write_allowed",
    "commit_allowed",
    "push_allowed",
    "pull_request_allowed",
    "merge_allowed",
    "deployment_allowed",
    "project_brain_enabled",
  ])
    assert.equal(afterMigration[field], before[field], field);
  assert.equal(afterMigration.identity_version, "stable-v2");
  assert.equal(afterMigration.repository_fingerprint, preview.stableFingerprint);

  const identities = (
    await pool.query(
      "SELECT identity_version,fingerprint,migration_status FROM repository_identities WHERE workspace_id=$1 AND repository_id=$2 ORDER BY identity_version",
      [workspaceId, repository.repository_id],
    )
  ).rows;
  assert.deepEqual(
    identities.map(({ identity_version, fingerprint }) => [identity_version, fingerprint]),
    [
      ["legacy-v1", legacyFingerprint],
      ["stable-v2", preview.stableFingerprint],
    ],
  );

  const eventTypes = (
    await pool.query(
      "SELECT event_type FROM events WHERE workspace_id=$1 AND aggregate_type='repository_identity_migration' ORDER BY position",
      [workspaceId],
    )
  ).rows.map((row) => row.event_type);
  assert.deepEqual(eventTypes, [
    "repository.identity_migration.previewed",
    "repository.identity_migration.requested",
    "repository.identity_migration.approved",
    "repository.identity_activation.requested",
    "repository.identity_activation.acknowledged",
    "repository.identity_migration.completed",
    "repository.identity_activation.completed",
  ]);

  const completedEvents = await loadAggregateEvents({
    workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: preview.migrationId,
  });
  const completedReplayClient = await pool.connect();
  try {
    await completedReplayClient.query("BEGIN");
    await applyRepositoryIdentityProjection(completedReplayClient, completedEvents);
    await completedReplayClient.query("COMMIT");
  } catch (error) {
    await completedReplayClient.query("ROLLBACK");
    throw error;
  } finally {
    completedReplayClient.release();
  }

  await pool.query(
    "UPDATE execution_projections SET status='running',completed_at=NULL,updated_at=now() WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, executionId],
  );
  await assert.rejects(
    rollbackRepositoryIdentityMigration({ workspaceId, migrationId: preview.migrationId, actorId: ownerId }),
    /eligibility changed/,
  );
  await pool.query(
    "UPDATE execution_projections SET status='succeeded',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, executionId],
  );
  await rollbackRepositoryIdentityMigration({ workspaceId, migrationId: preview.migrationId, actorId: ownerId });
  await rollbackRepositoryIdentityMigration({ workspaceId, migrationId: preview.migrationId, actorId: ownerId });
  const rolledBack = (
    await pool.query("SELECT * FROM repositories WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repository.repository_id,
    ])
  ).rows[0];
  assert.equal(rolledBack.repository_id, before.repository_id);
  assert.equal(rolledBack.repository_fingerprint, legacyFingerprint);
  assert.equal(rolledBack.identity_version, "legacy-v1");
  assert.equal(rolledBack.local_path, before.local_path);
  assert.equal(rolledBack.project_brain_enabled, before.project_brain_enabled);

  const migrationBeforeReplay = (
    await pool.query(
      `SELECT status,request_fingerprint,legacy_fingerprint,stable_fingerprint,canonical_remote_url,
       repository_name,registered_path,current_head,selected_remote,permission_snapshot,project_brain_enabled,
       aggregate_version,previewed_at,expires_at,approved_by,approved_at,completed_at,rolled_back_at,last_event_id
       FROM repository_identity_migrations WHERE workspace_id=$1 AND migration_id=$2`,
      [workspaceId, preview.migrationId],
    )
  ).rows[0];
  const identitiesBeforeReplay = (
    await pool.query(
      `SELECT identity_version,fingerprint,canonical_remote_url,repository_name,selected_remote,created_at,verified_at,
       verification_source,migration_status,superseded_fingerprint,migration_event_id
       FROM repository_identities WHERE workspace_id=$1 AND repository_id=$2 ORDER BY identity_version`,
      [workspaceId, repository.repository_id],
    )
  ).rows;
  const events = await loadAggregateEvents({
    workspaceId,
    aggregateType: "repository_identity_migration",
    aggregateId: preview.migrationId,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM repository_identity_migrations WHERE workspace_id=$1", [workspaceId]);
    await client.query("DELETE FROM repository_identities WHERE workspace_id=$1", [workspaceId]);
    await applyRepositoryIdentityProjection(client, events);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const migrationAfterReplay = (
    await pool.query(
      `SELECT status,request_fingerprint,legacy_fingerprint,stable_fingerprint,canonical_remote_url,
       repository_name,registered_path,current_head,selected_remote,permission_snapshot,project_brain_enabled,
       aggregate_version,previewed_at,expires_at,approved_by,approved_at,completed_at,rolled_back_at,last_event_id
       FROM repository_identity_migrations WHERE workspace_id=$1 AND migration_id=$2`,
      [workspaceId, preview.migrationId],
    )
  ).rows[0];
  const identitiesAfterReplay = (
    await pool.query(
      `SELECT identity_version,fingerprint,canonical_remote_url,repository_name,selected_remote,created_at,verified_at,
       verification_source,migration_status,superseded_fingerprint,migration_event_id
       FROM repository_identities WHERE workspace_id=$1 AND repository_id=$2 ORDER BY identity_version`,
      [workspaceId, repository.repository_id],
    )
  ).rows;
  assert.deepEqual(migrationAfterReplay, migrationBeforeReplay);
  assert.deepEqual(identitiesAfterReplay, identitiesBeforeReplay);
});
