import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
process.env.APP_ENV = "test";
process.env.ARTIFACT_STORAGE_ROOT = await mkdtemp(join(tmpdir(), "mission-control-consensus-artifacts-"));
process.env.ARTIFACT_STORAGE_PROVIDER = "local";

const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { registerMissionAgentRepository, registerRepository, configureDisposableRepositoryAuthority } =
  await import("../application/registry.ts");
const { deriveStableRepositoryIdentity } = await import("../application/repository-identity.ts");
const { processRemoteMessage, reserveProtocolMessage, completeProtocolMessage } =
  await import("../application/remote-agent-messages.ts");
const {
  createConsensusPlanMission,
  createConsensusImplementationMission,
  getConsensusHistory,
  cancelConsensusForAcceptanceSourceClosure,
} = await import("../application/consensus-plan-commands.ts");
const { recordConsensusArtifact } = await import("../application/consensus-plan-commands.ts");
const { claimNextAssignment, acknowledgeAssignment, renewAssignmentLease } =
  await import("../application/pull-assignments.ts");
const { decideApproval } = await import("../application/approval-commands.ts");
const { handleExecutionCancellation, handleExecutionTransition } = await import("../application/execution-commands.ts");
const { reconcileConsensusOperations } = await import("../application/governance-maintenance.ts");
const { canonicalHash } = await import("../lib/canonical-json.ts");
const { providerRuntimeBindingFor } = await import("../domain/provider-runtime-requirements.ts");
const { expectedProviderRuntimeProfileBindings } = await import("../domain/provider-runtime-profiles.ts");
const { repositoryAuthorityBindingHash } = await import("../domain/repository-authority.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");
const { applyConsensusPlanProjection } = await import("../application/consensus-plan-projector.ts");
const { deriveSigningKey, sha256, signProtocolRequest } = await import("../remote-agent/protocol.ts");
const { POST: protocolMessageRoute } = await import("../app/api/agent-protocol/v1/messages/route.ts");
const { POST: assignmentPullRoute } = await import("../app/api/agent-protocol/v1/assignments/pull/route.ts");
const { applyRepositoryRegistrationProjection, applyRepositoryAuthorityProjection } =
  await import("../application/registry.ts");
const { executePresentationAuthorityScenarios } = await import("../lib/acceptance-authority-presentation-scenarios.ts");

const workspaceId = randomUUID();
const owner = { workspaceId, userId: randomUUID(), role: "owner" };
const commit = "c".repeat(40);
const remotes = [{ name: "origin", url: "https://github.com/example/consensus-fixture.git" }];
const repositoryIdentity = deriveStableRepositoryIdentity({
  remotes,
  repositoryName: "consensus-fixture",
});
let plannerA;
let plannerB;
let repositoryId;
const repositoryAuthorityCommandId = randomUUID();

function signedExecutionRequest(registration, message, lease) {
  const path = "/api/agent-protocol/v1/messages";
  const body = JSON.stringify(message);
  const timestamp = message.sentAt;
  const nonce = randomUUID();
  const bodyChecksum = sha256(body);
  const signature = signProtocolRequest(deriveSigningKey(registration.credential.secret), {
    method: "POST",
    path,
    timestamp,
    nonce,
    messageId: message.messageId,
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
      "x-mc-message-id": message.messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
      "x-mc-assignment-id": lease.assignmentId,
      "x-mc-lease-owner": lease.leaseOwner,
      "x-mc-lease-token": lease.leaseToken,
      "x-mc-fencing-token": String(lease.fencingToken),
    },
    body,
  });
}

function signedKnownAssignmentPullRequest(registration, assignmentId, leaseOwner) {
  const path = "/api/agent-protocol/v1/assignments/pull";
  const message = {
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId: registration.agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType: "AgentAssignmentPullRequested",
    correlationId: assignmentId,
    payload: { assignmentId, leaseOwner, waitSeconds: 0 },
  };
  const body = JSON.stringify(message);
  const nonce = randomUUID();
  const bodyChecksum = sha256(body);
  const signature = signProtocolRequest(deriveSigningKey(registration.credential.secret), {
    method: "POST",
    path,
    timestamp: message.sentAt,
    nonce,
    messageId: message.messageId,
    protocolVersion: "1.0",
    bodyChecksum,
  });
  return new Request(`http://mission-control.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": registration.agentId,
      "x-mc-credential-id": registration.credential.credentialId,
      "x-mc-timestamp": message.sentAt,
      "x-mc-nonce": nonce,
      "x-mc-message-id": message.messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
    },
    body,
  });
}

const profile = (provider) => ({
  provider,
  agentVersion: "0.8.0-test",
  supportedMissionRoles: ["planner", "reviewer", "executor"],
  supportedOperations: [
    "inspect_repository",
    "prepare_project_brain_context",
    "generate_structured_plan",
    "critique_plan",
    "revise_plan",
    "review_canonical_plan",
    "implement_change",
    "review_implementation",
  ],
  supportedModels: ["default"],
  modelCapabilities: [
    {
      modelId: "default",
      displayName: `${provider} fixture model`,
      provider,
      supportedRoles: ["planner", "synthesizer", "executor", "implementation_reviewer"],
      supportedOperations: [
        "inspect_repository",
        "prepare_project_brain_context",
        "generate_structured_plan",
        "critique_plan",
        "revise_plan",
        "review_canonical_plan",
        "implement_change",
        "review_implementation",
      ],
      structuredOutput: true,
      repositoryRead: true,
      repositoryMutation: true,
      planMode: true,
      runtimeModelIdentity: "reported",
    },
  ],
  capabilityAttestationVersion: 1,
  capabilitySource: "operator_allowlist",
  structuredOutput: true,
  projectBrainContext: true,
  repositoryMutation: true,
});

const runtimeStatus = (provider, overrides = {}) => ({
  ...providerRuntimeBindingFor(provider),
  platform: "darwin",
  executableAvailable: true,
  providerVersion:
    provider === "codex" ? "codex-cli 0.146.0" : provider === "claude_code" ? "Claude Code 2.1.224" : null,
  authenticationAvailable: true,
  isolationMechanism: provider === "mock" ? "test_process" : "sandbox-exec",
  isolationAvailable: true,
  modelSelectionMechanism: provider === "mock" ? "fixture" : "argv",
  runtimeModelIdentity: provider === "mock" ? "verified" : "unverifiable",
  runtimeProfiles:
    provider === "codex" || provider === "claude_code" ? expectedProviderRuntimeProfileBindings(provider) : [],
  ...overrides,
});
const repositoryState = (() => {
  const trackedManifest = [
    ".project-brain/README.md",
    ".project-brain/current-state.md",
    ".project-brain/known-issues.md",
    ".project-brain/project-profile.yaml",
    "package.json",
  ]
    .map((path, index) => ({
      path,
      type: "file",
      mode: "100644",
      size: 10 + index,
      contentSha256: String(index + 1).repeat(64),
      gitObjectId: String.fromCharCode(97 + index).repeat(40),
      symlinkTarget: null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const untrackedManifest = [];
  const relevantIgnoredManifest = [];
  const submodules = [];
  const state = {
    schemaVersion: "complete_repository_state/3",
    repositoryIdentity: repositoryIdentity.fingerprint,
    repositoryRootIdentity: repositoryIdentity.fingerprint,
    baseBranch: "main",
    baseCommit: commit,
    headCommit: commit,
    cleanWorktree: true,
    trackedStatusHash: createHash("sha256").update("").digest("hex"),
    trackedStatusEmpty: true,
    trackedIndexHash: "1".repeat(64),
    trackedManifestHash: canonicalHash(trackedManifest),
    trackedCount: trackedManifest.length,
    trackedContentMatchesIndex: true,
    trackedManifest,
    untrackedPolicyId: "include-untracked/1",
    untrackedManifestHash: canonicalHash(untrackedManifest),
    untrackedCount: 0,
    untrackedManifest,
    ignoredPolicyId: "runtime-relevant-ignored/1",
    relevantIgnoredManifestHash: canonicalHash(relevantIgnoredManifest),
    relevantIgnoredCount: 0,
    relevantIgnoredManifest,
    submoduleStatusHash: canonicalHash(submodules),
    submodules,
  };
  return { ...state, snapshotHash: canonicalHash(state) };
})();

function authenticatedRegistration(protocolMessageId) {
  const authority = {
    schemaVersion: "authenticated-repository-registration/1",
    messageId: protocolMessageId,
    credentialId: randomUUID(),
    bodyChecksum: createHash("sha256").update(protocolMessageId).digest("hex"),
    receiptSchemaVersion: "agent-protocol-receipt/2",
  };
  return { ...authority, authorizationHash: canonicalHash(authority) };
}

async function registerPlanner(name, adapter, provider) {
  const result = await registerRemoteAgent({
    actor: owner,
    name,
    endpoint: "https://pull.invalid/messages",
    capabilities: [
      "repository.read",
      "repository.isolated_worktree_write",
      "code.implement",
      "code.review",
      "test.run",
      "git.commit_local",
      "artifact.create",
      "plan.generate",
      "plan.critique",
      "plan.revise",
      "plan.review",
      "project_brain.context",
    ],
    supportedDomains: ["software_delivery"],
    deliveryMode: "pull",
    concurrencyLimit: 5,
    missionAgentAdapter: adapter,
    providerProfile: profile(provider),
  });
  const credential = {
    workspace_id: workspaceId,
    agent_id: result.agentId,
    credential_id: result.credential.credentialId,
    credential_record_status: "active",
  };
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: result.agentId,
      workspaceId,
      sentAt: new Date().toISOString(),
      messageType: "AgentHeartbeat",
      correlationId: result.agentId,
      payload: {
        assignmentPull: true,
        missionAgentVersion: "0.8.0",
        adapter,
        providerCredentialsAvailable: true,
        providerRuntimeStatus: runtimeStatus(provider),
        providerProfile: profile(provider),
      },
    },
    credential,
  );
  // This suite exercises the protocol and command layer with an explicit
  // disposable trust fixture. Production eligibility still requires the
  // independently signed and approved 0.8 artifact.
  await getDatabasePool().query(
    `UPDATE agents SET mission_agent_version='0.8.0',mission_agent_checksum_status='verified',
       mission_agent_capability_expires_at=now()+interval '5 minutes'
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, result.agentId],
  );
  return { ...result, credentialRecord: credential };
}

test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Consensus Integration')", [
    workspaceId,
    `consensus-${workspaceId}`,
  ]);
  plannerA = await registerPlanner("Codex planner", "codex", "codex");
  plannerB = await registerPlanner("Claude planner", "claude-code", "claude_code");
  const firstRegistrationMessageId = randomUUID();
  const registered = await registerMissionAgentRepository({
    workspaceId,
    agentId: plannerA.agentId,
    name: "consensus-fixture",
    fingerprint: repositoryIdentity.fingerprint,
    defaultBranch: "main",
    remoteUrl: "https://github.com/example/consensus-fixture.git",
    identityVersion: repositoryIdentity.identityVersion,
    canonicalRemoteUrl: repositoryIdentity.canonicalRemoteUrl,
    selectedRemote: repositoryIdentity.selectedRemote,
    remotes,
    commit,
    repositoryState,
    protocolMessageId: firstRegistrationMessageId,
    registrationAuthority: authenticatedRegistration(firstRegistrationMessageId),
  });
  repositoryId = registered.repository_id;
  const secondRegistrationMessageId = randomUUID();
  await registerMissionAgentRepository({
    workspaceId,
    agentId: plannerB.agentId,
    name: "consensus-fixture",
    fingerprint: repositoryIdentity.fingerprint,
    defaultBranch: "main",
    remoteUrl: "https://github.com/example/consensus-fixture.git",
    identityVersion: repositoryIdentity.identityVersion,
    canonicalRemoteUrl: repositoryIdentity.canonicalRemoteUrl,
    selectedRemote: repositoryIdentity.selectedRemote,
    remotes,
    commit,
    repositoryState,
    protocolMessageId: secondRegistrationMessageId,
    registrationAuthority: authenticatedRegistration(secondRegistrationMessageId),
  });
  await configureDisposableRepositoryAuthority({
    actor: owner,
    commandId: repositoryAuthorityCommandId,
    repositoryId,
    implementationAgentIds: [plannerA.agentId],
    validationCommands: [["npm", "test"]],
  });
});

test("owner-authenticated disposable authority is exact, narrow, receipted, and idempotent", async () => {
  const before = (
    await getDatabasePool().query(
      `SELECT r.*, (SELECT count(*)::int FROM repository_authority_receipts receipt
         WHERE receipt.workspace_id=r.workspace_id AND receipt.repository_id=r.repository_id) receipt_count
         ,(SELECT command_id::text FROM repository_authority_receipts receipt
           WHERE receipt.workspace_id=r.workspace_id AND receipt.repository_id=r.repository_id
             AND receipt.authority_hash=r.repository_authority_hash LIMIT 1) authority_command_id
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.equal(before.read_allowed, true);
  assert.equal(before.write_allowed, false);
  assert.equal(before.commit_allowed, false);
  assert.equal(before.isolated_worktree_write_allowed, true);
  assert.equal(before.mission_agent_local_commit_allowed, true);
  assert.equal(before.provider_direct_commit_allowed, false);
  assert.equal(before.push_allowed, false);
  assert.equal(before.pull_request_allowed, false);
  assert.equal(before.merge_allowed, false);
  assert.equal(before.publication_allowed, false);
  assert.equal(before.deployment_allowed, false);
  assert.equal(before.infrastructure_mutation_allowed, false);
  assert.equal(before.receipt_count, 1);
  assert.equal(
    before.repository_authority_hash,
    repositoryAuthorityBindingHash(before.repository_authority, before.authority_command_id),
  );
  await configureDisposableRepositoryAuthority({
    actor: owner,
    commandId: repositoryAuthorityCommandId,
    repositoryId,
    implementationAgentIds: [plannerA.agentId],
    validationCommands: [["npm", "test"]],
  });
  const after = (
    await getDatabasePool().query(
      `SELECT count(*)::int receipt_count FROM repository_authority_receipts
       WHERE workspace_id=$1 AND repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.equal(after.receipt_count, 1);
  const permissions = (
    await getDatabasePool().query(
      `SELECT agent_id,permissions FROM agent_resource_permissions
       WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$2 ORDER BY agent_id`,
      [workspaceId, repositoryId],
    )
  ).rows;
  assert.deepEqual(permissions.find((row) => row.agent_id === plannerA.agentId).permissions, [
    "read",
    "isolated_worktree_write",
  ]);
  assert.deepEqual(permissions.find((row) => row.agent_id === plannerB.agentId).permissions, ["read"]);
  await assert.rejects(
    registerRepository({
      actor: owner,
      repositoryId,
      name: "attempted legacy expansion",
      localPath: "/tmp/legacy-expansion",
      defaultBranch: "main",
      allowedAgentIds: [plannerA.agentId, plannerB.agentId],
      readAllowed: true,
      writeAllowed: true,
      commitAllowed: true,
      pushAllowed: true,
      pullRequestAllowed: true,
    }),
    /cannot mutate an explicitly bound repository authority/,
  );
});

test.after(async () => {
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});

test("authenticated complete registration rejects gaps and replays its immutable snapshot idempotently", async () => {
  const registration = (overrides = {}) => {
    const protocolMessageId = randomUUID();
    return {
      workspaceId,
      agentId: plannerA.agentId,
      name: "consensus-fixture",
      fingerprint: repositoryIdentity.fingerprint,
      defaultBranch: "main",
      remoteUrl: "https://github.com/example/consensus-fixture.git",
      identityVersion: repositoryIdentity.identityVersion,
      canonicalRemoteUrl: repositoryIdentity.canonicalRemoteUrl,
      selectedRemote: repositoryIdentity.selectedRemote,
      remotes,
      commit,
      repositoryState,
      protocolMessageId,
      registrationAuthority: authenticatedRegistration(protocolMessageId),
      ...overrides,
    };
  };
  await assert.rejects(
    registerMissionAgentRepository(registration({ repositoryState: undefined })),
    /requires complete/,
  );
  const missingSnapshot = { ...repositoryState };
  delete missingSnapshot.snapshotHash;
  await assert.rejects(
    registerMissionAgentRepository(registration({ repositoryState: missingSnapshot })),
    /snapshot hash/,
  );
  await assert.rejects(
    registerMissionAgentRepository(
      registration({ repositoryState: { ...repositoryState, snapshotHash: "0".repeat(64) } }),
    ),
    /snapshot hash/,
  );
  const wrongIdentityState = { ...repositoryState, repositoryIdentity: "0".repeat(64) };
  wrongIdentityState.snapshotHash = canonicalHash(
    Object.fromEntries(Object.entries(wrongIdentityState).filter(([key]) => key !== "snapshotHash")),
  );
  await assert.rejects(
    registerMissionAgentRepository(registration({ repositoryState: wrongIdentityState })),
    /registered repository identity/,
  );

  const before = (
    await getDatabasePool().query(
      `SELECT r.repository_snapshot_artifact_id,r.repository_snapshot_hash,
        (SELECT count(*)::int FROM events e WHERE e.workspace_id=r.workspace_id
          AND e.aggregate_type='repository' AND e.aggregate_id=r.repository_id) event_count
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  const unchanged = await registerMissionAgentRepository(registration());
  assert.equal(unchanged.repository_id, repositoryId);
  const after = (
    await getDatabasePool().query(
      `SELECT r.repository_snapshot_artifact_id,r.repository_snapshot_hash,
        (SELECT count(*)::int FROM events e WHERE e.workspace_id=r.workspace_id
          AND e.aggregate_type='repository' AND e.aggregate_id=r.repository_id) event_count
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.deepEqual(after, before);
  assert.equal(after.repository_snapshot_hash, repositoryState.snapshotHash);

  const events = await loadAggregateEvents({
    workspaceId,
    aggregateType: "repository",
    aggregateId: repositoryId,
  });
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE repositories SET repository_state=NULL,repository_snapshot_hash=NULL,
         repository_snapshot_artifact_id=NULL,repository_authority=NULL,repository_authority_hash=NULL,
         isolated_worktree_write_allowed=false,mission_agent_local_commit_allowed=false
       WHERE workspace_id=$1 AND repository_id=$2`,
      [workspaceId, repositoryId],
    );
    await client.query(
      `DELETE FROM agent_resource_permissions
       WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$2`,
      [workspaceId, repositoryId],
    );
    await client.query("DELETE FROM repository_authority_receipts WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repositoryId,
    ]);
    await client.query("DELETE FROM repository_snapshot_artifacts WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repositoryId,
    ]);
    await applyRepositoryRegistrationProjection(client, events);
    await applyRepositoryAuthorityProjection(client, events);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const replayed = (
    await getDatabasePool().query(
      `SELECT r.repository_state,r.repository_snapshot_hash,r.repository_snapshot_artifact_id,
        r.repository_authority,r.repository_authority_hash,r.isolated_worktree_write_allowed,
        r.mission_agent_local_commit_allowed,r.push_allowed,r.pull_request_allowed,
        s.checksum_sha256,s.manifest,s.registration_authority
       FROM repositories r JOIN repository_snapshot_artifacts s
         ON s.workspace_id=r.workspace_id AND s.snapshot_artifact_id=r.repository_snapshot_artifact_id
       WHERE r.workspace_id=$1 AND r.repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.deepEqual(replayed.repository_state, repositoryState);
  assert.deepEqual(replayed.manifest, repositoryState);
  assert.equal(replayed.repository_snapshot_hash, repositoryState.snapshotHash);
  assert.equal(replayed.checksum_sha256, repositoryState.snapshotHash);
  assert.equal(replayed.repository_snapshot_artifact_id, before.repository_snapshot_artifact_id);
  assert.equal(replayed.registration_authority.schemaVersion, "authenticated-repository-registration/1");
  assert.equal(replayed.isolated_worktree_write_allowed, true);
  assert.equal(replayed.mission_agent_local_commit_allowed, true);
  assert.equal(replayed.push_allowed, false);
  assert.equal(replayed.pull_request_allowed, false);
  assert.equal(replayed.repository_authority.profile, "disposable_local_implementation/1");
  const replayedPermissions = (
    await getDatabasePool().query(
      `SELECT agent_id,permissions FROM agent_resource_permissions
       WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$2 ORDER BY agent_id`,
      [workspaceId, repositoryId],
    )
  ).rows;
  assert.deepEqual(replayedPermissions.find((row) => row.agent_id === plannerA.agentId).permissions, [
    "read",
    "isolated_worktree_write",
  ]);
  assert.deepEqual(replayedPermissions.find((row) => row.agent_id === plannerB.agentId).permissions, ["read"]);
  const authorityReceipt = (
    await getDatabasePool().query(
      `SELECT command_id::text FROM repository_authority_receipts
       WHERE workspace_id=$1 AND repository_id=$2 AND authority_hash=$3`,
      [workspaceId, repositoryId, replayed.repository_authority_hash],
    )
  ).rows[0];
  assert.equal(
    replayed.repository_authority_hash,
    repositoryAuthorityBindingHash(replayed.repository_authority, authorityReceipt.command_id),
  );
  await assert.rejects(
    getDatabasePool().query(
      "UPDATE repository_snapshot_artifacts SET byte_size=byte_size+1 WHERE workspace_id=$1 AND snapshot_artifact_id=$2",
      [workspaceId, replayed.repository_snapshot_artifact_id],
    ),
    /repository snapshot artifacts are immutable/,
  );
});

test("heartbeats cannot expand the owner-approved provider model profile", async () => {
  const before = (
    await getDatabasePool().query("SELECT supported_models FROM agents WHERE workspace_id=$1 AND agent_id=$2", [
      workspaceId,
      plannerA.agentId,
    ])
  ).rows[0].supported_models;
  await assert.rejects(
    processRemoteMessage(
      {
        protocolVersion: "1.0",
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
        agentId: plannerA.agentId,
        workspaceId,
        sentAt: new Date().toISOString(),
        messageType: "AgentHeartbeat",
        correlationId: plannerA.agentId,
        payload: {
          assignmentPull: true,
          missionAgentVersion: "0.8.0",
          adapter: "codex",
          providerRuntimeStatus: runtimeStatus("codex"),
          providerProfile: { ...profile("codex"), supportedModels: ["default", "unapproved-model"] },
        },
      },
      plannerA.credentialRecord,
    ),
    /owner-approved registration|same identifiers/,
  );
  const after = (
    await getDatabasePool().query("SELECT supported_models FROM agents WHERE workspace_id=$1 AND agent_id=$2", [
      workspaceId,
      plannerA.agentId,
    ])
  ).rows[0].supported_models;
  assert.deepEqual(after, before);
});

test("heartbeats reject stale or mismatched provider runtime contracts", async () => {
  await assert.rejects(
    processRemoteMessage(
      {
        protocolVersion: "1.0",
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
        agentId: plannerA.agentId,
        workspaceId,
        sentAt: new Date().toISOString(),
        messageType: "AgentHeartbeat",
        correlationId: plannerA.agentId,
        payload: {
          assignmentPull: true,
          missionAgentVersion: "0.8.0",
          adapter: "codex",
          providerCredentialsAvailable: true,
          providerRuntimeStatus: runtimeStatus("codex", { requirementsHash: "0".repeat(64) }),
          providerProfile: profile("codex"),
        },
      },
      plannerA.credentialRecord,
    ),
    /does not bind the current requirement contract/,
  );
  const runtime = (
    await getDatabasePool().query(
      `SELECT provider_runtime_requirements_satisfied,provider_runtime_status
       FROM agents WHERE workspace_id=$1 AND agent_id=$2`,
      [workspaceId, plannerA.agentId],
    )
  ).rows[0];
  assert.equal(runtime.provider_runtime_requirements_satisfied, true);
  assert.equal(runtime.provider_runtime_status.requirementsHash, providerRuntimeBindingFor("codex").requirementsHash);
});

test("unchanged heartbeats renew the bound capability attestation without rotating its identity", async () => {
  const before = (
    await getDatabasePool().query(
      `SELECT a.capability_attestation_id,a.capability_attestation_hash,ca.expires_at
       FROM agents a JOIN agent_model_capability_attestations ca
         ON ca.workspace_id=a.workspace_id
        AND ca.capability_attestation_id=a.capability_attestation_id
       WHERE a.workspace_id=$1 AND a.agent_id=$2`,
      [workspaceId, plannerA.agentId],
    )
  ).rows[0];
  await processRemoteMessage(
    {
      protocolVersion: "1.0",
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: plannerA.agentId,
      workspaceId,
      sentAt: new Date().toISOString(),
      messageType: "AgentHeartbeat",
      correlationId: plannerA.agentId,
      payload: {
        assignmentPull: true,
        missionAgentVersion: "0.8.0",
        adapter: "codex",
        providerCredentialsAvailable: true,
        providerRuntimeStatus: runtimeStatus("codex"),
        providerProfile: profile("codex"),
      },
    },
    plannerA.credentialRecord,
  );
  const after = (
    await getDatabasePool().query(
      `SELECT a.capability_attestation_id,a.capability_attestation_hash,ca.expires_at
       FROM agents a JOIN agent_model_capability_attestations ca
         ON ca.workspace_id=a.workspace_id
        AND ca.capability_attestation_id=a.capability_attestation_id
       WHERE a.workspace_id=$1 AND a.agent_id=$2`,
      [workspaceId, plannerA.agentId],
    )
  ).rows[0];
  assert.equal(after.capability_attestation_id, before.capability_attestation_id);
  assert.equal(after.capability_attestation_hash, before.capability_attestation_hash);
  assert.ok(after.expires_at >= before.expires_at);
});

test("consensus creation separates read, isolated-worktree, local-commit, and generic write authority", async () => {
  await assert.rejects(
    getDatabasePool().query("UPDATE repositories SET read_allowed=false WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repositoryId,
    ]),
    /require a new authenticated authority binding/,
  );
  await assert.rejects(
    getDatabasePool().query(
      "UPDATE repositories SET write_allowed=true,commit_allowed=true WHERE workspace_id=$1 AND repository_id=$2",
      [workspaceId, repositoryId],
    ),
    /require a new authenticated authority binding/,
  );
  await assert.rejects(
    getDatabasePool().query(
      `UPDATE agent_resource_permissions SET permissions='["read","write"]'::jsonb
       WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3`,
      [workspaceId, plannerA.agentId, repositoryId],
    ),
    /require a new authenticated authority binding/,
  );
  const effective = (
    await getDatabasePool().query(
      `SELECT read_allowed,write_allowed,commit_allowed,isolated_worktree_write_allowed,
         mission_agent_local_commit_allowed,push_allowed
       FROM repositories WHERE workspace_id=$1 AND repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.deepEqual(effective, {
    read_allowed: true,
    write_allowed: false,
    commit_allowed: false,
    isolated_worktree_write_allowed: true,
    mission_agent_local_commit_allowed: true,
    push_allowed: false,
  });
});

test("expired attestations and unavailable local provider credentials reject role assignments", async () => {
  const create = () =>
    createConsensusPlanMission({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      objective: "Reject stale model authority",
      acceptanceCriteria: ["Fail closed"],
      plannerA: { agentId: plannerA.agentId, modelId: "default" },
      plannerB: { agentId: plannerB.agentId, modelId: "default" },
      synthesizer: { agentId: plannerA.agentId, modelId: "default" },
      preferredExecutorAgentId: plannerA.agentId,
      preferredExecutorModelId: "default",
    });
  await getDatabasePool().query(
    `UPDATE agents SET capability_attestation_expires_at=now()-interval '1 second'
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, plannerA.agentId],
  );
  await assert.rejects(create(), /not eligible/);
  await getDatabasePool().query(
    `UPDATE agents SET capability_attestation_expires_at=now()+interval '5 minutes',provider_credentials_available=false
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, plannerA.agentId],
  );
  await assert.rejects(create(), /not eligible/);
  await getDatabasePool().query(
    `UPDATE agents SET provider_credentials_available=true WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, plannerA.agentId],
  );
});

test("an assignment can be claimed and renewed at the agent's default concurrency limit", async () => {
  await getDatabasePool().query("UPDATE agents SET concurrency_limit=1 WHERE workspace_id=$1 AND agent_id=$2", [
    workspaceId,
    plannerA.agentId,
  ]);
  try {
    const created = await createConsensusPlanMission({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      objective: "Verify self-exclusion from concurrency checks",
      acceptanceCriteria: ["The sole execution can claim and renew its own lease"],
      plannerA: { agentId: plannerA.agentId, modelId: "default" },
      plannerB: { agentId: plannerB.agentId, modelId: "default" },
      synthesizer: { agentId: plannerA.agentId, modelId: "default" },
      preferredExecutorAgentId: plannerA.agentId,
      preferredExecutorModelId: "default",
    });
    const turn = (
      await getDatabasePool().query(
        "SELECT * FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND operation='prepare_context'",
        [workspaceId, created.missionId],
      )
    ).rows[0];
    await getDatabasePool().query(
      "UPDATE agents SET provider_credentials_available=false WHERE workspace_id=$1 AND agent_id=$2",
      [workspaceId, plannerA.agentId],
    );
    await assert.rejects(
      claimNextAssignment({ credential: plannerA.credentialRecord, leaseOwner: "limit-one" }),
      /eligibility was revoked/,
    );
    const stillAvailable = (
      await getDatabasePool().query("SELECT status FROM pull_assignments WHERE workspace_id=$1 AND execution_id=$2", [
        workspaceId,
        turn.execution_id,
      ])
    ).rows[0];
    assert.equal(stillAvailable.status, "available");
    await getDatabasePool().query(
      "UPDATE agents SET provider_credentials_available=true WHERE workspace_id=$1 AND agent_id=$2",
      [workspaceId, plannerA.agentId],
    );
    const claimed = await claimNextAssignment({ credential: plannerA.credentialRecord, leaseOwner: "limit-one" });
    assert.equal(claimed.assignment.execution_id, turn.execution_id);
    const lease = {
      credential: plannerA.credentialRecord,
      assignmentId: claimed.assignment.assignment_id,
      leaseOwner: "limit-one",
      leaseToken: claimed.leaseToken,
      fencingToken: Number(claimed.assignment.fencing_token),
    };
    await acknowledgeAssignment(lease);
    const renewed = await renewAssignmentLease(lease);
    assert.equal(Number(renewed.fencing_token), lease.fencingToken);
    const concurrent = await Promise.allSettled([
      configureDisposableRepositoryAuthority({
        actor: owner,
        commandId: randomUUID(),
        repositoryId,
        implementationAgentIds: [plannerB.agentId],
        validationCommands: [["npm", "test"]],
      }),
      renewAssignmentLease(lease),
    ]);
    assert.equal(concurrent[0].status, "fulfilled");
    await assert.rejects(renewAssignmentLease(lease), /invalid or expired|fenced|authority binding changed/);
    const fenced = (
      await getDatabasePool().query(
        "SELECT status,fencing_token,lease_token_hash FROM pull_assignments WHERE workspace_id=$1 AND assignment_id=$2",
        [workspaceId, lease.assignmentId],
      )
    ).rows[0];
    assert.equal(fenced.status, "released");
    assert.equal(fenced.lease_token_hash, null);
    assert.ok(Number(fenced.fencing_token) > lease.fencingToken);
    await configureDisposableRepositoryAuthority({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      implementationAgentIds: [plannerA.agentId],
      validationCommands: [["npm", "test"]],
    });
    await assert.rejects(renewAssignmentLease(lease), /invalid or expired|fenced|authority binding changed/);
    await handleExecutionCancellation({
      actor: { workspaceId, id: owner.userId, type: "human" },
      commandId: randomUUID(),
      executionId: turn.execution_id,
    });
    await processRemoteMessage(
      envelope(turn, plannerA.agentId, "ExecutionCancellationAcknowledged", {
        classification: "default_concurrency_test_cleanup",
      }),
      plannerA.credentialRecord,
    );
  } finally {
    await getDatabasePool().query("UPDATE agents SET concurrency_limit=5 WHERE workspace_id=$1 AND agent_id=$2", [
      workspaceId,
      plannerA.agentId,
    ]);
  }
});

test("expired execution heartbeat fences a consensus attempt and fails its task", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Fence an abandoned provider attempt",
    acceptanceCriteria: ["Heartbeat expiry is terminal"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  const turn = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id,p.provider_id,p.model_id,p.provider_runtime_requirements_id,p.provider_runtime_requirements_hash
       FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.status='requested'`,
      [workspaceId, created.missionId],
    )
  ).rows[0];
  const credential = plannerA.credentialRecord;
  const claimed = await claimNextAssignment({ credential, leaseOwner: "heartbeat-expiry" });
  await acknowledgeAssignment({
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: "heartbeat-expiry",
    leaseToken: claimed.leaseToken,
    fencingToken: Number(claimed.assignment.fencing_token),
  });
  await processRemoteMessage(envelope(turn, turn.agent_id, "ExecutionAccepted", {}), credential);
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionHeartbeat", { stage: "preparing", summary: "fixture" }),
    credential,
  );
  await getDatabasePool().query(
    `UPDATE execution_heartbeats SET lease_expires_at=now()-interval '1 second'
     WHERE workspace_id=$1 AND execution_id=$2`,
    [workspaceId, turn.execution_id],
  );
  assert.ok((await reconcileConsensusOperations("heartbeat-monitor-test")) >= 1);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT status FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, turn.execution_id],
      )
    ).rows[0].status,
    "timed_out",
  );
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM pull_assignments WHERE workspace_id=$1 AND execution_id=$2", [
        workspaceId,
        turn.execution_id,
      ])
    ).rows[0].status,
    "completed",
  );
});

function envelope(turn, agentId, type, payload) {
  return {
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType: type,
    correlationId: turn.mission_id,
    missionId: turn.mission_id,
    taskId: turn.task_id,
    executionId: turn.execution_id,
    attempt: 1,
    payload,
  };
}

function successfulProviderDiagnostic({ provider, modelId, runtimeProfileId, runtimeProfileHash, attempt = 1 }) {
  return {
    schemaVersion: "provider-runtime-diagnostic/1",
    provider,
    requestedModel: modelId,
    cliVersion: provider === "codex" ? "codex-cli 0.146.0" : "Claude Code 2.1.224",
    runtimeProfileId,
    runtimeProfileHash,
    sandboxProfileHash: "9".repeat(64),
    providerAttemptId: `${attempt}-1`,
    processStartedAt: "2026-08-04T12:00:00.000Z",
    processTerminatedAt: "2026-08-04T12:00:01.000Z",
    exitCode: 0,
    terminationSignal: null,
    timedOut: false,
    cancellationRequested: false,
    stdoutHash: "8".repeat(64),
    stderrHash: "7".repeat(64),
    stdoutExcerpt: "structured result accepted",
    stderrExcerpt: "",
    textAvailable: true,
    failedInitializationPhase: "none",
    childProcess: {
      pid: 54321,
      processGroupId: 54321,
      detachedProcessGroup: true,
      processTreeTerminationAttempted: false,
      processTreeTerminationVerified: true,
    },
    sandboxDenial: { detected: false, excerpt: "" },
    temporaryDirectoryIdentity: "6".repeat(64),
    workingDirectoryIdentity: "5".repeat(64),
    environmentVariableNames: ["HOME", "PATH"],
    localSecretScan: "passed_exact_and_pattern",
  };
}

function artifactBody(turn, state, sources) {
  const binding = {
    mission_id: turn.mission_id,
    assignment_id: turn.participant_assignment_id,
    repository_snapshot: state.repository_snapshot,
    context_pack_hash: state.context_pack_hash,
  };
  if (turn.operation === "proposal")
    return {
      schema_version: "consensus-plan-proposal/1",
      ...binding,
      problem_definition: "Fixture problem",
      assumptions: [],
      proposed_approach: `Approach ${turn.participant_assignment_id}`,
      affected_components: [],
      data_model_changes: [],
      api_changes: [],
      migration_plan: [],
      implementation_steps: [],
      validation_plan: [],
      rollback_plan: [],
      security_considerations: [],
      operational_considerations: [],
      risks: [],
      open_questions: [],
      recommended_executor_capabilities: [],
      confidence: 0.9,
    };
  if (turn.operation === "critique")
    return {
      schema_version: "consensus-plan-critique/1",
      ...binding,
      round: 1,
      reviewed_proposal_artifact_id: sources[0].artifact_id,
      agreements: ["Bounded"],
      blocking_objections: [],
      non_blocking_suggestions: [],
      missing_validation: [],
      missing_rollback_provisions: [],
      unsupported_assumptions: [],
      verdict: "accept",
      confidence: 0.9,
    };
  if (turn.operation === "revision") {
    const proposal = sources.find((item) => item.artifact_kind === "consensus_proposal");
    const critique = sources.find((item) => item.artifact_kind === "consensus_critique");
    return {
      ...artifactBody({ ...turn, operation: "proposal" }, state, []),
      schema_version: "consensus-plan-revision/1",
      revises_proposal_artifact_id: proposal.artifact_id,
      addresses_critique_artifact_id: critique.artifact_id,
      resolved_objection_ids: [],
    };
  }
  if (turn.operation === "canonicalize")
    return {
      schema_version: "canonical-implementation-plan/1",
      mission_id: turn.mission_id,
      repository_snapshot: state.repository_snapshot,
      context_pack_hash: state.context_pack_hash,
      objective: "Implement fixture",
      accepted_assumptions: [],
      rejected_assumptions: [],
      architecture: "Existing command layer",
      affected_components: [],
      data_model_changes: [],
      api_changes: [],
      migration_plan: [],
      ordered_implementation_steps: [],
      acceptance_criteria: ["Pass"],
      validation_plan: ["npm test"],
      rollback_plan: ["Revert local commit"],
      security_requirements: [],
      operational_requirements: [],
      known_risks: [],
      deferred_items: [],
      executor_requirements: [],
      source_artifact_ids: sources.map((item) => item.artifact_id),
    };
  const plan = sources[0];
  return {
    schema_version: "canonical-plan-verdict/1",
    mission_id: turn.mission_id,
    assignment_id: turn.participant_assignment_id,
    canonical_plan_artifact_id: plan.artifact_id,
    canonical_plan_hash: plan.canonical_plan_hash,
    verdict: "approve",
    blocking_objections: [],
    non_blocking_notes: [],
    confidence: 0.95,
  };
}

async function completeNextTurn(missionId, transformArtifact = (value) => value, diagnosticCount = 1) {
  const turn = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id,p.provider_id,p.model_id,p.provider_runtime_requirements_id,p.provider_runtime_requirements_hash
       FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.status='requested' ORDER BY t.created_at,t.turn_id LIMIT 1`,
      [workspaceId, missionId],
    )
  ).rows[0];
  assert.ok(turn, "a consensus turn should be available");
  const credential = turn.agent_id === plannerA.agentId ? plannerA.credentialRecord : plannerB.credentialRecord;
  const claimed = await claimNextAssignment({ credential, leaseOwner: `fixture-${turn.agent_id}` });
  assert.ok(claimed?.assignment);
  assert.equal(
    claimed.assignment.payload.consensus.repositorySnapshot,
    repositoryState.snapshotHash,
    "every provider assignment must receive the exact authenticated repository snapshot",
  );
  assert.deepEqual(claimed.assignment.payload.allowedResources, [
    { resourceType: "repository", resourceId: repositoryId, permission: "read" },
  ]);
  if (turn.operation === "prepare_context") {
    assert.equal(claimed.assignment.payload.consensus.repositoryBaseCommit, repositoryState.headCommit);
    assert.equal(repositoryState.repositoryIdentity, repositoryIdentity.fingerprint);
  }
  await assert.rejects(
    acknowledgeAssignment({
      credential,
      assignmentId: claimed.assignment.assignment_id,
      leaseOwner: `fixture-${turn.agent_id}`,
      leaseToken: claimed.leaseToken,
      fencingToken: Number(claimed.assignment.fencing_token) - 1,
    }),
    /fencing token is stale/,
  );
  await acknowledgeAssignment({
    credential,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: `fixture-${turn.agent_id}`,
    leaseToken: claimed.leaseToken,
    fencingToken: Number(claimed.assignment.fencing_token),
  });
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionAccepted", { stage: "assignment_received" }),
    credential,
  );
  const state = (
    await getDatabasePool().query("SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      missionId,
    ])
  ).rows[0];
  let body;
  let kind;
  if (turn.operation === "prepare_context") {
    body = Buffer.from(
      `schema_version: 2.5.0\nartifact_type: context-pack\nrepository_sha: ${commit}\nobjective: fixture\n`,
    );
    kind = "project_brain_context_pack";
  } else {
    const sources = turn.source_artifact_ids.length
      ? (
          await getDatabasePool().query(
            "SELECT * FROM consensus_artifacts WHERE workspace_id=$1 AND artifact_id=ANY($2::uuid[]) ORDER BY created_at",
            [workspaceId, turn.source_artifact_ids],
          )
        ).rows
      : [];
    const value = transformArtifact(artifactBody(turn, state, sources), turn);
    body = Buffer.from(JSON.stringify(value));
    kind = {
      proposal: "consensus_proposal",
      critique: "consensus_critique",
      revision: "consensus_revision",
      canonicalize: "canonical_implementation_plan",
      verdict: "canonical_plan_verdict",
    }[turn.operation];
  }
  const checksum = createHash("sha256").update(body).digest("hex");
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionArtifactSubmitted", {
      name: kind,
      artifactType: kind,
      mediaType: turn.operation === "prepare_context" ? "application/yaml" : "application/json",
      byteSize: body.length,
      checksum,
      contentBase64: body.toString("base64"),
      repositoryCommit: commit,
    }),
    credential,
  );
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionSucceeded", {
      summary: `${turn.operation} complete`,
      usage: { runtime: "fixture", model: "default", durationMs: 10 },
      providerDiagnostics: Array.from({ length: diagnosticCount }, (_, index) => {
        const diagnostic = successfulProviderDiagnostic({
          provider: turn.provider_id,
          modelId: turn.model_id,
          runtimeProfileId: turn.provider_runtime_requirements_id,
          runtimeProfileHash: turn.provider_runtime_requirements_hash,
          attempt: turn.attempt ?? 1,
        });
        const finalAttempt = index === diagnosticCount - 1;
        return {
          ...diagnostic,
          providerAttemptId: `${turn.attempt ?? 1}-${index + 1}`,
          exitCode: finalAttempt ? 0 : 1,
          failedInitializationPhase: finalAttempt ? "none" : "provider_execution",
          stdoutHash: createHash("sha256").update(`stdout-${index}`).digest("hex"),
          stderrHash: createHash("sha256").update(`stderr-${index}`).digest("hex"),
        };
      }),
    }),
    credential,
  );
  return turn;
}

async function rebuildConsensusProjection(missionId) {
  const events = await loadAggregateEvents({
    workspaceId,
    aggregateType: "consensus_plan",
    aggregateId: missionId,
  });
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM consensus_objections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      missionId,
    ]);
    await client.query("DELETE FROM consensus_artifacts WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      missionId,
    ]);
    await client.query("DELETE FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2", [workspaceId, missionId]);
    await client.query("DELETE FROM consensus_participant_assignments WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      missionId,
    ]);
    await client.query("DELETE FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      missionId,
    ]);
    for (const event of events) await applyConsensusPlanProjection(client, [event]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function consensusDerivedSnapshot(missionId) {
  const tables = [
    ["consensus_plan_projections", "mission_id"],
    ["consensus_participant_assignments", "participant_assignment_id"],
    ["consensus_turns", "turn_id"],
    ["consensus_artifacts", "artifact_id"],
    ["consensus_objections", "objection_id"],
  ];
  return Object.fromEntries(
    await Promise.all(
      tables.map(async ([table, order]) => [
        table,
        (
          await getDatabasePool().query(
            `SELECT row_to_json(x) value FROM (SELECT * FROM ${table} WHERE workspace_id=$1 AND mission_id=$2 ORDER BY ${order}) x`,
            [workspaceId, missionId],
          )
        ).rows.map((row) => row.value),
      ]),
    ),
  );
}

test("initial planner failure atomically fences both outputs and cancels the sibling", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Fail fast when either independent planner fails",
    acceptanceCriteria: ["Sibling output is fenced before cancellation races"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  await completeNextTurn(created.missionId);
  const proposalTurns = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id,p.provider_id,p.model_id,p.provider_runtime_requirements_id,p.provider_runtime_requirements_hash
       FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation='proposal' ORDER BY t.created_at,t.turn_id`,
      [workspaceId, created.missionId],
    )
  ).rows;
  assert.equal(proposalTurns.length, 2);
  for (const proposalTurn of proposalTurns) {
    const participant = proposalTurn.agent_id === plannerA.agentId ? plannerA : plannerB;
    const leaseOwner = `fail-fast-${proposalTurn.agent_id}`;
    const claimed = await claimNextAssignment({ credential: participant.credentialRecord, leaseOwner });
    assert.equal(claimed.assignment.execution_id, proposalTurn.execution_id);
    await acknowledgeAssignment({
      credential: participant.credentialRecord,
      assignmentId: claimed.assignment.assignment_id,
      leaseOwner,
      leaseToken: claimed.leaseToken,
      fencingToken: Number(claimed.assignment.fencing_token),
    });
    await processRemoteMessage(
      envelope(proposalTurn, proposalTurn.agent_id, "ExecutionAccepted", { stage: "assignment_received" }),
      participant.credentialRecord,
    );
  }
  const [trigger, sibling] = proposalTurns;
  const triggerParticipant = trigger.agent_id === plannerA.agentId ? plannerA : plannerB;
  const siblingParticipant = sibling.agent_id === plannerA.agentId ? plannerA : plannerB;
  await processRemoteMessage(
    envelope(trigger, trigger.agent_id, "ExecutionFailed", {
      classification: "provider_sandbox_failure",
      summary: "deterministic triggering failure",
      providerDiagnostics: [
        {
          schemaVersion: "provider-runtime-diagnostic/1",
          provider: trigger.provider_id,
          requestedModel: trigger.model_id,
          cliVersion: trigger.provider_id === "codex" ? "codex-cli 0.146.0" : "Claude Code 2.1.224",
          runtimeProfileId: trigger.provider_runtime_requirements_id,
          runtimeProfileHash: trigger.provider_runtime_requirements_hash,
          sandboxProfileHash: "a".repeat(64),
          providerAttemptId: "1-1",
          processStartedAt: "2026-08-04T12:00:00.000Z",
          processTerminatedAt: "2026-08-04T12:00:01.000Z",
          exitCode: 1,
          terminationSignal: null,
          timedOut: false,
          cancellationRequested: false,
          stdoutHash: "b".repeat(64),
          stderrHash: "c".repeat(64),
          stdoutExcerpt: "",
          stderrExcerpt: "sandbox denied provider initialization",
          textAvailable: true,
          failedInitializationPhase: "sandbox_initialization",
          childProcess: {
            pid: 54322,
            processGroupId: 54322,
            detachedProcessGroup: true,
            processTreeTerminationAttempted: false,
            processTreeTerminationVerified: false,
          },
          sandboxDenial: { detected: true, excerpt: "sandbox denied provider initialization" },
          temporaryDirectoryIdentity: "d".repeat(64),
          workingDirectoryIdentity: "e".repeat(64),
          environmentVariableNames: ["HOME", "PATH"],
          localSecretScan: "passed_exact_and_pattern",
        },
        {
          ...successfulProviderDiagnostic({
            provider: trigger.provider_id,
            modelId: trigger.model_id,
            runtimeProfileId: trigger.provider_runtime_requirements_id,
            runtimeProfileHash: trigger.provider_runtime_requirements_hash,
            attempt: trigger.attempt ?? 1,
          }),
          providerAttemptId: "1-2",
          processStartedAt: "2026-08-04T12:00:02.000Z",
          processTerminatedAt: "2026-08-04T12:00:03.000Z",
          exitCode: 1,
          stdoutExcerpt: "",
          stderrExcerpt: "provider retry failed",
          failedInitializationPhase: "provider_execution",
        },
      ],
    }),
    triggerParticipant.credentialRecord,
  );
  const state = (
    await getDatabasePool().query(
      "SELECT status,failure_reason FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, created.missionId],
    )
  ).rows[0];
  assert.equal(state.status, "failed");
  assert.match(state.failure_reason, /task\.failed/);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM provider_runtime_diagnostics WHERE workspace_id=$1 AND execution_id=$2 AND sandbox_profile_hash=$3",
        [workspaceId, trigger.execution_id, "a".repeat(64)],
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM provider_runtime_diagnostics WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, trigger.execution_id],
      )
    ).rows[0].count,
    2,
  );
  const fenced = (
    await getDatabasePool().query(
      `SELECT p.execution_id,p.output_fenced_at,p.output_fence_reason,e.cancellation_requested_at
       FROM pull_assignments p JOIN execution_projections e
         ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
       WHERE p.workspace_id=$1 AND p.execution_id=ANY($2::uuid[]) ORDER BY p.execution_id`,
      [workspaceId, proposalTurns.map((candidate) => candidate.execution_id)],
    )
  ).rows;
  assert.equal(fenced.length, 2);
  assert.ok(fenced.every((candidate) => candidate.output_fenced_at));
  assert.ok(fenced.every((candidate) => candidate.output_fence_reason === "initial_planner_terminal_failure"));
  assert.ok(fenced.find((candidate) => candidate.execution_id === sibling.execution_id).cancellation_requested_at);
  await assert.rejects(
    processRemoteMessage(
      envelope(sibling, sibling.agent_id, "ExecutionSucceeded", { summary: "late sibling success" }),
      siblingParticipant.credentialRecord,
    ),
    /output is fenced.*delayed provider output is rejected/,
  );
  await processRemoteMessage(
    envelope(sibling, sibling.agent_id, "ExecutionCancellationAcknowledged", {
      classification: "consensus_peer_failed",
    }),
    siblingParticipant.credentialRecord,
  );
  const afterCancellation = (
    await getDatabasePool().query(
      "SELECT status,failure_reason FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, created.missionId],
    )
  ).rows[0];
  assert.equal(afterCancellation.status, "failed");
  assert.equal(afterCancellation.failure_reason, state.failure_reason);
});

test("a planner artifact validated before sibling failure is rejected at the canonical append fence", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Serialize planner failure against a concurrently validated sibling artifact",
    acceptanceCriteria: ["The aggregate append fence rejects the losing sibling output"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  await completeNextTurn(created.missionId);
  const turns = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation='proposal' ORDER BY t.created_at,t.turn_id`,
      [workspaceId, created.missionId],
    )
  ).rows;
  for (const turn of turns) {
    const participant = turn.agent_id === plannerA.agentId ? plannerA : plannerB;
    const leaseOwner = `append-race-${turn.agent_id}`;
    const claimed = await claimNextAssignment({ credential: participant.credentialRecord, leaseOwner });
    await acknowledgeAssignment({
      credential: participant.credentialRecord,
      assignmentId: claimed.assignment.assignment_id,
      leaseOwner,
      leaseToken: claimed.leaseToken,
      fencingToken: Number(claimed.assignment.fencing_token),
    });
    await processRemoteMessage(
      envelope(turn, turn.agent_id, "ExecutionAccepted", { stage: "assignment_received" }),
      participant.credentialRecord,
    );
  }
  const [trigger, sibling] = turns;
  const triggerParticipant = trigger.agent_id === plannerA.agentId ? plannerA : plannerB;
  const state = (
    await getDatabasePool().query("SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      created.missionId,
    ])
  ).rows[0];
  const body = Buffer.from(JSON.stringify(artifactBody(sibling, state, [])));
  let signalValidated;
  let releaseAppend;
  const validated = new Promise((resolve) => (signalValidated = resolve));
  const release = new Promise((resolve) => (releaseAppend = resolve));
  const artifactOutcome = recordConsensusArtifact({
    actor: owner,
    messageId: randomUUID(),
    missionId: created.missionId,
    taskId: sibling.task_id,
    executionId: sibling.execution_id,
    artifactId: randomUUID(),
    artifactKind: "consensus_proposal",
    artifactChecksum: createHash("sha256").update(body).digest("hex"),
    body,
    afterValidation: async () => {
      signalValidated();
      await release;
    },
  }).then(
    () => undefined,
    (error) => error,
  );
  await validated;
  await processRemoteMessage(
    envelope(trigger, trigger.agent_id, "ExecutionFailed", {
      classification: "provider_sandbox_failure",
      summary: "wins the aggregate terminal transition",
    }),
    triggerParticipant.credentialRecord,
  );
  releaseAppend();
  const artifactError = await artifactOutcome;
  assert.ok(artifactError instanceof Error);
  assert.match(artifactError.message, /fenced before its canonical append/);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM consensus_artifacts WHERE workspace_id=$1 AND turn_id=$2",
        [workspaceId, sibling.turn_id],
      )
    ).rows[0].count,
    0,
  );
});

test("invalid provider telemetry cannot make an execution terminally successful", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Validate provider telemetry before terminal success",
    acceptanceCriteria: ["A model mismatch remains non-successful"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  await completeNextTurn(created.missionId);
  const turn = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id,p.provider_id,p.model_id,p.provider_runtime_requirements_id,p.provider_runtime_requirements_hash
       FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation='proposal' ORDER BY t.created_at,t.turn_id LIMIT 1`,
      [workspaceId, created.missionId],
    )
  ).rows[0];
  const participant = turn.agent_id === plannerA.agentId ? plannerA : plannerB;
  const claimed = await claimNextAssignment({
    credential: participant.credentialRecord,
    leaseOwner: "telemetry-fence",
  });
  await acknowledgeAssignment({
    credential: participant.credentialRecord,
    assignmentId: claimed.assignment.assignment_id,
    leaseOwner: "telemetry-fence",
    leaseToken: claimed.leaseToken,
    fencingToken: Number(claimed.assignment.fencing_token),
  });
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionAccepted", { stage: "assignment_received" }),
    participant.credentialRecord,
  );
  const state = (
    await getDatabasePool().query("SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      created.missionId,
    ])
  ).rows[0];
  const body = Buffer.from(JSON.stringify(artifactBody(turn, state, [])));
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionArtifactSubmitted", {
      name: "consensus_proposal",
      artifactType: "consensus_proposal",
      mediaType: "application/json",
      byteSize: body.length,
      checksum: createHash("sha256").update(body).digest("hex"),
      contentBase64: body.toString("base64"),
      repositoryCommit: commit,
    }),
    participant.credentialRecord,
  );
  await assert.rejects(
    processRemoteMessage(
      envelope(turn, turn.agent_id, "ExecutionSucceeded", {
        summary: "must not succeed without invocation evidence",
        usage: { runtime: "fixture", model: turn.model_id },
      }),
      participant.credentialRecord,
    ),
    /requires complete invocation diagnostics/,
  );
  await assert.rejects(
    processRemoteMessage(
      envelope(turn, turn.agent_id, "ExecutionSucceeded", {
        summary: "must not become successful",
        providerDiagnostics: [
          successfulProviderDiagnostic({
            provider: turn.provider_id,
            modelId: turn.model_id,
            runtimeProfileId: turn.provider_runtime_requirements_id,
            runtimeProfileHash: turn.provider_runtime_requirements_hash,
            attempt: turn.attempt ?? 1,
          }),
        ],
        usage: { runtime: "fixture", requestedPrimaryModel: "unauthorized-model" },
      }),
      participant.credentialRecord,
    ),
    /primary model does not match/,
  );
  const execution = (
    await getDatabasePool().query(
      "SELECT status FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
      [workspaceId, turn.execution_id],
    )
  ).rows[0];
  assert.equal(execution.status, "verifying");
  assert.notEqual(
    (
      await getDatabasePool().query("SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2", [
        workspaceId,
        turn.task_id,
      ])
    ).rows[0].status,
    "completed",
  );
  await processRemoteMessage(
    envelope(turn, turn.agent_id, "ExecutionFailed", {
      classification: "invalid_provider_telemetry",
      summary: "test cleanup",
    }),
    participant.credentialRecord,
  );
  const sibling = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation='proposal' AND t.execution_id<>$3`,
      [workspaceId, created.missionId, turn.execution_id],
    )
  ).rows[0];
  const siblingParticipant = sibling.agent_id === plannerA.agentId ? plannerA : plannerB;
  await processRemoteMessage(
    envelope(sibling, sibling.agent_id, "ExecutionCancellationAcknowledged", {
      classification: "invalid_provider_telemetry_peer_cleanup",
    }),
    siblingParticipant.credentialRecord,
  );
});

test("0.8.0 rejects the unimplemented non-executor review option instead of advertising it", async () => {
  await assert.rejects(
    createConsensusPlanMission({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      objective: "Do not misrepresent provider review support",
      acceptanceCriteria: ["Fail closed"],
      plannerA: { agentId: plannerA.agentId, modelId: "default" },
      plannerB: { agentId: plannerB.agentId, modelId: "default" },
      synthesizer: { agentId: plannerA.agentId, modelId: "default" },
      preferredExecutorAgentId: plannerA.agentId,
      preferredExecutorModelId: "default",
      requireImplementationReview: true,
    }),
    /disabled in Mission Agent 0\.8\.0/,
  );
});

test("an authenticated authority rebind after approval rejects the old plan and requires new approval", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Prove a granted approval cannot survive an authority rebinding",
    acceptanceCriteria: ["A fresh plan approval is required"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
    maximumRetryCount: 10,
  });
  for (let index = 0; index < 10; index += 1) await completeNextTurn(created.missionId);
  const before = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(before.state.status, "awaiting_human_approval");
  await decideApproval({
    workspaceId,
    approvalId: before.state.human_approval_id,
    granted: true,
    actorId: owner.userId,
    reason: "exact fixture approval before authority rebinding",
  });
  assert.equal((await getConsensusHistory(workspaceId, created.missionId)).state.status, "approved");
  const rebound = await configureDisposableRepositoryAuthority({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    implementationAgentIds: [plannerA.agentId, plannerB.agentId],
    validationCommands: [["npm", "test"]],
  });
  try {
    assert.notEqual(rebound.repository_authority_hash, before.state.repository_authority_hash);
    assert.deepEqual(
      (
        await getDatabasePool().query(
          `SELECT permissions FROM agent_resource_permissions
           WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3`,
          [workspaceId, plannerB.agentId, repositoryId],
        )
      ).rows[0].permissions,
      ["read", "isolated_worktree_write"],
    );
    await assert.rejects(
      createConsensusImplementationMission({
        actor: owner,
        commandId: randomUUID(),
        consensusMissionId: created.missionId,
        executorAgentId: plannerA.agentId,
        executorModelId: "default",
      }),
      /authority changed after human approval/,
    );
    const rejected = await getConsensusHistory(workspaceId, created.missionId);
    assert.equal(rejected.state.status, "rejected");
    assert.match(rejected.state.failure_reason, /new plan approval is required/);
    assert.equal(
      (
        await getDatabasePool().query(
          "SELECT status FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
          [workspaceId, before.state.human_approval_id],
        )
      ).rows[0].status,
      "granted",
    );
    await assert.rejects(
      createConsensusImplementationMission({
        actor: owner,
        commandId: randomUUID(),
        consensusMissionId: created.missionId,
        executorAgentId: plannerA.agentId,
        executorModelId: "default",
      }),
      /exact granted consensus approval is required/,
    );
  } finally {
    await configureDisposableRepositoryAuthority({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      implementationAgentIds: [plannerA.agentId],
      validationCommands: [["npm", "test"]],
    });
  }
});

test("Codex and Claude complete the bounded consensus flow and create one hash-bound child", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Plan the fixture safely",
    acceptanceCriteria: ["Pass"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
    maximumRetryCount: 10,
  });
  let maximumRetryTurn;
  for (let index = 0; index < 10; index += 1) {
    const turn = await completeNextTurn(created.missionId, (value) => value, index === 0 ? 11 : 1);
    if (index === 0) maximumRetryTurn = turn;
  }
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM provider_runtime_diagnostics WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, maximumRetryTurn.execution_id],
      )
    ).rows[0].count,
    11,
  );
  const history = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(history.state.status, "awaiting_human_approval");
  assert.equal(history.artifacts.filter((item) => item.artifact_kind === "consensus_proposal").length, 2);
  assert.equal(history.artifacts.length, 10);
  const proposalTurns = (
    await getDatabasePool().query(
      "SELECT source_artifact_ids FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND operation='proposal'",
      [workspaceId, created.missionId],
    )
  ).rows;
  assert.equal(proposalTurns.length, 2);
  assert.equal(
    proposalTurns.every((turn) => turn.source_artifact_ids.length === 0),
    true,
  );
  assert.match(history.state.canonical_plan_hash, /^[0-9a-f]{64}$/);
  const proposals = history.artifacts.filter((item) => item.artifact_kind === "consensus_proposal");
  assert.equal(
    proposals.every((item) => item.created_at !== null),
    true,
  );
  await assert.rejects(
    createConsensusImplementationMission({
      actor: owner,
      commandId: randomUUID(),
      consensusMissionId: created.missionId,
      executorAgentId: plannerA.agentId,
      executorModelId: "default",
    }),
    /exact granted consensus approval/,
  );
  await decideApproval({
    workspaceId,
    approvalId: history.state.human_approval_id,
    granted: true,
    actorId: owner.userId,
    reason: "fixture",
  });
  const approvedAction = (
    await getDatabasePool().query(
      "SELECT requested_action FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
      [workspaceId, history.state.human_approval_id],
    )
  ).rows[0].requested_action;
  assert.deepEqual(approvedAction.validationCommands, ["npm test"]);
  assert.equal(approvedAction.repositoryAuthorityHash, history.state.repository_authority_hash);
  await assert.rejects(
    getDatabasePool().query("UPDATE repositories SET push_allowed=true WHERE workspace_id=$1 AND repository_id=$2", [
      workspaceId,
      repositoryId,
    ]),
    /require a new authenticated authority binding/,
  );
  await assert.rejects(
    getDatabasePool().query(
      "UPDATE repositories SET validation_commands=$3::jsonb WHERE workspace_id=$1 AND repository_id=$2",
      [workspaceId, repositoryId, JSON.stringify([["npm", "run", "lint"]])],
    ),
    /require a new authenticated authority binding/,
  );
  const first = await createConsensusImplementationMission({
    actor: owner,
    commandId: randomUUID(),
    consensusMissionId: created.missionId,
    executorAgentId: plannerA.agentId,
    executorModelId: "default",
  });
  const duplicate = await createConsensusImplementationMission({
    actor: owner,
    commandId: randomUUID(),
    consensusMissionId: created.missionId,
    executorAgentId: plannerA.agentId,
    executorModelId: "default",
  });
  assert.equal(duplicate.missionId, first.missionId);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    createConsensusImplementationMission({
      actor: owner,
      commandId: randomUUID(),
      consensusMissionId: created.missionId,
      executorAgentId: plannerB.agentId,
      executorModelId: "default",
    }),
    /changed the human-approved executor or model/,
  );
  await assert.rejects(
    createConsensusImplementationMission({
      actor: owner,
      commandId: randomUUID(),
      consensusMissionId: created.missionId,
      executorAgentId: plannerA.agentId,
      executorModelId: "changed-model",
    }),
    /changed the human-approved executor or model/,
  );
  const child = (
    await getDatabasePool().query(
      "SELECT parent_consensus_mission_id,approved_plan_hash,base_commit FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, first.missionId],
    )
  ).rows[0];
  assert.equal(child.parent_consensus_mission_id, created.missionId);
  assert.equal(child.approved_plan_hash, history.state.canonical_plan_hash);
  assert.equal(child.base_commit, commit);
  const childAuthority = (
    await getDatabasePool().query(
      `SELECT approval_requirements FROM task_projections
       WHERE workspace_id=$1 AND mission_id=$2`,
      [workspaceId, first.missionId],
    )
  ).rows[0].approval_requirements;
  assert.equal(childAuthority.repositoryAuthorityHash, history.state.repository_authority_hash);
  assert.deepEqual(approvedAction.authorizedEffects, [
    "worktree.create",
    "worktree.write",
    "validation.run",
    "git.commit_local",
  ]);
  assert.deepEqual(approvedAction.prohibitedEffects, [
    "git.commit_provider",
    "git.push",
    "pull_request.create",
    "repository.merge",
    "repository.publish",
    "deployment.execute",
    "infrastructure.mutate",
  ]);
  const implementationClaim = await claimNextAssignment({
    credential: plannerA.credentialRecord,
    leaseOwner: "fixture-implementation",
  });
  assert.equal(implementationClaim.assignment.mission_id, first.missionId);
  assert.equal(implementationClaim.assignment.payload.approvedPlan.hash, history.state.canonical_plan_hash);
  assert.equal(
    implementationClaim.assignment.payload.approvedPlan.approvalReceipt.approvalId,
    history.state.human_approval_id,
  );
  assert.equal(implementationClaim.assignment.payload.approvedPlan.approvalReceipt.status, "granted");
  await assert.rejects(
    acknowledgeAssignment({
      credential: plannerA.credentialRecord,
      assignmentId: implementationClaim.assignment.assignment_id,
      leaseOwner: "fixture-implementation",
      leaseToken: implementationClaim.leaseToken,
      fencingToken: Number(implementationClaim.assignment.fencing_token),
      acknowledgedPlanHash: "0".repeat(64),
      acknowledgedAgentId: plannerA.agentId,
      acknowledgedProviderId: implementationClaim.assignment.payload.approvedPlan.executorAssignment.providerId,
      acknowledgedModelId: "default",
      acknowledgedRepositorySnapshot: implementationClaim.assignment.payload.approvedPlan.repositorySnapshot,
      acknowledgedRepositoryAuthorityHash: implementationClaim.assignment.payload.approvedPlan.repositoryAuthorityHash,
      acknowledgedContextPackHash: implementationClaim.assignment.payload.approvedPlan.contextPackHash,
      acknowledgedPermissionProfileHash:
        implementationClaim.assignment.payload.approvedPlan.executorAssignment.permissionProfileHash,
    }),
    /exact approved canonical plan hash/,
  );
  await acknowledgeAssignment({
    credential: plannerA.credentialRecord,
    assignmentId: implementationClaim.assignment.assignment_id,
    leaseOwner: "fixture-implementation",
    leaseToken: implementationClaim.leaseToken,
    fencingToken: Number(implementationClaim.assignment.fencing_token),
    acknowledgedPlanHash: history.state.canonical_plan_hash,
    acknowledgedAgentId: plannerA.agentId,
    acknowledgedProviderId: implementationClaim.assignment.payload.approvedPlan.executorAssignment.providerId,
    acknowledgedModelId: "default",
    acknowledgedRepositorySnapshot: implementationClaim.assignment.payload.approvedPlan.repositorySnapshot,
    acknowledgedRepositoryAuthorityHash: implementationClaim.assignment.payload.approvedPlan.repositoryAuthorityHash,
    acknowledgedContextPackHash: implementationClaim.assignment.payload.approvedPlan.contextPackHash,
    acknowledgedPermissionProfileHash:
      implementationClaim.assignment.payload.approvedPlan.executorAssignment.permissionProfileHash,
  });
  const approvalReceipt = implementationClaim.assignment.payload.approvedPlan.approvalReceipt;
  await processRemoteMessage(
    envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionAccepted", {
      stage: "assignment_received",
    }),
    plannerA.credentialRecord,
  );
  await assert.rejects(
    processRemoteMessage(
      envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionResumed", {
        approvalId: approvalReceipt.approvalId,
        actionHash: "0".repeat(64),
      }),
      plannerA.credentialRecord,
    ),
    /authority is missing, stale, or does not match/,
  );
  await processRemoteMessage(
    envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionResumed", {
      approvalId: approvalReceipt.approvalId,
      actionHash: approvalReceipt.actionHash,
    }),
    plannerA.credentialRecord,
  );
  const baseCommit = commit;
  const resultCommit = "e".repeat(40);
  const evidence = {};
  for (const [artifactType, body, repositoryCommit] of [
    [
      "implementation_plan",
      Buffer.from(JSON.stringify(implementationClaim.assignment.payload.approvedPlan.content)),
      baseCommit,
    ],
    ["git_patch", Buffer.from("diff --git a/fixture b/fixture\n+bounded\n"), baseCommit],
    ["validation_results", Buffer.from("$ npm test\nexit=0\n"), baseCommit],
    ["change_summary", Buffer.from("Bounded disposable implementation summary"), resultCommit],
  ]) {
    const checksum = createHash("sha256").update(body).digest("hex");
    const submitted = await processRemoteMessage(
      envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionArtifactSubmitted", {
        artifactType,
        mediaType: "text/plain",
        checksum,
        completeChecksum: checksum,
        contentBase64: body.toString("base64"),
        repositoryCommit,
      }),
      plannerA.credentialRecord,
    );
    evidence[artifactType] = { artifactId: submitted.artifactId, checksum };
  }
  const binding = implementationClaim.assignment.payload.approvedPlan.executorAssignment;
  const runtimeProfile = expectedProviderRuntimeProfileBindings(binding.providerId).find(
    (item) => item.profileId === binding.providerRuntimeRequirementsId,
  );
  const leaseAuthority = (
    await getDatabasePool().query(
      `SELECT lease_receipt_id,lease_token_fingerprint,lease_owner,lease_expires_at,fencing_token::text,status
         FROM pull_assignments WHERE workspace_id=$1 AND assignment_id=$2`,
      [workspaceId, implementationClaim.assignment.assignment_id],
    )
  ).rows[0];
  assert.ok(runtimeProfile);
  const assignmentAttempt = Number(implementationClaim.assignment.attempt);
  const providerAttemptId = `${assignmentAttempt}-1`;
  const lease = {
    assignmentId: implementationClaim.assignment.assignment_id,
    leaseOwner: "fixture-implementation",
    leaseToken: implementationClaim.leaseToken,
    fencingToken: Number(implementationClaim.assignment.fencing_token),
  };
  process.env.CONSENSUS_ACTIVE_PRESENTATION_FOCUSED_TEST = "true";
  const attemptMessage = envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionProgressReported", {
    stage: "provider_attempt_authority_bound",
    summary: "focused route fixture",
    progressPercent: 90,
    activeProviderAttempt: {
      providerAttemptId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      runtimeProfileId: binding.providerRuntimeRequirementsId,
      runtimeProfileHash: binding.providerRuntimeRequirementsHash,
    },
  });
  assert.equal((await protocolMessageRoute(signedExecutionRequest(plannerA, attemptMessage, lease))).status, 202);
  const presentationFor = (messageId) => ({
    schemaVersion: "execution-authority-presentation/1",
    workspaceId,
    parentMissionId: created.missionId,
    childMissionId: implementationClaim.assignment.mission_id,
    assignmentId: implementationClaim.assignment.assignment_id,
    assignmentAttempt,
    providerAttemptId,
    agentId: plannerA.agentId,
    providerId: binding.providerId,
    requestedModelId: binding.modelId,
    runtimeProfileId: binding.providerRuntimeRequirementsId,
    runtimeProfileHash: binding.providerRuntimeRequirementsHash,
    executableIdentitySha256: runtimeProfile.invokedExecutableIdentitySha256,
    executableSha256: runtimeProfile.invokedExecutableSha256,
    authenticationBindingSha256: runtimeProfile.providerCredentialIdentitySha256,
    capabilityAttestationId: binding.capabilityAttestationId,
    capabilityAttestationHash: binding.capabilityAttestationHash,
    repositoryId,
    repositorySnapshotSha256: implementationClaim.assignment.payload.approvedPlan.repositorySnapshot,
    repositoryAuthoritySha256: implementationClaim.assignment.payload.approvedPlan.repositoryAuthorityHash,
    contextSha256: implementationClaim.assignment.payload.approvedPlan.contextPackHash ?? null,
    canonicalPlanSha256: implementationClaim.assignment.payload.approvedPlan.hash,
    leaseReceiptId: leaseAuthority.lease_receipt_id,
    leaseTokenFingerprint: leaseAuthority.lease_token_fingerprint,
    leaseOwner: leaseAuthority.lease_owner,
    fencingToken: Number(leaseAuthority.fencing_token),
    operationIdentitySha256: canonicalHash({
      operation: "implement_change",
      assignmentId: lease.assignmentId,
      executionId: implementationClaim.assignment.execution_id,
    }),
    resultAttemptIdentitySha256: canonicalHash({
      executionId: implementationClaim.assignment.execution_id,
      assignmentAttempt,
      providerAttemptId,
      completionMessageId: messageId,
    }),
  });
  const scenarioDefinitions = [
    ["authority.changed_executable_rejected", "executable_identity", "executableIdentitySha256"],
    ["authority.changed_runtime_profile_rejected", "runtime_profile", "runtimeProfileHash"],
    ["authority.changed_authentication_binding_rejected", "authentication_binding", "authenticationBindingSha256"],
    ["authority.changed_repository_authority_rejected", "repository_authority", "repositoryAuthoritySha256"],
    ["authority.expired_capability_attestation_rejected", "capability_attestation_expiry", "capabilityAttestationHash"],
    ["authority.stale_lease_rejected", "lease_sequence", "leaseTokenFingerprint"],
    ["authority.stale_fencing_token_rejected", "fencing_token", "fencingToken"],
  ];
  for (const [requirementId, mutationKind, field] of scenarioDefinitions) {
    const messageId = randomUUID();
    const baselinePresentation = presentationFor(messageId);
    const attemptedPresentation = {
      ...baselinePresentation,
      [field]:
        field === "fencingToken"
          ? baselinePresentation.fencingToken - 1
          : canonicalHash({ field, changed: baselinePresentation[field] }),
    };
    const scenarioMessage = envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionSucceeded", {
      executionAuthorityPresentation: attemptedPresentation,
      acceptanceAuthorityPresentationScenario: {
        requirementId,
        scenarioId: `active-route:${requirementId}`,
        mutationKind,
        baselinePresentation,
      },
    });
    scenarioMessage.messageId = messageId;
    scenarioMessage.sentAt = new Date().toISOString();
    const response = await protocolMessageRoute(signedExecutionRequest(plannerA, scenarioMessage, lease));
    assert.equal(response.status, 400);
    const localState = canonicalHash({ head: commit, status: "" });
    const localObservationMessage = envelope(
      implementationClaim.assignment,
      plannerA.agentId,
      "ExecutionProgressReported",
      {
        stage: "authority_adversarial_local_state_verified",
        acceptanceAuthorityLocalStateObservation: {
          requirementId,
          rejectionMessageId: messageId,
          repositoryStateBeforeSha256: localState,
          repositoryStateAfterSha256: localState,
          repositoryHeadBefore: commit,
          repositoryHeadAfter: commit,
          repositoryStatusBeforeSha256: canonicalHash(""),
          repositoryStatusAfterSha256: canonicalHash(""),
        },
      },
    );
    const localObservationResponse = await protocolMessageRoute(
      signedExecutionRequest(plannerA, localObservationMessage, lease),
    );
    assert.equal(localObservationResponse.status, 202);
  }
  const activeObservations = (
    await getDatabasePool().query(
      `SELECT requirement_id,reason_code,assignment_status,baseline_valid,route_identity,
            durable_counts_before,durable_counts_after,to_jsonb(o)::text body
       FROM acceptance_authority_presentation_observations o
      WHERE workspace_id=$1 AND execution_id=$2 ORDER BY recorded_at`,
      [workspaceId, implementationClaim.assignment.execution_id],
    )
  ).rows;
  assert.equal(activeObservations.length, 7);
  assert.deepEqual(
    activeObservations.map((row) => row.reason_code),
    [
      "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED",
      "ASSIGNMENT_RUNTIME_PROFILE_CHANGED",
      "ASSIGNMENT_AUTHENTICATION_BINDING_CHANGED",
      "ASSIGNMENT_REPOSITORY_AUTHORITY_CHANGED",
      "CAPABILITY_ATTESTATION_EXPIRED",
      "ASSIGNMENT_LEASE_STALE",
      "ASSIGNMENT_FENCING_TOKEN_STALE",
    ],
  );
  assert.equal(
    activeObservations.every((row) => row.assignment_status === "acknowledged" && row.baseline_valid === true),
    true,
  );
  assert.equal(
    activeObservations.every(
      (row) => canonicalHash(row.durable_counts_before) === canonicalHash(row.durable_counts_after),
    ),
    true,
  );
  assert.equal(
    activeObservations.every((row) =>
      [
        "event_identities",
        "child_mission_state",
        "implementation_task_state",
        "implementation_result_state",
        "validation_receipt_identities",
        "artifact_identities",
        "repository_state",
      ].every((field) => Object.hasOwn(row.durable_counts_before, field)),
    ),
    true,
  );
  assert.equal(
    activeObservations.some((row) => row.body.includes(implementationClaim.leaseToken)),
    false,
  );
  const validatedAuthorityScenarios = await executePresentationAuthorityScenarios({
    executionId: implementationClaim.assignment.execution_id,
    assignmentId: implementationClaim.assignment.assignment_id,
    workspaceId,
    providerAttemptId,
  });
  assert.equal(validatedAuthorityScenarios.length, 7);
  await assert.rejects(
    getDatabasePool().query(
      "UPDATE acceptance_authority_presentation_observations SET scenario_id='changed' WHERE workspace_id=$1",
      [workspaceId],
    ),
    /immutable/,
  );
  await assert.rejects(
    getDatabasePool().query("DELETE FROM acceptance_authority_presentation_observations WHERE workspace_id=$1", [
      workspaceId,
    ]),
    /immutable/,
  );
  delete process.env.CONSENSUS_ACTIVE_PRESENTATION_FOCUSED_TEST;
  const completionMessageId = randomUUID();
  const completedAt = new Date().toISOString();
  const receipt = {
    validationReceiptId: implementationClaim.assignment.payload.approvedPlan.validationReceiptId,
    missionId: implementationClaim.assignment.mission_id,
    parentConsensusMissionId: created.missionId,
    taskId: implementationClaim.assignment.task_id,
    executionId: implementationClaim.assignment.execution_id,
    executionAttempt: implementationClaim.assignment.attempt,
    participantAssignmentId: binding.participantAssignmentId,
    agentId: plannerA.agentId,
    providerId: binding.providerId,
    modelId: binding.modelId,
    capabilityAttestationId: binding.capabilityAttestationId,
    capabilityAttestationHash: binding.capabilityAttestationHash,
    permissionProfileHash: binding.permissionProfileHash,
    baseCommit,
    resultCommit,
    canonicalPlanHash: history.state.canonical_plan_hash,
    patchArtifactId: evidence.git_patch.artifactId,
    patchChecksum: evidence.git_patch.checksum,
    validationArtifactId: evidence.validation_results.artifactId,
    validationChecksum: evidence.validation_results.checksum,
    summaryArtifactId: evidence.change_summary.artifactId,
    summaryChecksum: evidence.change_summary.checksum,
    validationCommandIdentities: [canonicalHash(["npm", "test"])],
    completedAt,
    leaseOwner: "fixture-implementation",
    fencingToken: Number(implementationClaim.assignment.fencing_token),
    provenanceMessageId: completionMessageId,
    runtimeModelIdentity: "unverifiable",
    requestedModelId: binding.modelId,
    actualModelId: null,
    executionAuthorityPresentation: presentationFor(completionMessageId),
    executionAuthorityPresentationSha256: canonicalHash(presentationFor(completionMessageId)),
  };
  const completion = envelope(implementationClaim.assignment, plannerA.agentId, "ExecutionSucceeded", {
    summary: "Bounded disposable implementation completed",
    baseCommit,
    commitId: resultCommit,
    requestedModelId: binding.modelId,
    actualModelId: null,
    runtimeModelIdentity: "unverifiable",
    validationReceiptHash: canonicalHash(receipt),
    executionAuthorityPresentation: presentationFor(completionMessageId),
    usage: { durationMs: 1, toolCalls: 1, model: binding.modelId },
    providerDiagnostics: [
      successfulProviderDiagnostic({
        provider: binding.providerId,
        modelId: binding.modelId,
        runtimeProfileId: binding.providerRuntimeRequirementsId,
        runtimeProfileHash: binding.providerRuntimeRequirementsHash,
        attempt: implementationClaim.assignment.attempt,
      }),
    ],
  });
  completion.messageId = completionMessageId;
  completion.sentAt = completedAt;
  assert.deepEqual(await processRemoteMessage(completion, plannerA.credentialRecord), { status: "completed" });
  const durableReceipt = await getDatabasePool().query(
    "SELECT receipt_hash,model_id,base_commit,result_commit FROM consensus_execution_validation_receipts WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, implementationClaim.assignment.execution_id],
  );
  assert.equal(durableReceipt.rowCount, 1);
  assert.equal(durableReceipt.rows[0].receipt_hash, canonicalHash(receipt));
  assert.equal(durableReceipt.rows[0].model_id, "default");
  assert.equal(durableReceipt.rows[0].base_commit, baseCommit);
  assert.equal(durableReceipt.rows[0].result_commit, resultCommit);
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2", [
        workspaceId,
        first.missionId,
      ])
    ).rows[0].status,
    "completed",
  );
  const secondaryApprovals = await getDatabasePool().query(
    "SELECT 1 FROM approval_projections WHERE workspace_id=$1 AND mission_id=$2 AND approval_type='remote_workflow'",
    [workspaceId, first.missionId],
  );
  assert.equal(secondaryApprovals.rowCount, 0);
  assert.equal(
    canonicalHash(
      history.artifacts.find((item) => item.artifact_kind === "canonical_implementation_plan").normalized_payload,
    ),
    history.state.canonical_plan_hash,
  );

  await rebuildConsensusProjection(created.missionId);
  const replayed = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(replayed.state.canonical_plan_hash, history.state.canonical_plan_hash);
  assert.equal(replayed.state.implementation_mission_id, first.missionId);
  assert.equal(
    canonicalHash(
      replayed.artifacts.find((item) => item.artifact_kind === "canonical_implementation_plan").normalized_payload,
    ),
    history.state.canonical_plan_hash,
  );
});

test("provider objection labels resolve through canonical IDs and replay exactly", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Resolve colliding provider objection labels",
    acceptanceCriteria: ["Both exact critiques are addressed"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  const withResolvedObjections = (value, turn) => {
    if (turn.operation === "critique")
      return {
        ...value,
        verdict: "accept_with_changes",
        blocking_objections: [
          {
            id: "B1",
            category: "testing",
            description: `Planner ${turn.participant_assignment_id} requires a bound test`,
            required_change: "Add the exact bound test",
          },
        ],
      };
    if (turn.operation === "revision") return { ...value, resolved_objection_ids: ["B1"] };
    return value;
  };
  for (let index = 0; index < 10; index += 1) await completeNextTurn(created.missionId, withResolvedObjections);
  const history = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(history.state.status, "awaiting_human_approval");
  assert.equal(history.objections.length, 2);
  assert.equal(new Set(history.objections.map((item) => item.objection_id)).size, 2);
  assert.deepEqual(new Set(history.objections.map((item) => item.raw_provider_objection_id)), new Set(["B1"]));
  assert.equal(
    history.objections.every((item) => item.status === "resolved"),
    true,
  );
  assert.equal(
    history.objections.every((item) => item.resolved_by_artifact_id),
    true,
  );
  const live = await consensusDerivedSnapshot(created.missionId);
  await rebuildConsensusProjection(created.missionId);
  const replayed = await consensusDerivedSnapshot(created.missionId);
  assert.deepEqual(replayed, live);
});

test("unknown and wrong-source provider objection resolutions fail closed", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Reject ambiguous objection resolution",
    acceptanceCriteria: ["Only exact critique provenance resolves"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  const critiques = (value, turn) =>
    turn.operation === "critique"
      ? {
          ...value,
          verdict: "accept_with_changes",
          blocking_objections: [
            { id: "B1", category: "testing", description: "Bound objection", required_change: "Bound change" },
          ],
        }
      : value;
  for (let index = 0; index < 5; index += 1) await completeNextTurn(created.missionId, critiques);
  const revisionTurn = (
    await getDatabasePool().query(
      `SELECT * FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND operation='revision'
       AND status='requested' ORDER BY created_at LIMIT 1`,
      [workspaceId, created.missionId],
    )
  ).rows[0];
  const state = (
    await getDatabasePool().query("SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      created.missionId,
    ])
  ).rows[0];
  const sources = (
    await getDatabasePool().query(
      "SELECT * FROM consensus_artifacts WHERE workspace_id=$1 AND artifact_id=ANY($2::uuid[]) ORDER BY created_at",
      [workspaceId, revisionTurn.source_artifact_ids],
    )
  ).rows;
  const otherCritique = (
    await getDatabasePool().query(
      `SELECT artifact_id FROM consensus_artifacts WHERE workspace_id=$1 AND mission_id=$2
       AND artifact_kind='consensus_critique' AND NOT artifact_id=ANY($3::uuid[]) LIMIT 1`,
      [workspaceId, created.missionId, revisionTurn.source_artifact_ids],
    )
  ).rows[0];
  for (const [changed, expected] of [
    [{ addresses_critique_artifact_id: otherCritique.artifact_id }, /outside its released source package/],
    [{ assignment_id: randomUUID() }, /mission or assignment binding does not match/],
  ]) {
    const body = Buffer.from(JSON.stringify({ ...artifactBody(revisionTurn, state, sources), ...changed }));
    await assert.rejects(
      recordConsensusArtifact({
        actor: owner,
        messageId: randomUUID(),
        missionId: created.missionId,
        taskId: revisionTurn.task_id,
        executionId: revisionTurn.execution_id,
        artifactId: randomUUID(),
        artifactKind: "consensus_revision",
        artifactChecksum: createHash("sha256").update(body).digest("hex"),
        body,
      }),
      expected,
    );
  }
  await assert.rejects(
    completeNextTurn(created.missionId, (value, turn) =>
      turn.operation === "revision" ? { ...value, resolved_objection_ids: ["unknown"] } : value,
    ),
    /unknown provider objection ID for its exact critique/,
  );
  const history = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(history.objections.length, 2);
  assert.equal(
    history.objections.every((item) => item.status === "open"),
    true,
  );
  const active = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.status='requested' ORDER BY t.created_at LIMIT 1`,
      [workspaceId, created.missionId],
    )
  ).rows[0];
  const credential = active.agent_id === plannerA.agentId ? plannerA.credentialRecord : plannerB.credentialRecord;
  await processRemoteMessage(
    envelope(active, active.agent_id, "ExecutionFailed", {
      classification: "adversarial_fixture_cleanup",
      summary: "Dispose the intentionally rejected revision turn",
    }),
    credential,
  );
  for (const sibling of (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       JOIN execution_projections e ON e.workspace_id=t.workspace_id AND e.execution_id=t.execution_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND e.cancellation_requested_at IS NOT NULL
         AND e.status NOT IN('succeeded','failed','timed_out','cancelled')`,
      [workspaceId, created.missionId],
    )
  ).rows) {
    const siblingCredential =
      sibling.agent_id === plannerA.agentId ? plannerA.credentialRecord : plannerB.credentialRecord;
    await processRemoteMessage(
      envelope(sibling, sibling.agent_id, "ExecutionCancellationAcknowledged", {
        classification: "adversarial_fixture_cleanup",
      }),
      siblingCredential,
    );
  }
});

test("a reject verdict with a blocker cannot produce consensus or human approval", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Reject a blocked canonical plan",
    acceptanceCriteria: ["No approval when a planner rejects"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  for (let index = 0; index < 8; index += 1) await completeNextTurn(created.missionId);
  await completeNextTurn(created.missionId, (value, turn) =>
    turn.operation === "verdict"
      ? { ...value, verdict: "reject", blocking_objections: ["Deterministic fixture blocker"] }
      : value,
  );
  await completeNextTurn(created.missionId);
  const history = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(history.state.status, "consensus_not_reached");
  assert.equal(history.state.consensus_decision, "not_reached");
  assert.equal(history.state.human_approval_id, null);
  assert.equal(
    history.artifacts.filter((item) => item.artifact_kind === "canonical_plan_verdict" && item.verdict === "reject")
      .length,
    1,
  );
  assert.equal(
    history.objections.some((item) => item.status === "open"),
    true,
  );
});

test("unknown provider cost stops a cost-capped mission before another round", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Budget-bound fixture",
    acceptanceCriteria: ["Do not exceed unknown cost"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerB.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
    maximumCostAmount: 1,
  });
  await completeNextTurn(created.missionId);
  const history = await getConsensusHistory(workspaceId, created.missionId);
  assert.equal(history.state.status, "consensus_not_reached");
  assert.equal(
    history.usage.some((item) => item.cost_confidence === "unknown"),
    true,
  );
  const proposals = await getDatabasePool().query(
    "SELECT 1 FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND operation='proposal'",
    [workspaceId, created.missionId],
  );
  assert.equal(proposals.rowCount, 0);
});

test("a participant that becomes unhealthy at a phase boundary stops without an orphan turn", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Stop safely when the next planner phase is no longer eligible",
    acceptanceCriteria: ["No orphan revision task"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  for (let index = 0; index < 4; index += 1) await completeNextTurn(created.missionId);
  await getDatabasePool().query(
    "UPDATE agents SET last_heartbeat_at=now()-interval '10 minutes',pull_ready_at=now()-interval '10 minutes' WHERE workspace_id=$1 AND agent_id=$2",
    [workspaceId, plannerA.agentId],
  );
  try {
    await completeNextTurn(created.missionId);
    const history = await getConsensusHistory(workspaceId, created.missionId);
    assert.equal(history.state.status, "consensus_not_reached");
    assert.match(history.state.failure_reason, /became ineligible/i);
    assert.equal(
      (
        await getDatabasePool().query(
          "SELECT count(*)::int count FROM task_projections WHERE workspace_id=$1 AND mission_id=$2 AND name LIKE '%revision%'",
          [workspaceId, created.missionId],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await getDatabasePool().query(
      "UPDATE agents SET last_heartbeat_at=now(),pull_ready_at=now() WHERE workspace_id=$1 AND agent_id=$2",
      [workspaceId, plannerA.agentId],
    );
  }
});

test("an approved consensus plan fails closed when the repository changes before child creation", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Reject a stale implementation snapshot",
    acceptanceCriteria: ["No stale child mission"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  for (let index = 0; index < 10; index += 1) await completeNextTurn(created.missionId);
  const history = await getConsensusHistory(workspaceId, created.missionId);
  await decideApproval({
    workspaceId,
    approvalId: history.state.human_approval_id,
    granted: true,
    actorId: owner.userId,
    reason: "fixture",
  });
  await getDatabasePool().query(
    "UPDATE repositories SET observed_commit=$3 WHERE workspace_id=$1 AND repository_id=$2",
    [workspaceId, repositoryId, "d".repeat(40)],
  );
  try {
    await assert.rejects(
      createConsensusImplementationMission({
        actor: owner,
        commandId: randomUUID(),
        consensusMissionId: created.missionId,
        executorAgentId: plannerA.agentId,
        executorModelId: "default",
      }),
      /repository changed after consensus/i,
    );
    const stale = await getConsensusHistory(workspaceId, created.missionId);
    assert.equal(stale.state.status, "approved");
    assert.ok(stale.state.stale_at);
    assert.match(stale.state.failure_reason, /repository changed/i);
    assert.equal(stale.state.implementation_mission_id, null);
  } finally {
    await getDatabasePool().query(
      "UPDATE repositories SET observed_commit=$3 WHERE workspace_id=$1 AND repository_id=$2",
      [workspaceId, repositoryId, commit],
    );
  }
});

test("malformed bindings, wrong verdict hashes, duplicate transport, stale leases, and cancellation fail closed", async () => {
  const created = await createConsensusPlanMission({
    actor: owner,
    commandId: randomUUID(),
    repositoryId,
    objective: "Exercise adversarial consensus submissions",
    acceptanceCriteria: ["Every invalid submission is rejected"],
    plannerA: { agentId: plannerA.agentId, modelId: "default" },
    plannerB: { agentId: plannerB.agentId, modelId: "default" },
    synthesizer: { agentId: plannerA.agentId, modelId: "default" },
    preferredExecutorAgentId: plannerA.agentId,
    preferredExecutorModelId: "default",
  });
  await completeNextTurn(created.missionId);
  const proposalTurn = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation='proposal' AND t.status='requested'
       ORDER BY t.created_at LIMIT 1`,
      [workspaceId, created.missionId],
    )
  ).rows[0];
  const proposalState = (
    await getDatabasePool().query("SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      created.missionId,
    ])
  ).rows[0];
  const malformed = Buffer.from(JSON.stringify({ schema_version: "consensus-plan-proposal/1" }));
  await assert.rejects(
    recordConsensusArtifact({
      actor: owner,
      messageId: randomUUID(),
      missionId: created.missionId,
      taskId: proposalTurn.task_id,
      executionId: proposalTurn.execution_id,
      artifactId: randomUUID(),
      artifactKind: "consensus_proposal",
      artifactChecksum: createHash("sha256").update(malformed).digest("hex"),
      body: malformed,
    }),
    /required|schema/i,
  );
  const wrongContext = Buffer.from(
    JSON.stringify({
      ...artifactBody(proposalTurn, proposalState, []),
      context_pack_hash: "0".repeat(64),
    }),
  );
  await assert.rejects(
    recordConsensusArtifact({
      actor: owner,
      messageId: randomUUID(),
      missionId: created.missionId,
      taskId: proposalTurn.task_id,
      executionId: proposalTurn.execution_id,
      artifactId: randomUUID(),
      artifactKind: "consensus_proposal",
      artifactChecksum: createHash("sha256").update(wrongContext).digest("hex"),
      body: wrongContext,
    }),
    /snapshot or context binding does not match/,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int count FROM consensus_artifacts WHERE workspace_id=$1 AND turn_id=$2",
        [workspaceId, proposalTurn.turn_id],
      )
    ).rows[0].count,
    0,
  );

  await completeNextTurn(created.missionId);
  await completeNextTurn(created.missionId);
  await rebuildConsensusProjection(created.missionId);
  for (let index = 0; index < 5; index += 1) await completeNextTurn(created.missionId);
  const verdictTurn = (
    await getDatabasePool().query(
      `SELECT t.*,p.agent_id FROM consensus_turns t JOIN consensus_participant_assignments p
       ON p.workspace_id=t.workspace_id AND p.participant_assignment_id=t.participant_assignment_id
       WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation='verdict' AND t.status='requested'
       ORDER BY t.created_at LIMIT 1`,
      [workspaceId, created.missionId],
    )
  ).rows[0];
  const verdictState = (
    await getDatabasePool().query("SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2", [
      workspaceId,
      created.missionId,
    ])
  ).rows[0];
  const verdictSource = (
    await getDatabasePool().query(
      "SELECT * FROM consensus_artifacts WHERE workspace_id=$1 AND artifact_id=ANY($2::uuid[])",
      [workspaceId, verdictTurn.source_artifact_ids],
    )
  ).rows;
  const wrongVerdict = Buffer.from(
    JSON.stringify({
      ...artifactBody(verdictTurn, verdictState, verdictSource),
      canonical_plan_hash: "0".repeat(64),
    }),
  );
  await assert.rejects(
    recordConsensusArtifact({
      actor: owner,
      messageId: randomUUID(),
      missionId: created.missionId,
      taskId: verdictTurn.task_id,
      executionId: verdictTurn.execution_id,
      artifactId: randomUUID(),
      artifactKind: "canonical_plan_verdict",
      artifactChecksum: createHash("sha256").update(wrongVerdict).digest("hex"),
      body: wrongVerdict,
    }),
    /does not bind the active canonical plan and hash/,
  );

  const credential = verdictTurn.agent_id === plannerA.agentId ? plannerA.credentialRecord : plannerB.credentialRecord;
  const oldLease = await claimNextAssignment({ credential, leaseOwner: "adversarial-old" });
  assert.equal(oldLease.assignment.execution_id, verdictTurn.execution_id);
  await getDatabasePool().query(
    "UPDATE pull_assignments SET lease_expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND assignment_id=$2",
    [workspaceId, oldLease.assignment.assignment_id],
  );
  const replacementLease = await claimNextAssignment({ credential, leaseOwner: "adversarial-new" });
  await assert.rejects(
    acknowledgeAssignment({
      credential,
      assignmentId: oldLease.assignment.assignment_id,
      leaseOwner: "adversarial-old",
      leaseToken: oldLease.leaseToken,
      fencingToken: Number(oldLease.assignment.fencing_token),
    }),
    /lease is invalid or expired/,
  );
  await acknowledgeAssignment({
    credential,
    assignmentId: replacementLease.assignment.assignment_id,
    leaseOwner: "adversarial-new",
    leaseToken: replacementLease.leaseToken,
    fencingToken: Number(replacementLease.assignment.fencing_token),
  });
  await getDatabasePool().query(
    `UPDATE agents SET capability_attestation_expires_at=now()-interval '1 second'
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, verdictTurn.agent_id],
  );
  await assert.rejects(
    renewAssignmentLease({
      credential,
      assignmentId: replacementLease.assignment.assignment_id,
      leaseOwner: "adversarial-new",
      leaseToken: replacementLease.leaseToken,
      fencingToken: Number(replacementLease.assignment.fencing_token),
    }),
    /eligibility was revoked/,
  );
  await getDatabasePool().query(
    `UPDATE agents SET capability_attestation_expires_at=now()+interval '5 minutes'
     WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, verdictTurn.agent_id],
  );
  await processRemoteMessage(
    envelope(verdictTurn, verdictTurn.agent_id, "ExecutionAccepted", { stage: "assignment_received" }),
    credential,
  );
  await handleExecutionCancellation({
    actor: { workspaceId, id: owner.userId, type: "human" },
    commandId: randomUUID(),
    executionId: verdictTurn.execution_id,
  });
  await processRemoteMessage(
    envelope(verdictTurn, verdictTurn.agent_id, "ExecutionCancellationAcknowledged", {
      classification: "forced_acceptance_cancellation",
    }),
    credential,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT status FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
        [workspaceId, verdictTurn.execution_id],
      )
    ).rows[0].status,
    "cancelled",
  );
  await assert.rejects(
    claimNextAssignment({
      credential,
      leaseOwner: "cancelled-exact-claim",
      assignmentId: oldLease.assignment.assignment_id,
    }),
    (error) =>
      error?.code === "validation_failed" && error?.details?.reason_code === "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
  );
  await assert.rejects(
    processRemoteMessage(
      envelope(verdictTurn, verdictTurn.agent_id, "ExecutionSucceeded", { summary: "stale completion" }),
      credential,
    ),
    /terminal \(cancelled\).*rejected/,
  );

  const duplicateMessage = envelope(verdictTurn, verdictTurn.agent_id, "ExecutionCancellationAcknowledged", {
    classification: "duplicate_transport_fixture",
  });
  const nonce = randomUUID();
  const checksum = createHash("sha256").update(JSON.stringify(duplicateMessage)).digest("hex");
  assert.deepEqual(await reserveProtocolMessage({ credential, message: duplicateMessage, nonce, checksum }), {
    duplicate: false,
  });
  const acknowledgement = { status: "cancelled" };
  await completeProtocolMessage(credential, duplicateMessage.messageId, acknowledgement);
  const duplicateReceipt = await reserveProtocolMessage({ credential, message: duplicateMessage, nonce, checksum });
  assert.equal(duplicateReceipt.duplicate, true);
  assert.equal(duplicateReceipt.acknowledgement.status, "completed");
  assert.equal(duplicateReceipt.acknowledgement.messageId, duplicateMessage.messageId);
  assert.match(duplicateReceipt.acknowledgement.responseChecksum, /^[a-f0-9]{64}$/);
});

test("known-assignment claim accepts an available assignment and rejects the exact never-leased cancelled assignment", async () => {
  const createFixture = async (objective) => {
    const mission = await createConsensusPlanMission({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      objective,
      acceptanceCriteria: ["Exercise the exact known-assignment claim lifecycle boundary."],
      plannerA: { agentId: plannerA.agentId, modelId: "default" },
      plannerB: { agentId: plannerB.agentId, modelId: "default" },
      synthesizer: { agentId: plannerA.agentId, modelId: "default" },
      preferredExecutorAgentId: plannerA.agentId,
      preferredExecutorModelId: "default",
    });
    const assignment = (
      await getDatabasePool().query(
        `SELECT p.assignment_id,p.execution_id,p.agent_id,p.status,p.lease_receipt_id,
           p.lease_owner,p.lease_expires_at,p.fencing_token::int
         FROM pull_assignments p
         WHERE p.workspace_id=$1 AND p.mission_id=$2
         ORDER BY p.created_at LIMIT 1`,
        [workspaceId, mission.missionId],
      )
    ).rows[0];
    assert.ok(assignment);
    return { mission, assignment };
  };
  const registrationFor = (agentId) => (agentId === plannerA.agentId ? plannerA : plannerB);

  const positive = await createFixture("Positive known-assignment claim fixture");
  assert.equal(positive.assignment.status, "available");
  const positiveResponse = await assignmentPullRoute(
    signedKnownAssignmentPullRequest(
      registrationFor(positive.assignment.agent_id),
      positive.assignment.assignment_id,
      "positive-known-assignment",
    ),
  );
  assert.equal(positiveResponse.status, 200);
  const positiveClaim = await positiveResponse.json();
  assert.equal(positiveClaim.assignment.assignmentId, positive.assignment.assignment_id);
  assert.ok(positiveClaim.assignment.leaseToken);
  assert.equal(positiveClaim.assignment.fencingToken, 1);
  await handleExecutionCancellation({
    actor: { workspaceId, id: owner.userId, type: "human" },
    commandId: randomUUID(),
    executionId: positive.assignment.execution_id,
  });
  await handleExecutionTransition({
    actor: { workspaceId, id: owner.userId, type: "human" },
    commandId: randomUUID(),
    executionId: positive.assignment.execution_id,
    target: "cancelled",
  });
  await cancelConsensusForAcceptanceSourceClosure({ actor: owner, missionId: positive.mission.missionId });

  const cancelled = await createFixture("Cancelled known-assignment claim fixture");
  assert.equal(cancelled.assignment.status, "available");
  assert.equal(cancelled.assignment.lease_receipt_id, null);
  assert.equal(cancelled.assignment.lease_owner, null);
  assert.equal(cancelled.assignment.lease_expires_at, null);
  assert.equal(cancelled.assignment.fencing_token, 0);
  const cancellationCommandId = randomUUID();
  await handleExecutionCancellation({
    actor: { workspaceId, id: owner.userId, type: "human" },
    commandId: cancellationCommandId,
    executionId: cancelled.assignment.execution_id,
  });
  const cancellationCompletionCommandId = randomUUID();
  await handleExecutionTransition({
    actor: { workspaceId, id: owner.userId, type: "human" },
    commandId: cancellationCompletionCommandId,
    executionId: cancelled.assignment.execution_id,
    target: "cancelled",
    details: { reason: "governed_known_assignment_cancellation_fixture" },
  });
  await cancelConsensusForAcceptanceSourceClosure({ actor: owner, missionId: cancelled.mission.missionId });

  const readState = async () =>
    (
      await getDatabasePool().query(
        `SELECT p.status assignment_status,p.lease_receipt_id,p.lease_owner,p.lease_expires_at,
           p.fencing_token::int,e.status execution_status,
           (SELECT count(*)::int FROM consensus_execution_validation_receipts r
             WHERE r.workspace_id=p.workspace_id AND r.execution_id=p.execution_id) receipt_count,
           (SELECT count(*)::int FROM provider_runtime_diagnostics d
             WHERE d.workspace_id=p.workspace_id AND d.execution_id=p.execution_id) diagnostic_count,
           (SELECT count(*)::int FROM artifacts a
             WHERE a.workspace_id=p.workspace_id AND a.execution_id=p.execution_id AND a.deleted_at IS NULL) artifact_count
         FROM pull_assignments p JOIN execution_projections e
           ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
         WHERE p.workspace_id=$1 AND p.assignment_id=$2`,
        [workspaceId, cancelled.assignment.assignment_id],
      )
    ).rows[0];
  const before = await readState();
  assert.deepEqual(before, {
    assignment_status: "completed",
    lease_receipt_id: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    execution_status: "cancelled",
    receipt_count: 0,
    diagnostic_count: 0,
    artifact_count: 0,
  });
  const cancelledResponse = await assignmentPullRoute(
    signedKnownAssignmentPullRequest(
      registrationFor(cancelled.assignment.agent_id),
      cancelled.assignment.assignment_id,
      "cancelled-known-assignment",
    ),
  );
  assert.equal(cancelledResponse.status, 400);
  const cancelledError = await cancelledResponse.json();
  assert.equal(cancelledError.error.code, "validation_failed");
  assert.equal(cancelledError.error.details.reason_code, "CANCELLED_ASSIGNMENT_CLAIM_REJECTED");
  assert.deepEqual(await readState(), before);
  const cancellationCommands = (
    await getDatabasePool().query(
      "SELECT status,result_event_ids FROM commands WHERE workspace_id=$1 AND command_id=ANY($2::uuid[]) ORDER BY created_at",
      [workspaceId, [cancellationCommandId, cancellationCompletionCommandId]],
    )
  ).rows;
  assert.equal(cancellationCommands.length, 2);
  assert.ok(cancellationCommands.every((command) => command.status === "completed"));
  assert.ok(cancellationCommands.flatMap((command) => command.result_event_ids).length >= 2);
});
