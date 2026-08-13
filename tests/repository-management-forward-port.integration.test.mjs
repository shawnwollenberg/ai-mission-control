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
const { deriveSigningKey, sha256, signProtocolRequest } = await import("../remote-agent/protocol.ts");
const { POST: registerRepositoryRoute } = await import("../app/api/agent-protocol/v1/repositories/route.ts");
const { POST: protocolMessageRoute } = await import("../app/api/agent-protocol/v1/messages/route.ts");

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

function signedRegistrationRequest(registration, input, workspaceId = workspaceA) {
  const path = "/api/agent-protocol/v1/repositories";
  const messageId = input.protocolMessageId ?? randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const body = JSON.stringify({
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: randomUUID(),
    agentId: registration.agentId,
    workspaceId,
    sentAt: timestamp,
    messageType: "AgentRepositoryRegistered",
    correlationId: registration.agentId,
    payload: {
      name: input.name,
      fingerprint: input.fingerprint,
      defaultBranch: input.defaultBranch,
      remoteUrl: input.remoteUrl,
      commit: input.commit,
      identityVersion: input.identityVersion,
      canonicalRemoteUrl: input.canonicalRemoteUrl,
      selectedRemote: input.selectedRemote,
      remotes: input.remotes,
    },
  });
  const bodyChecksum = sha256(body);
  const signature = signProtocolRequest(deriveSigningKey(registration.credential.secret), {
    method: "POST",
    path,
    timestamp,
    nonce,
    messageId,
    protocolVersion: "1.0",
    bodyChecksum,
  });
  return new Request(`http://mission-control.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": registration.agentId,
      "x-mc-credential-id": registration.credential.credentialId,
      "x-mc-timestamp": timestamp,
      "x-mc-nonce": nonce,
      "x-mc-message-id": messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
    },
    body,
  });
}

async function registerThroughProductionRoute(registration, input, workspaceId = workspaceA) {
  const response = await registerRepositoryRoute(signedRegistrationRequest(registration, input, workspaceId));
  return { status: response.status, body: await response.json() };
}

function signedHeartbeatRequest(registration) {
  const path = "/api/agent-protocol/v1/messages";
  const messageId = randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const body = JSON.stringify({
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: randomUUID(),
    agentId: registration.agentId,
    workspaceId: workspaceA,
    sentAt: timestamp,
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
  });
  const bodyChecksum = sha256(body);
  return new Request(`http://mission-control.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": registration.agentId,
      "x-mc-credential-id": registration.credential.credentialId,
      "x-mc-timestamp": timestamp,
      "x-mc-nonce": nonce,
      "x-mc-message-id": messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signProtocolRequest(deriveSigningKey(registration.credential.secret), {
        method: "POST",
        path,
        timestamp,
        nonce,
        messageId,
        protocolVersion: "1.0",
        bodyChecksum,
      }),
    },
    body,
  });
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

test("signed credential-bearing registration is rejected without secret evidence in logs or durable records", async () => {
  const marker = "protocol-private-token-forward-port";
  const input = stableInput(
    agentA.agentId,
    "credential-protocol-forward-port",
    "https://github.com/example/credential-protocol-forward-port.git",
  );
  const credentialRemote = `https://${marker}@github.com/example/credential-protocol-forward-port.git`;
  const unsafeInput = {
    ...input,
    remoteUrl: credentialRemote,
    canonicalRemoteUrl: credentialRemote,
    remotes: [{ name: "origin", url: credentialRemote }],
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.map(String).join(" "));
  let result;
  try {
    result = await registerThroughProductionRoute(agentA, unsafeInput);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "validation_failed");
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(
    warnings.some((warning) => warning.includes(marker)),
    false,
  );
  const evidence = (
    await getDatabasePool().query(
      `SELECT
        (SELECT count(*)::int FROM repositories r WHERE to_jsonb(r)::text LIKE $2) repositories,
        (SELECT count(*)::int FROM repository_identities i WHERE to_jsonb(i)::text LIKE $2) identities,
        (SELECT count(*)::int FROM agent_resource_permissions p WHERE to_jsonb(p)::text LIKE $2) grants,
        (SELECT count(*)::int FROM events e WHERE to_jsonb(e)::text LIKE $2) events,
        (SELECT count(*)::int FROM commands c WHERE to_jsonb(c)::text LIKE $2) commands,
        (SELECT count(*)::int FROM agent_protocol_receipts r WHERE to_jsonb(r)::text LIKE $2) receipts,
        (SELECT count(*)::int FROM protocol_security_events s WHERE to_jsonb(s)::text LIKE $2) audits,
        (SELECT count(*)::int FROM agents a WHERE to_jsonb(a)::text LIKE $2) agents,
        (SELECT count(*)::int FROM agent_credentials c WHERE to_jsonb(c)::text LIKE $2) credentials
       FROM workspaces w WHERE w.id=$1`,
      [workspaceA, `%${marker}%`],
    )
  ).rows[0];
  assert.deepEqual(evidence, {
    repositories: 0,
    identities: 0,
    grants: 0,
    events: 0,
    commands: 0,
    receipts: 0,
    audits: 0,
    agents: 0,
    credentials: 0,
  });
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

test("production protocol responses converge for 100 synchronized two-agent registrations", async () => {
  const agents = await Promise.all(
    Array.from({ length: 20 }, (_, index) => createAgent(`Repository HTTP Stress Agent ${index}`)),
  );
  for (let index = 0; index < 100; index += 1) {
    const name = `forward-port-http-stress-${index}`;
    const remote = `https://github.com/example/${name}.git`;
    const firstAgent = agents[index % agents.length];
    const secondAgent = agents[(index + 1) % agents.length];
    const firstInput = stableInput(firstAgent.agentId, name, remote);
    const secondInput = stableInput(secondAgent.agentId, name, `git@github.com:example/${name}.git`);
    const [first, second] = await Promise.all([
      registerThroughProductionRoute(firstAgent, firstInput),
      registerThroughProductionRoute(secondAgent, secondInput),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.repository.repository_id, second.body.repository.repository_id);
    assert.equal(first.body.error, undefined);
    assert.equal(second.body.error, undefined);
  }
});

test("ten simultaneous authorized agents receive one canonical repository identity", async () => {
  const agents = await Promise.all(
    Array.from({ length: 10 }, (_, index) => createAgent(`Repository Ten-Way Agent ${index}`)),
  );
  const name = "forward-port-http-ten-way";
  const results = await Promise.all(
    agents.map((registration, index) =>
      registerThroughProductionRoute(
        registration,
        stableInput(
          registration.agentId,
          name,
          index % 2 ? `git@github.com:example/${name}.git` : `https://github.com/example/${name}.git`,
        ),
      ),
    ),
  );
  assert.deepEqual(new Set(results.map((result) => result.status)), new Set([201]));
  const repositoryIds = new Set(results.map((result) => result.body.repository.repository_id));
  assert.equal(repositoryIds.size, 1);
  const repositoryId = [...repositoryIds][0];
  const state = (
    await getDatabasePool().query(
      `SELECT
        (SELECT count(*)::int FROM repositories WHERE workspace_id=$1 AND repository_id=$2) repositories,
        (SELECT count(*)::int FROM repository_identities
         WHERE workspace_id=$1 AND repository_id=$2 AND identity_version='stable-v2'
           AND migration_status='active') identities,
        (SELECT count(*)::int FROM agent_resource_permissions
         WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$2::text
           AND revoked_at IS NULL AND permissions ? 'read') grants,
        (SELECT count(*)::int FROM events
         WHERE workspace_id=$1 AND aggregate_type='repository' AND aggregate_id=$2::uuid) events`,
      [workspaceA, repositoryId],
    )
  ).rows[0];
  assert.deepEqual(state, { repositories: 1, identities: 1, grants: 10, events: 10 });
});

test("ten simultaneous registrations from one agent converge without leaking aggregate conflicts", async () => {
  const registration = await createAgent("Repository Same-Agent Stress");
  const name = "forward-port-http-same-agent";
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      registerThroughProductionRoute(
        registration,
        stableInput(registration.agentId, name, `https://github.com/example/${name}.git`),
      ),
    ),
  );
  assert.deepEqual(new Set(results.map((result) => result.status)), new Set([201]));
  const repositoryIds = new Set(results.map((result) => result.body.repository.repository_id));
  assert.equal(repositoryIds.size, 1);
  assert.equal(
    results.some((result) => result.body.error?.code === "concurrency_conflict"),
    false,
  );
  const repositoryId = [...repositoryIds][0];
  const evidence = (
    await getDatabasePool().query(
      `SELECT
        (SELECT count(*)::int FROM events
         WHERE workspace_id=$1 AND aggregate_type='repository' AND aggregate_id=$2::uuid
           AND payload->>'agentId'=$3::text) association_events,
        (SELECT count(*)::int FROM agent_protocol_receipts
         WHERE workspace_id=$1 AND agent_id=$3::uuid
           AND message_id=ANY($4::uuid[])
           AND acknowledgement->>'status' IS DISTINCT FROM 'processing') completed_receipts`,
      [workspaceA, repositoryId, registration.agentId, results.map((result) => result.body.messageId)],
    )
  ).rows[0];
  assert.deepEqual(evidence, { association_events: 1, completed_receipts: 10 });
});

test("two independent clients sharing one agent complete registration-followed-by-heartbeat", async () => {
  const registration = await createAgent("Repository Production Race Agent");
  const name = "forward-port-production-race";
  const firstInput = stableInput(registration.agentId, name, `https://github.com/example/${name}.git`);
  const secondInput = stableInput(registration.agentId, name, `git@github.com:example/${name}.git`);
  const registrations = await Promise.all([
    registerThroughProductionRoute(registration, firstInput),
    registerThroughProductionRoute(registration, secondInput),
  ]);
  assert.deepEqual(new Set(registrations.map((result) => result.status)), new Set([201]));
  assert.equal(new Set(registrations.map((result) => result.body.repository.repository_id)).size, 1);
  const heartbeats = await Promise.all([
    protocolMessageRoute(signedHeartbeatRequest(registration)),
    protocolMessageRoute(signedHeartbeatRequest(registration)),
  ]);
  assert.deepEqual(new Set(heartbeats.map((response) => response.status)), new Set([202]));
  const bodies = await Promise.all(heartbeats.map((response) => response.json()));
  assert.equal(
    bodies.every((body) => body.result.status === "accepted"),
    true,
  );
  assert.equal(
    bodies.some((body) => body.error?.code === "concurrency_conflict"),
    false,
  );
});

test("a concurrent injected transaction failure cannot leave or satisfy incomplete winning state", async () => {
  const name = "forward-port-concurrent-injected-failure";
  const failedInput = stableInput(agentA.agentId, name, `https://github.com/example/${name}.git`);
  const winningInput = stableInput(agentA2.agentId, name, `git@github.com:example/${name}.git`);
  const [failed, winning] = await Promise.allSettled([
    registerMissionAgentRepository({ ...failedInput, failureInjection: "after_identity" }),
    registerMissionAgentRepository(winningInput),
  ]);
  assert.equal(failed.status, "rejected");
  assert.match(failed.reason.message, /Injected failure/);
  assert.equal(winning.status, "fulfilled");
  const repositoryId = winning.value.repository_id;
  const state = (
    await getDatabasePool().query(
      `SELECT
        (SELECT count(*)::int FROM repositories WHERE workspace_id=$1 AND repository_id=$2) repositories,
        (SELECT count(*)::int FROM repository_identities
         WHERE workspace_id=$1 AND repository_id=$2 AND migration_status='active') identities,
        (SELECT count(*)::int FROM agent_resource_permissions
         WHERE workspace_id=$1 AND agent_id=$3 AND resource_type='repository'
           AND resource_id=$2::text AND revoked_at IS NULL AND permissions ? 'read') winning_grants,
        (SELECT count(*)::int FROM agent_resource_permissions
         WHERE workspace_id=$1 AND agent_id=$4 AND resource_type='repository'
           AND resource_id=$2::text AND revoked_at IS NULL) failed_grants`,
      [workspaceA, repositoryId, agentA2.agentId, agentA.agentId],
    )
  ).rows[0];
  assert.deepEqual(state, { repositories: 1, identities: 1, winning_grants: 1, failed_grants: 0 });
});

test("signed cross-workspace protocol identity manipulation remains rejected", async () => {
  const input = stableInput(
    agentA.agentId,
    "forward-port-http-cross-workspace",
    "https://github.com/example/forward-port-http-cross-workspace.git",
  );
  const result = await registerThroughProductionRoute(agentA, input, workspaceB);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "validation_failed");
  assert.equal(result.body.error.message, "Protocol identity mismatch");
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
