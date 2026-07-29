import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");

const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { processRemoteMessage } = await import("../application/remote-agent-messages.ts");
const { applyRepositoryRegistrationProjection, registerMissionAgentRepository } =
  await import("../application/registry.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");
const { launchFirstRepositoryMission } = await import("../application/onboarding-mission.ts");
const { deriveStableRepositoryIdentity } = await import("../application/repository-identity.ts");
const { stableUuid } = await import("../lib/stable-id.ts");

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const ownerA = randomUUID();
const artifact = {
  version: "0.7.2",
  sha256: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
  artifactByteLength: 148063,
  canonicalizationVersion: "release-manifest-json-v3",
  manifestVersion: "3",
  publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  releaseAuthorityVersion: "v2",
  signingKeyId: "mission-agent-release-2026-01",
  sourceCommit: "31b45c98f2ffba613b56cd23819ba8b0c9c09a43",
};
let agentA;
let agentA2;

function stableInput(agentId, name, remoteUrl, commit = "a".repeat(40)) {
  const remotes = [{ name: "origin", url: remoteUrl }];
  const identity = deriveStableRepositoryIdentity({ remotes, repositoryName: name });
  return {
    workspaceId: workspaceA,
    agentId,
    name,
    fingerprint: identity.fingerprint,
    defaultBranch: "main",
    remoteUrl,
    commit,
    identityVersion: identity.identityVersion,
    canonicalRemoteUrl: identity.canonicalRemoteUrl,
    selectedRemote: identity.selectedRemote,
    remotes,
    protocolMessageId: randomUUID(),
  };
}

async function createAgent(name) {
  const registration = await registerRemoteAgent({
    actor: { workspaceId: workspaceA, userId: ownerA, role: "owner" },
    name,
    endpoint: "https://pull.invalid/messages",
    capabilities: ["repository.read", "code.review", "test.run", "artifact.create"],
    supportedDomains: ["software_delivery"],
    deliveryMode: "pull",
    missionAgentAdapter: "codex",
  });
  const credential = {
    workspace_id: workspaceA,
    agent_id: registration.agentId,
    credential_id: registration.credential.credentialId,
    credential_record_status: "active",
  };
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: registration.agentId,
      workspaceId: workspaceA,
      sentAt: new Date().toISOString(),
      messageType: "AgentHeartbeat",
      correlationId: registration.agentId,
      payload: {
        assignmentPull: true,
        missionAgentVersion: "0.7.2",
        adapter: "codex",
        artifact,
        repositoryIdentity: {
          supportedVersions: ["legacy-v1", "stable-v2"],
          stableProtocolVersion: "2",
          activationAcknowledgementVersion: "1",
          repositories: [],
        },
      },
    },
    credential,
  );
  return registration;
}

test.before(async () => {
  const pool = getDatabasePool();
  await pool.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3),($4,$5,$6)", [
    workspaceA,
    `repository-forward-${workspaceA}`,
    "Repository forward port A",
    workspaceB,
    `repository-forward-${workspaceB}`,
    "Repository forward port B",
  ]);
  agentA = await createAgent("Repository Agent A");
  agentA2 = await createAgent("Repository Agent A2");
});

test.after(async () => {
  const pool = getDatabasePool();
  await pool.query("DELETE FROM events WHERE workspace_id=ANY($1::uuid[])", [[workspaceA, workspaceB]]);
  await pool.query("DELETE FROM workspaces WHERE id=ANY($1::uuid[])", [[workspaceA, workspaceB]]);
  await closeDatabasePool();
});

test("signed 0.7.2 heartbeat remains checksum verified and identity-v2 capable without Project Brain installed", async () => {
  const row = (
    await getDatabasePool().query(
      `SELECT mission_agent_version,mission_agent_artifact_checksum,mission_agent_expected_checksum,
        mission_agent_checksum_status,mission_agent_manifest_version,mission_agent_project_brain_compatible
       FROM agents WHERE workspace_id=$1 AND agent_id=$2`,
      [workspaceA, agentA.agentId],
    )
  ).rows[0];
  assert.deepEqual(row, {
    mission_agent_version: "0.7.2",
    mission_agent_artifact_checksum: artifact.sha256,
    mission_agent_expected_checksum: artifact.sha256,
    mission_agent_checksum_status: "verified",
    mission_agent_manifest_version: "3",
    mission_agent_project_brain_compatible: false,
  });
  const events = await loadAggregateEvents({
    workspaceId: workspaceA,
    aggregateType: "agent",
    aggregateId: agentA.agentId,
  });
  assert.equal(
    events.find((event) => event.eventType === "agent.mission_agent_artifact_checksum_verified")?.payload
      .identityProtocolVersion,
    "2",
  );
});

test("new stable-v2 repository is workspace bound, event backed, launchable, and rejects cross-workspace IDs", async () => {
  const input = stableInput(agentA.agentId, "forward-port-launch", "git@github.com:example/forward-port-launch.git");
  const repository = await registerMissionAgentRepository(input);
  await assert.rejects(
    registerMissionAgentRepository({ ...input, workspaceId: workspaceB, protocolMessageId: randomUUID() }),
    /Mission Agent was not found/,
  );
  const events = await loadAggregateEvents({
    workspaceId: workspaceA,
    aggregateType: "repository",
    aggregateId: repository.repository_id,
  });
  assert.equal(events.at(-1)?.eventType, "repository.registered");
  assert.equal(events.at(-1)?.payload.canonicalRemoteUrl, "github.com/example/forward-port-launch");
  assert.equal(JSON.stringify(events).includes("git@"), false);
  const launched = await launchFirstRepositoryMission({
    actor: { workspaceId: workspaceA, userId: ownerA, role: "owner" },
    commandId: randomUUID(),
    agentId: agentA.agentId,
    repositoryId: repository.repository_id,
    objective: "Analyze the newly registered repository",
  });
  const mission = (
    await getDatabasePool().query(
      "SELECT resolved_inputs->>'repositoryId' repository_id FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceA, launched.missionId],
    )
  ).rows[0];
  assert.equal(mission.repository_id, repository.repository_id);
  const task = (
    await getDatabasePool().query("SELECT instructions FROM task_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceA,
      launched.missionId,
    ])
  ).rows[0];
  assert.match(task.instructions, /Never suggest inline code evaluation \(including node -e\)/);
  assert.match(task.instructions, /return an empty suggestedValidation array instead of inventing one/);
});

test("duplicate registration preserves every association, grant permission, and Project Brain flag", async () => {
  const first = await registerMissionAgentRepository(
    stableInput(agentA.agentId, "forward-port-duplicate", "https://github.com/example/forward-port-duplicate.git"),
  );
  await getDatabasePool().query(
    "UPDATE repositories SET project_brain_enabled=true WHERE workspace_id=$1 AND repository_id=$2",
    [workspaceA, first.repository_id],
  );
  await getDatabasePool().query(
    `UPDATE agent_resource_permissions SET permissions='["read","write"]'
       WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3`,
    [workspaceA, agentA.agentId, first.repository_id],
  );
  const second = await registerMissionAgentRepository(
    stableInput(
      agentA2.agentId,
      "forward-port-duplicate",
      "git@github.com:example/forward-port-duplicate.git",
      "b".repeat(40),
    ),
  );
  assert.equal(second.repository_id, first.repository_id);
  const state = (
    await getDatabasePool().query(
      `SELECT r.allowed_agent_ids,r.project_brain_enabled,
        (SELECT permissions FROM agent_resource_permissions
         WHERE workspace_id=$1 AND agent_id=$3 AND resource_type='repository'
           AND resource_id=r.repository_id::text) first_permissions,
        (SELECT permissions FROM agent_resource_permissions
         WHERE workspace_id=$1 AND agent_id=$4 AND resource_type='repository'
           AND resource_id=r.repository_id::text) second_permissions
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2`,
      [workspaceA, first.repository_id, agentA.agentId, agentA2.agentId],
    )
  ).rows[0];
  assert.deepEqual(new Set(state.allowed_agent_ids), new Set([agentA.agentId, agentA2.agentId]));
  assert.equal(state.project_brain_enabled, true);
  assert.deepEqual(state.first_permissions, ["read", "write"]);
  assert.deepEqual(state.second_permissions, ["read"]);
});

test("malformed and credential-bearing remotes persist no repository, identity, event, command, or secret", async () => {
  const marker = "private-token-forward-port";
  for (const [name, remote] of [
    ["malformed-forward-port", "github.com/not-a-remote"],
    ["credential-forward-port", `https://${marker}@github.com/example/credential-forward-port.git`],
  ])
    assert.throws(() => stableInput(agentA.agentId, name, remote), /canonicalizable|credentials/);
  const serialized = JSON.stringify(
    (
      await getDatabasePool().query(
        `SELECT
          (SELECT count(*)::int FROM repositories WHERE workspace_id=$1 AND (name LIKE '%forward-port%' OR observed_remote_url LIKE $2)) repositories,
          (SELECT count(*)::int FROM repository_identities WHERE workspace_id=$1 AND canonical_remote_url LIKE $2) identities,
          (SELECT count(*)::int FROM events WHERE workspace_id=$1 AND payload::text LIKE $2) events`,
        [workspaceA, `%${marker}%`],
      )
    ).rows[0],
  );
  assert.equal(serialized.includes(marker), false);
});

test("failure after every registration projection transition rolls back all database-backed state", async () => {
  for (const [index, failureInjection] of ["after_repository", "after_identity", "after_grant"].entries()) {
    const name = `forward-port-failure-${index}`;
    const input = stableInput(agentA.agentId, name, `https://github.com/example/${name}.git`);
    const repositoryId = stableUuid(`stable-v2-repository:${workspaceA}:${input.fingerprint}`);
    const commandId = stableUuid(`repository-registration:${workspaceA}:${agentA.agentId}:${input.protocolMessageId}`);
    await assert.rejects(registerMissionAgentRepository({ ...input, failureInjection }), /Injected failure/);
    const state = (
      await getDatabasePool().query(
        `SELECT
          (SELECT count(*)::int FROM repositories WHERE workspace_id=$1 AND repository_fingerprint=$2) repositories,
          (SELECT count(*)::int FROM repository_identities WHERE workspace_id=$1 AND fingerprint=$2) identities,
          (SELECT count(*)::int FROM agent_resource_permissions WHERE workspace_id=$1 AND resource_id=$3) grants,
          (SELECT count(*)::int FROM events WHERE workspace_id=$1 AND aggregate_id=$3::uuid) events,
          (SELECT count(*)::int FROM commands WHERE workspace_id=$1 AND command_id=$4::uuid) commands`,
        [workspaceA, input.fingerprint, repositoryId, commandId],
      )
    ).rows[0];
    assert.deepEqual(state, { repositories: 0, identities: 0, grants: 0, events: 0, commands: 0 });
  }
});

test("concurrent stable-v2 duplicates converge on one repository and preserve both grants", async () => {
  const firstInput = stableInput(
    agentA.agentId,
    "forward-port-concurrent",
    "https://github.com/example/forward-port-concurrent.git",
  );
  const secondInput = stableInput(
    agentA2.agentId,
    "forward-port-concurrent",
    "git@github.com:example/forward-port-concurrent.git",
    "c".repeat(40),
  );
  const [first, second] = await Promise.all([
    registerMissionAgentRepository(firstInput),
    registerMissionAgentRepository(secondInput),
  ]);
  assert.equal(first.repository_id, second.repository_id);
  const state = (
    await getDatabasePool().query(
      `SELECT
        (SELECT count(*)::int FROM repositories WHERE workspace_id=$1 AND repository_fingerprint=$2) repositories,
        (SELECT count(*)::int FROM repository_identities WHERE workspace_id=$1 AND fingerprint=$2) identities,
        (SELECT count(*)::int FROM agent_resource_permissions
         WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$3::text AND revoked_at IS NULL) grants,
        (SELECT count(*)::int FROM events
         WHERE workspace_id=$1 AND aggregate_type='repository' AND aggregate_id=$3::uuid) events`,
      [workspaceA, firstInput.fingerprint, first.repository_id],
    )
  ).rows[0];
  assert.deepEqual(state, { repositories: 1, identities: 1, grants: 2, events: 2 });
});

test("canonical registration events rebuild repository, stable identity, association, and grant", async () => {
  const input = stableInput(
    agentA.agentId,
    "forward-port-replay",
    "https://github.com/example/forward-port-replay.git",
  );
  const repository = await registerMissionAgentRepository(input);
  const events = await loadAggregateEvents({
    workspaceId: workspaceA,
    aggregateType: "repository",
    aggregateId: repository.repository_id,
  });
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM agent_resource_permissions WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$2",
      [workspaceA, repository.repository_id],
    );
    await client.query("DELETE FROM repository_identities WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceA,
      repository.repository_id,
    ]);
    await client.query("DELETE FROM repositories WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceA,
      repository.repository_id,
    ]);
    await applyRepositoryRegistrationProjection(client, events);
    const rebuilt = (
      await client.query(
        `SELECT r.repository_fingerprint,r.allowed_agent_ids,i.identity_version,p.permissions
         FROM repositories r
         JOIN repository_identities i ON i.workspace_id=r.workspace_id AND i.repository_id=r.repository_id
         JOIN agent_resource_permissions p ON p.workspace_id=r.workspace_id AND p.resource_id=r.repository_id::text
         WHERE r.workspace_id=$1 AND r.repository_id=$2`,
        [workspaceA, repository.repository_id],
      )
    ).rows[0];
    assert.equal(rebuilt.repository_fingerprint, input.fingerprint);
    assert.deepEqual(rebuilt.allowed_agent_ids, [agentA.agentId]);
    assert.equal(rebuilt.identity_version, "stable-v2");
    assert.deepEqual(rebuilt.permissions, ["read"]);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
