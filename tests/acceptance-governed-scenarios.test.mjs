import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import test from "node:test";

const artifactPath =
  "/tmp/mission-control-runtime-v6-local-validation/mission-agent-0.8.0-runtime-v6-local-validation.mjs";
const authorizationPath =
  "/tmp/mission-control-runtime-v6-local-validation/non-authenticated-candidate-validation.json";
const authorizationBytes = await readFile(authorizationPath);
const authorization = JSON.parse(authorizationBytes);
const authorizationSha256 = createHash("sha256").update(authorizationBytes).digest("hex");
Object.assign(process.env, {
  APP_ENV: "disposable_acceptance",
  CONSENSUS_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
  MISSION_AGENT_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
  MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION: authorizationPath,
  MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION_SHA256: authorizationSha256,
  MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION: authorizationPath,
  MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION_SHA256: authorizationSha256,
  MISSION_AGENT_MOCK_RUNTIME_PATH: new URL("../scripts/mock-provider-runtime.mjs", import.meta.url).pathname,
  CONSENSUS_ACCEPTANCE_ARTIFACT: artifactPath,
  DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS: "[]",
  DISPOSABLE_ACCEPTANCE_DATABASE_NAME: "mc_disposable_acceptance_governed_scenarios",
  DATABASE_URL: `postgresql://${process.env.USER}@127.0.0.1:5432/mc_disposable_acceptance_governed_scenarios`,
});

const { canonicalHash, canonicalJson } = await import("../lib/canonical-json.ts");
const { AcceptanceResourceInventory } = await import("../lib/acceptance-resource-inventory.ts");
const {
  executeGovernedScenario,
  governedScenarioDefinitions,
  governedScenarioRegistryIdentity,
  validateGovernedScenarioRegistry,
} = await import("../lib/acceptance-governed-scenarios.ts");
const { observeProductionResourceRejection } = await import("../application/resource-authority.ts");
const {
  executeCheckpointMisuseMatrix,
  executeSourceClosureMutationMatrix,
  observeConflictingReceiptRejection,
  observeDelayedOutputRejection,
  observeDisposableDatabaseIsolation,
  observeLeaseLossRejection,
  observeRepositoryDriftRejection,
  observeWrongCanonicalPlanHashRejection,
} = await import("../lib/acceptance-governed-scenario-drivers.ts");
const { durableProtocolReceipt } = await import("../domain/agent-protocol-receipt.ts");

const candidateBindings = Object.fromEntries(
  [
    "artifactSha256",
    "artifactMetadataSha256",
    "capabilityManifestSha256",
    "acceptanceSourceManifestSha256",
    "acceptanceContractSha256",
    "executableRegistrySha256",
    "disposableRegistrySha256",
    "providerRequirementsSha256",
    "providerProfilesSha256",
    "runtimeBindingsSha256",
    "modelAssignmentsSha256",
    "repositorySnapshotSha256",
    "validatorRegistrySha256",
    "reviewChecklistSha256",
    "finalizerChecklistSha256",
    "reviewerImplementationSha256",
    "resourceInventoryImplementationSha256",
    "cleanupFinalizerSha256",
    "realAcceptanceHarnessSha256",
  ].map((key, index) => [key, (index % 10).toString().repeat(64)]),
);

function fixture() {
  const acceptanceRunId = randomUUID();
  const binding = {
    acceptanceRunId,
    candidateIdentitySha256: authorization.artifact.sha256,
    requirementId: "REQ-7B0A244AB941902C",
    scenarioId: "production_resource_rejection",
    workspaceId: acceptanceRunId,
    repositoryId: randomUUID(),
    repositorySnapshotSha256: candidateBindings.repositorySnapshotSha256,
    repositoryAuthoritySha256: "a".repeat(64),
    agentId: null,
    assignmentId: null,
    attemptId: null,
    provider: null,
    model: null,
    role: null,
    runtimeProfile: null,
  };
  const inventoryBindings = { ...candidateBindings };
  delete inventoryBindings.repositorySnapshotSha256;
  const inventory = new AcceptanceResourceInventory(
    acceptanceRunId,
    inventoryBindings,
    candidateBindings.realAcceptanceHarnessSha256,
    new Date().toISOString(),
  );
  inventory.bindRepositorySnapshot(candidateBindings.repositorySnapshotSha256);
  return { binding, inventory };
}

function activeFixture(requirementId, scenarioId) {
  const base = fixture();
  return {
    ...base,
    binding: {
      ...base.binding,
      requirementId,
      scenarioId,
      agentId: randomUUID(),
      assignmentId: randomUUID(),
      attemptId: randomUUID(),
      provider: "codex",
      model: "gpt-5.6-luna",
      role: "executor",
      runtimeProfile: "codex-implementation-macos-v2",
    },
  };
}

async function executeFocusedScenario(base, driver, evidenceRoot) {
  return executeGovernedScenario({
    binding: base.binding,
    driver,
    evidenceRoot,
    inventory: base.inventory,
    persistInventory: () => {},
    retentionPolicyIdentity: "b".repeat(64),
    candidateBindings,
    secretScan: (bytes) => assert.doesNotMatch(bytes.toString("utf8"), /mc_lease_|bearer|password/i),
  });
}

const productionDriver = async (binding) => {
  const durableState = canonicalHash({ run: binding.acceptanceRunId, state: "before_authority_evaluation" });
  const counters = {
    dnsResolutionAttempts: 0,
    socketConnectionAttempts: 0,
    databaseConnectionAttempts: 0,
    providerInvocationCount: 0,
    remoteHttpAttempts: 0,
  };
  const substantive = observeProductionResourceRejection({
    request: {
      commandId: randomUUID(),
      acceptanceRunId: binding.acceptanceRunId,
      candidateIdentitySha256: binding.candidateIdentitySha256,
      workspaceId: binding.workspaceId,
      missionId: null,
      actorId: "governed-scenario-runner",
      resourceType: "database",
      resourceClassification: "production",
      operation: "connect",
      resourceIdentity: "synthetic-production-db-fixture",
      requestedAt: new Date().toISOString(),
    },
    counters: () => ({ ...counters }),
    durableStateIdentity: () => durableState,
  });
  return {
    ...binding,
    schemaVersion: "production-resource-rejection-observation/2",
    baselineStateSha256: durableState,
    terminalStateSha256: durableState,
    observedCommandIdentity: substantive.preflightOperationIdentity,
    observedResultIdentity: substantive.evaluationIdentity,
    observedAt: new Date().toISOString(),
    ...substantive,
  };
};

test("exact eleven-entry scenario registry remains bound to requirement producers and validators", () => {
  assert.equal(governedScenarioDefinitions.length, 11);
  assert.equal(validateGovernedScenarioRegistry(), governedScenarioRegistryIdentity);
});

test("production rejection executes, seals, inventories, and semantically validates substantive evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-scenario-"));
  await chmod(root, 0o700);
  const { binding, inventory } = fixture();
  const events = [];
  const result = await executeGovernedScenario({
    binding,
    driver: productionDriver,
    evidenceRoot: root,
    inventory,
    persistInventory: (event) => events.push(event),
    retentionPolicyIdentity: "b".repeat(64),
    candidateBindings,
    secretScan: (bytes) => assert.doesNotMatch(bytes.toString("utf8"), /credential|bearer|password/i),
  });
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
  assert.equal(events.at(-1), "governed_scenario_observation_sealed");
  const resource = inventory.resourceRecords().find((item) => item.resourceId === result.resourceId);
  assert.equal(resource.lifecycleState, "sealed");
  assert.equal(resource.identity.artifactSha256, result.observationSha256);
  const persisted = JSON.parse(await readFile(result.observationPath, "utf8"));
  assert.equal(persisted.actualTopLevelErrorCode, "validation_failed");
  assert.equal(persisted.actualRejectionCode, "PRODUCTION_RESOURCE_FORBIDDEN");
  assert.equal(persisted.dnsResolutionAttemptsBefore, persisted.dnsResolutionAttemptsAfter);
  assert.equal(persisted.socketConnectionAttemptsBefore, persisted.socketConnectionAttemptsAfter);
  assert.equal(persisted.databaseConnectionAttemptsBefore, persisted.databaseConnectionAttemptsAfter);
  assert.equal(persisted.providerInvocationCountBefore, persisted.providerInvocationCountAfter);
  assert.equal(persisted.remoteHttpAttemptsBefore, persisted.remoteHttpAttemptsAfter);
  t.diagnostic(`REQ-7B0A244AB941902C observation_sha256=${result.observationSha256}`);
});

test("provider restart uses same assignment authority and selects only replacement process output", async () => {
  const root = await mkdtemp(join(tmpdir(), "governed-provider-restart-"));
  const evidenceRoot = join(root, "evidence");
  const stateRoot = join(root, "state");
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  const base = fixture();
  const assignmentId = randomUUID();
  const executionId = randomUUID();
  const agentId = randomUUID();
  const binding = {
    ...base.binding,
    requirementId: "REQ-F726328FF0F3994B",
    scenarioId: "provider_restart",
    agentId,
    assignmentId,
    attemptId: "1",
    provider: "codex",
    model: "gpt-5.6-luna",
    role: "executor",
    runtimeProfile: "codex-implementation-macos-v2",
  };
  const leaseToken = `mc_lease_${createHash("sha256").update(randomUUID()).digest("base64url")}`;
  const leaseAcknowledgement = {
    protocolVersion: "1.0",
    messageId: randomUUID(),
    assignment: {
      assignmentId,
      executionId,
      leaseOwner: "governed-provider-restart",
      leaseToken,
      leaseIssuedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      fencingToken: 7,
    },
  };
  const leaseReceipt = durableProtocolReceipt(
    leaseAcknowledgement,
    {
      workspace_id: binding.workspaceId,
      agent_id: agentId,
      credential_id: randomUUID(),
    },
    "execution_assignment",
  ).authorization;
  const invocation = Buffer.from(
    JSON.stringify({
      schemaVersion: "mission-agent-mock-provider-invocation/1",
      evidenceSource: "mock_provider_runtime",
      authenticatedProviderInvoked: false,
      productionAuthority: false,
      mockProvider: "mock_codex",
      requestedProvider: "codex",
      requestedModel: binding.model,
      expectedModel: binding.model,
      role: binding.role,
      runtimeProfile: binding.runtimeProfile,
      missionId: randomUUID(),
      assignmentId,
      expectedAssignmentId: assignmentId,
      attemptId: 1,
      repositorySnapshot: binding.repositorySnapshotSha256,
      expectedRepositorySnapshot: binding.repositorySnapshotSha256,
      contextHash: "c".repeat(64),
      expectedContextHash: "c".repeat(64),
      fencingToken: 7,
      expectedFencingToken: 7,
    }),
  ).toString("base64url");
  const runtime = new URL("../scripts/mock-provider-runtime.mjs", import.meta.url).pathname;
  const schema = JSON.stringify({
    type: "object",
    properties: {
      schema_version: { type: "string", enum: ["canonical-plan-verdict/1"] },
      verdict: { type: "string", enum: ["approve"] },
      confidence: { type: "number", minimum: 0 },
    },
  });
  const runtimeEnv = {
    ...process.env,
    APP_ENV: "disposable_acceptance",
    MISSION_AGENT_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
    MISSION_AGENT_MOCK_INVOCATION: invocation,
    MISSION_AGENT_MOCK_SCENARIO: "provider_restart_once",
    MISSION_AGENT_MOCK_SCENARIO_STATE_ROOT: stateRoot,
  };
  const startedAt = new Date().toISOString();
  const original = spawn(process.execPath, [runtime, "--print", "--json-schema", schema], {
    cwd: root,
    env: runtimeEnv,
    detached: true,
  });
  let originalStdout = "";
  original.stdout.on("data", (chunk) => (originalStdout += String(chunk)));
  const [originalExitCode, originalSignal] = await once(original, "close");
  const replacement = spawn(process.execPath, [runtime, "--print", "--json-schema", schema], {
    cwd: root,
    env: runtimeEnv,
    detached: true,
  });
  let replacementStdout = "";
  replacement.stdout.on("data", (chunk) => (replacementStdout += String(chunk)));
  const [replacementExitCode] = await once(replacement, "close");
  assert.notEqual(original.pid, replacement.pid);
  assert.equal(originalSignal, "SIGKILL");
  assert.equal(replacementExitCode, 0);
  const originalResourceId = `provider-${assignmentId}-1-1`;
  const replacementResourceId = `provider-${assignmentId}-1-2`;
  for (const [resourceId, child, generation] of [
    [originalResourceId, original, "1-1"],
    [replacementResourceId, replacement, "1-2"],
  ])
    base.inventory.register({
      resourceId,
      type: "provider_subprocess",
      identity: {
        pid: child.pid,
        pgid: child.pid,
        processIdentitySha256: canonicalHash({ pid: child.pid, assignmentId, generation }),
        assignmentId,
        attemptId: generation,
      },
      creatingStep: "scenario.provider_restart",
      createdAt: startedAt,
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
    });
  const durableBefore = canonicalHash({ assignmentId, attempt: 1, resultArtifacts: 0 });
  const durableAfter = canonicalHash({ assignmentId, attempt: 1, resultArtifacts: 1 });
  const result = await executeGovernedScenario({
    binding,
    driver: async () => ({
      ...binding,
      schemaVersion: "provider-recovery-result/4",
      baselineStateSha256: durableBefore,
      terminalStateSha256: durableAfter,
      observedCommandIdentity: `provider-retry:${assignmentId}:1-2`,
      observedResultIdentity: canonicalHash(JSON.parse(replacementStdout)),
      observedAt: new Date().toISOString(),
      originalProcessResourceId: originalResourceId,
      replacementProcessResourceId: replacementResourceId,
      originalPid: original.pid,
      replacementPid: replacement.pid,
      originalPgid: original.pid,
      replacementPgid: replacement.pid,
      originalProcessIdentitySha256: canonicalHash({ pid: original.pid, assignmentId, generation: "1-1" }),
      replacementProcessIdentitySha256: canonicalHash({ pid: replacement.pid, assignmentId, generation: "1-2" }),
      terminationObserved: originalSignal === "SIGKILL",
      resumedOperationIdentity: `provider-retry:${assignmentId}:1-2`,
      resumedResultIdentity: canonicalHash(JSON.parse(replacementStdout)),
      staleOutputRejected: originalStdout.length === 0,
      originalProcessStopped: true,
      authoritativeStateCoherent: true,
      providerProcessReceivedLeaseCredential: false,
      providerProcessReceivedFencingBinding: true,
      originalExitCode: originalExitCode ?? 137,
      replacementExitCode,
      originalStdoutSha256: createHash("sha256").update(originalStdout).digest("hex"),
      replacementStdoutSha256: createHash("sha256").update(replacementStdout).digest("hex"),
      selectedProviderAttemptId: "1-2",
      resultArtifactProviderAttemptId: "1-2",
      originalResultArtifactCount: 0,
      replacementResultArtifactCount: 1,
      authoritativeResultCountBefore: 0,
      authoritativeResultCountAfter: 1,
      duplicateAuthoritativeResultCount: 0,
      cleanupResourceIds: [originalResourceId, replacementResourceId],
      assignmentAttemptBefore: 1,
      assignmentAttemptAfter: 1,
      firstProviderAttemptId: "1-1",
      restartedProviderAttemptId: "1-2",
      leaseIdBefore: leaseReceipt.leaseId,
      leaseIdAfter: leaseReceipt.leaseId,
      leaseFingerprintBefore: leaseReceipt.tokenFingerprint,
      leaseFingerprintAfter: leaseReceipt.tokenFingerprint,
      fencingTokenBefore: leaseReceipt.fencingToken,
      fencingTokenAfter: leaseReceipt.fencingToken,
      durableStateBeforeSha256: durableBefore,
      durableStateAfterSha256: durableAfter,
    }),
    evidenceRoot,
    inventory: base.inventory,
    persistInventory: () => {},
    retentionPolicyIdentity: "b".repeat(64),
    candidateBindings,
    secretScan: (bytes) => assert.doesNotMatch(bytes.toString("utf8"), /mc_lease_/),
  });
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
});

function mockInvocation(binding, assignmentId, attemptId) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: "mission-agent-mock-provider-invocation/1",
      evidenceSource: "mock_provider_runtime",
      authenticatedProviderInvoked: false,
      productionAuthority: false,
      mockProvider: "mock_codex",
      requestedProvider: binding.provider,
      requestedModel: binding.model,
      expectedModel: binding.model,
      role: binding.role,
      runtimeProfile: binding.runtimeProfile,
      missionId: randomUUID(),
      assignmentId,
      expectedAssignmentId: assignmentId,
      attemptId,
      repositorySnapshot: binding.repositorySnapshotSha256,
      expectedRepositorySnapshot: binding.repositorySnapshotSha256,
      contextHash: "c".repeat(64),
      expectedContextHash: "c".repeat(64),
      fencingToken: 11,
      expectedFencingToken: 11,
    }),
  ).toString("base64url");
}

test("lease loss executes active mock operation, reclaims authority, rejects stale result, and seals evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-lease-loss-"));
  const base = activeFixture("REQ-8F07660DBDB2F890", "lease_loss");
  const runtime = new URL("../scripts/mock-provider-runtime.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [runtime, "--print", "--json-schema", '{"type":"object"}'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      APP_ENV: "disposable_acceptance",
      MISSION_AGENT_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
      MISSION_AGENT_MOCK_INVOCATION: mockInvocation(base.binding, base.binding.assignmentId, 1),
      MISSION_AGENT_MOCK_SCENARIO: "timeout",
    },
  });
  const processIdentity = canonicalHash({
    pid: child.pid,
    assignmentId: base.binding.assignmentId,
    providerAttemptId: "provider-attempt-1",
  });
  base.inventory.register({
    resourceId: `lease-loss-provider-${child.pid}`,
    type: "provider_subprocess",
    identity: { pid: child.pid, pgid: child.pid, processIdentitySha256: processIdentity },
    creatingStep: "scenario.lease_loss.provider_start",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "stop",
    expectedTerminalState: "stopped",
  });
  const before = canonicalHash({ assignmentId: base.binding.assignmentId, artifacts: 0, events: 4, receipts: 0 });
  const originalToken = `mc_lease_${createHash("sha256").update(randomUUID()).digest("base64url")}`;
  const replacementToken = `mc_lease_${createHash("sha256").update(randomUUID()).digest("base64url")}`;
  const authority = observeLeaseLossRejection({
    leaseOwnerBefore: "mission-agent-active",
    leaseTokenBefore: originalToken,
    leaseOwnerAfter: "mission-agent-reclaimed",
    leaseTokenAfter: replacementToken,
    leaseExpiresAtAfter: new Date(Date.now() + 60_000),
    fencingTokenBefore: 11,
    fencingTokenAfter: 12,
  });
  process.kill(-child.pid, "SIGTERM");
  const [, signal] = await once(child, "close");
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "lease-loss-observation/2",
      baselineStateSha256: before,
      terminalStateSha256: before,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(authority),
      observedAt: new Date().toISOString(),
      providerAttemptId: "provider-attempt-1",
      providerProcessIdentitySha256: processIdentity,
      activeLeaseFingerprint: authority.activeLeaseFingerprint,
      activeFencingIdentity: authority.activeFencingIdentity,
      stateBeforeLeaseLoss: "running",
      leaseLossEventIdentity: randomUUID(),
      cancellationFencingActionIdentity: randomUUID(),
      processDisposition: signal === "SIGTERM" ? "terminated" : "unknown",
      postLossSubmissionIdentity: randomUUID(),
      actualTopLevelErrorCode: authority.actualTopLevelErrorCode,
      actualRejectionCode: authority.actualRejectionCode,
      artifactCountBefore: 0,
      artifactCountAfter: 0,
      eventCountBefore: 4,
      eventCountAfter: 4,
      receiptCountBefore: 0,
      receiptCountAfter: 0,
      cleanupEvidenceSha256: canonicalHash({ pid: child.pid, signal }),
      leaseSequence: 1,
      fencingToken: 11,
      outputReceiptSha256: canonicalHash({ assignmentId: binding.assignmentId, output: "late" }),
      rejectionCode: authority.actualRejectionCode,
      durableStateBeforeSha256: before,
      durableStateAfterSha256: before,
    }),
    root,
  );
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
  assert.equal(authority.actualRejectionCode, "ASSIGNMENT_LEASE_LOST");
  t.diagnostic(`REQ-8F07660DBDB2F890 observation_sha256=${result.observationSha256}`);
});

test("delayed provider output crosses the normal output authority boundary and remains non-authoritative", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-delayed-output-"));
  const base = activeFixture("REQ-BF2841A5FA3154F2", "delayed_output");
  const runtime = new URL("../scripts/mock-provider-runtime.mjs", import.meta.url).pathname;
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [runtime, "--print", "--json-schema", '{"type":"object"}'], {
    cwd: root,
    env: {
      ...process.env,
      APP_ENV: "disposable_acceptance",
      MISSION_AGENT_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
      MISSION_AGENT_MOCK_INVOCATION: mockInvocation(base.binding, base.binding.assignmentId, 1),
      MISSION_AGENT_MOCK_SCENARIO: "delayed_output",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0);
  assert.ok(output.length > 0);
  const transitionAt = new Date();
  const authority = observeDelayedOutputRejection({
    authorizedStatus: "running",
    terminalStatus: "succeeded",
    messageType: "ExecutionSucceeded",
    outputFencedAt: transitionAt,
    outputFenceReason: "execution_completed",
  });
  const state = canonicalHash({ assignmentId: base.binding.assignmentId, authoritativeReceiptCount: 1 });
  const completedAttemptId = randomUUID();
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "delayed-output-observation/2",
      baselineStateSha256: state,
      terminalStateSha256: state,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(authority),
      observedAt: new Date().toISOString(),
      providerAttemptId: "provider-attempt-1",
      authorizedLifecycleState: "running",
      staleTransitionIdentity: randomUUID(),
      staleTransitionEventIdentity: randomUUID(),
      delayedSubmissionIdentity: randomUUID(),
      delayedSubmissionAt: new Date().toISOString(),
      providerOutputObservedAt: new Date().toISOString(),
      providerOperationStartedAt: startedAt,
      leaseFingerprintAtSubmission: "5".repeat(64),
      fencingIdentityAtSubmission: "6".repeat(64),
      actualTopLevelErrorCode: authority.actualTopLevelErrorCode,
      actualRejectionCode: authority.actualRejectionCode,
      artifactCountBefore: 1,
      artifactCountAfter: 1,
      eventCountBefore: 2,
      eventCountAfter: 2,
      receiptCountBefore: 1,
      receiptCountAfter: 1,
      staleContentAuthoritative: false,
      completedAttemptId,
      outputReceiptSha256: createHash("sha256").update(output).digest("hex"),
      rejectionCode: authority.actualRejectionCode,
      durableStateBeforeSha256: state,
      durableStateAfterSha256: state,
    }),
    root,
  );
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
  assert.equal(authority.actualRejectionCode, "DELAYED_PROVIDER_OUTPUT_REJECTED");
  t.diagnostic(`REQ-BF2841A5FA3154F2 observation_sha256=${result.observationSha256}`);
});

test("conflicting immutable receipt is rejected by the production receipt authority and original remains authoritative", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-conflicting-receipt-"));
  const base = activeFixture("REQ-3F10A64C778C6510", "conflicting_receipt");
  const originalReceiptId = randomUUID();
  const conflictingReceiptId = randomUUID();
  const immutableBindings = {
    assignmentId: base.binding.assignmentId,
    attemptId: base.binding.attemptId,
    operationId: randomUUID(),
    resultCommit: "a".repeat(40),
  };
  const originalReceiptSha256 = canonicalHash({ originalReceiptId, ...immutableBindings });
  const conflictingReceiptSha256 = canonicalHash({
    conflictingReceiptId,
    ...immutableBindings,
    resultCommit: "b".repeat(40),
  });
  const receiptStore = new Map([[`${base.binding.assignmentId}:${base.binding.attemptId}`, originalReceiptSha256]]);
  const storeState = canonicalHash([...receiptStore]);
  const authority = observeConflictingReceiptRejection({
    persistedReceiptSha256: receiptStore.get(`${base.binding.assignmentId}:${base.binding.attemptId}`),
    submittedReceiptSha256: conflictingReceiptSha256,
  });
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "conflicting-receipt-observation/2",
      baselineStateSha256: storeState,
      terminalStateSha256: storeState,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(authority),
      observedAt: new Date().toISOString(),
      providerAttemptId: "provider-attempt-1",
      originalReceiptId,
      conflictingReceiptId,
      originalReceiptSha256,
      conflictingReceiptSha256,
      immutableBindings,
      conflictingFields: ["resultCommit"],
      submissionResult: "rejected",
      actualTopLevelErrorCode: authority.actualTopLevelErrorCode,
      actualRejectionCode: authority.actualRejectionCode,
      receiptStoreIdentityBefore: storeState,
      receiptStoreIdentityAfter: canonicalHash([...receiptStore]),
      eventStateIdentityBefore: "8".repeat(64),
      eventStateIdentityAfter: "8".repeat(64),
      projectionStateIdentityBefore: "9".repeat(64),
      projectionStateIdentityAfter: "9".repeat(64),
      authoritativeReceiptSha256After: receiptStore.get(`${binding.assignmentId}:${binding.attemptId}`),
      acceptedReceiptSha256: originalReceiptSha256,
      rejectionCode: authority.actualRejectionCode,
      durableStateBeforeSha256: storeState,
      durableStateAfterSha256: storeState,
    }),
    root,
  );
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
  assert.equal(authority.actualRejectionCode, "CONFLICTING_RECEIPT_REJECTED");
  t.diagnostic(`REQ-3F10A64C778C6510 observation_sha256=${result.observationSha256}`);
});

test("Mission Control process and listener restart through the launcher coordinator and resume durable state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-mission-control-restart-"));
  await mkdir(join(root, ".next", "standalone"), { recursive: true });
  const probe = createNetServer();
  await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  const serverPath = join(root, ".next", "standalone", "server.js");
  await writeFile(
    serverPath,
    `const http=require("node:http");const server=http.createServer((req,res)=>{res.statusCode=200;res.end("ok")});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));\n`,
  );
  const original = spawn(process.execPath, [serverPath], { cwd: root, detached: true, stdio: "ignore" });
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await fetch(healthUrl)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const processIdentity = (pid) =>
    createHash("sha256")
      .update(
        execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
          encoding: "utf8",
        }).trim(),
      )
      .digest("hex");
  const base = fixture();
  base.binding = {
    ...base.binding,
    requirementId: "REQ-400B51CA2DEA7743",
    scenarioId: "mission_control_restart",
  };
  for (const record of [
    {
      resourceId: "disposable-database",
      type: "disposable_database",
      identity: { databaseName: "focused-restart" },
      creatingStep: "restart.fixture",
      cleanupPolicy: "delete",
      expectedTerminalState: "deleted",
    },
    {
      resourceId: "disposable-registry-copy",
      type: "registry_copy",
      identity: { path: join(root, "registry.json") },
      creatingStep: "restart.fixture",
      cleanupPolicy: "delete",
      expectedTerminalState: "deleted",
    },
    {
      resourceId: "mission-control-server",
      type: "mission_control_server",
      identity: { pid: original.pid, processIdentitySha256: processIdentity(original.pid), generation: "1" },
      creatingStep: "restart.fixture",
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
      dependsOn: ["disposable-database", "disposable-registry-copy"],
    },
    {
      resourceId: "mission-control-listener",
      type: "listener",
      identity: { host: "127.0.0.1", port, generation: "1" },
      creatingStep: "restart.fixture",
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
      dependsOn: ["mission-control-server"],
    },
  ])
    base.inventory.register({ ...record, createdAt: new Date().toISOString() });
  const inventoryPath = join(root, "inventory.json");
  await writeFile(inventoryPath, `${canonicalJson(base.inventory.journalSnapshot())}\n`);
  const identityChecks = [];
  for (const kind of ["candidate", "source", "contract", "registry"]) {
    const path = join(root, `${kind}.identity`);
    await writeFile(path, `${kind}-identity\n`);
    identityChecks.push({
      kind,
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
  }
  const durableState = {
    missions: [randomUUID()],
    assignments: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    artifacts: Array.from({ length: 10 }, () => randomUUID()),
    workflowState: "awaiting_human_approval",
  };
  const durableHash = canonicalHash(durableState);
  const eventHash = canonicalHash([{ position: 1, type: "approval.requested" }]);
  const requestPath = join(root, "restart-request.json");
  const responsePath = join(root, "restart-response.json");
  await writeFile(
    requestPath,
    `${canonicalJson({
      schemaVersion: "mission-control-restart-request/1",
      acceptanceRunId: base.binding.acceptanceRunId,
      candidateIdentitySha256: base.binding.candidateIdentitySha256,
      inventoryPath,
      inventorySha256: base.inventory.journalSnapshot().sha256,
      originalPid: original.pid,
      host: "127.0.0.1",
      port,
      healthUrl,
      executableIdentitySha256: createHash("sha256")
        .update(await readFile(serverPath))
        .digest("hex"),
      identityChecks,
      preRestartDurableStateSha256: durableHash,
      preRestartEventRangeSha256: eventHash,
      requestedAt: new Date().toISOString(),
    })}\n`,
  );
  const coordinator = spawn(
    process.execPath,
    [
      "--import",
      new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname,
      new URL("../scripts/restart-consensus-acceptance-server.ts", import.meta.url).pathname,
      requestPath,
      responsePath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        APP_ENV: "disposable_acceptance",
        CONSENSUS_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
      },
      stdio: "ignore",
    },
  );
  const [coordinatorExit] = await once(coordinator, "close");
  assert.equal(coordinatorExit, 0);
  const restart = JSON.parse(await readFile(responsePath, "utf8"));
  base.inventory = AcceptanceResourceInventory.fromJournalSnapshot(JSON.parse(await readFile(inventoryPath, "utf8")));
  let protectedOperationCount = 0;
  const nextOperationResult = (() => {
    protectedOperationCount += 1;
    return { applied: true, commandId: randomUUID() };
  })();
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      ...restart,
      schemaVersion: "mission-control-restart-observation/3",
      baselineStateSha256: durableHash,
      terminalStateSha256: durableHash,
      observedCommandIdentity: restart.shutdownRequestIdentity,
      observedResultIdentity: restart.shutdownEvidenceIdentity,
      observedAt: new Date().toISOString(),
      missionId: durableState.missions[0],
      nextOperationIdentity: nextOperationResult.commandId,
      nextOperationResult,
      eventContinuity: true,
      cleanupResourceIds: [
        restart.serverResourceId,
        restart.restartedServerResourceId,
        restart.listenerResourceId,
        restart.restartedListenerResourceId,
      ],
      acceptanceRunIdBefore: binding.acceptanceRunId,
      acceptanceRunIdAfter: binding.acceptanceRunId,
      canonicalEventSetSha256Before: eventHash,
      canonicalEventSetSha256After: eventHash,
      projectionSha256Before: durableHash,
      projectionSha256After: durableHash,
      missionCountBefore: durableState.missions.length,
      missionCountAfter: durableState.missions.length,
      artifactCountBefore: durableState.artifacts.length,
      artifactCountAfter: durableState.artifacts.length,
      assignmentCountBefore: durableState.assignments.length,
      assignmentCountAfter: durableState.assignments.length,
    }),
    root,
  );
  assert.equal(protectedOperationCount, 1);
  process.kill(-restart.restartedPid, "SIGTERM");
  t.diagnostic(`REQ-400B51CA2DEA7743 observation_sha256=${result.observationSha256}`);
});

test("wrong canonical-plan hash crosses the governed verdict authority and seals unchanged state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-wrong-plan-hash-"));
  const base = fixture();
  base.binding = {
    ...base.binding,
    requirementId: "REQ-6BD097D5CF920BF4",
    scenarioId: "wrong_canonical_plan_hash",
  };
  const approvedValueSha256 = canonicalHash({ plan: "authoritative" });
  const attemptedValueSha256 = canonicalHash({ plan: "changed" });
  const authority = observeWrongCanonicalPlanHashRejection({
    reviewedArtifactId: randomUUID(),
    approvedCanonicalPlanSha256: approvedValueSha256,
    attemptedCanonicalPlanSha256: attemptedValueSha256,
  });
  const durable = canonicalHash({ verdicts: 2, approvals: 0, children: 0 });
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "wrong-canonical-plan-hash-observation/2",
      baselineStateSha256: durable,
      terminalStateSha256: durable,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(authority),
      observedAt: new Date().toISOString(),
      mutationKind: "canonical_plan_hash",
      protectedOperation: "record_canonical_plan_verdict",
      commandIdentity: randomUUID(),
      approvedValueSha256,
      attemptedValueSha256,
      actualTopLevelErrorCode: authority.actualTopLevelErrorCode,
      actualRejectionCode: authority.actualRejectionCode,
      providerInvocationCountBefore: 1,
      providerInvocationCountAfter: 1,
      verdictCountBefore: 2,
      verdictCountAfter: 2,
      approvalCountBefore: 0,
      approvalCountAfter: 0,
      childMissionCountBefore: 0,
      childMissionCountAfter: 0,
      durableStateBeforeSha256: durable,
      durableStateAfterSha256: durable,
    }),
    root,
  );
  assert.equal(authority.actualRejectionCode, "CANONICAL_PLAN_HASH_MISMATCH");
  t.diagnostic(`REQ-6BD097D5CF920BF4 observation_sha256=${result.observationSha256}`);
});

test("real disposable repository drift crosses snapshot authority and never starts protected execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-repository-drift-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Mission Control Acceptance"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "acceptance@localhost"], { cwd: repository });
  await writeFile(join(repository, "governed.txt"), "approved\n");
  execFileSync("git", ["add", "governed.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const repositoryState = () =>
    canonicalHash({
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
      status: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: repository,
        encoding: "utf8",
      }),
      content: execFileSync("git", ["hash-object", "governed.txt"], { cwd: repository, encoding: "utf8" }).trim(),
    });
  const approvedValueSha256 = repositoryState();
  await writeFile(join(repository, "governed.txt"), "drifted\n");
  const attemptedValueSha256 = repositoryState();
  const authority = observeRepositoryDriftRejection({
    approvedRepositorySnapshotSha256: approvedValueSha256,
    observedRepositorySnapshotSha256: attemptedValueSha256,
  });
  const base = fixture();
  base.binding = { ...base.binding, requirementId: "REQ-014AA0AC8BAE841A", scenarioId: "repository_drift" };
  const durable = canonicalHash({ executions: 0, children: 0, artifacts: 0 });
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "repository-drift-observation/2",
      baselineStateSha256: durable,
      terminalStateSha256: durable,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(authority),
      observedAt: new Date().toISOString(),
      mutationKind: "repository_drift",
      repositoryId: binding.repositoryId,
      mutationPath: join(repository, "governed.txt"),
      protectedOperation: "authorize_executor_claim",
      approvedValueSha256,
      attemptedValueSha256,
      actualTopLevelErrorCode: authority.actualTopLevelErrorCode,
      actualRejectionCode: authority.actualRejectionCode,
      executionCountBefore: 0,
      executionCountAfter: 0,
      childMissionCountBefore: 0,
      childMissionCountAfter: 0,
      artifactCountBefore: 0,
      artifactCountAfter: 0,
      durableStateBeforeSha256: durable,
      durableStateAfterSha256: durable,
    }),
    root,
  );
  assert.equal(authority.actualRejectionCode, "REPOSITORY_DRIFT_REJECTED");
  t.diagnostic(`REQ-014AA0AC8BAE841A observation_sha256=${result.observationSha256}`);
});

test("five real source-closure mutations refuse the protected action and seal exact mismatch evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-source-matrix-evidence-"));
  const base = fixture();
  base.binding = {
    ...base.binding,
    requirementId: "REQ-D8750DD32D61F788",
    scenarioId: "source_closure_mutation_matrix",
  };
  const substantive = await executeSourceClosureMutationMatrix();
  const before = canonicalHash({ sourceManifestSha256: substantive.sourceManifestSha256, protectedActions: 0 });
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "source-closure-mutation-observation/2",
      baselineStateSha256: before,
      terminalStateSha256: before,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(substantive),
      observedAt: new Date().toISOString(),
      sourceManifestSha256: substantive.sourceManifestSha256,
      cases: substantive.cases,
    }),
    root,
  );
  assert.equal(substantive.cases.length, 5);
  assert.ok(substantive.cases.every((item) => item.protectedActionInvocations === 0));
  t.diagnostic(`REQ-D8750DD32D61F788 observation_sha256=${result.observationSha256}`);
});

test("six genuine checkpoint misuse cases cross the controller consume boundary and seal evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-checkpoint-misuse-evidence-"));
  const base = fixture();
  base.binding = {
    ...base.binding,
    requirementId: "REQ-57F6345836E7244C",
    scenarioId: "checkpoint_identity_and_reuse",
  };
  const substantive = await executeCheckpointMisuseMatrix();
  const state = canonicalHash({ sourceManifestSha256: substantive.sourceManifestSha256, protectedActions: 0 });
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "checkpoint-misuse-observation/2",
      baselineStateSha256: state,
      terminalStateSha256: state,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(substantive),
      observedAt: new Date().toISOString(),
      sourceManifestSha256: substantive.sourceManifestSha256,
      cases: substantive.cases,
    }),
    root,
  );
  assert.equal(substantive.cases.length, 6);
  assert.ok(substantive.cases.every((item) => item.protectedActionInvocations === 0));
  t.diagnostic(`REQ-57F6345836E7244C observation_sha256=${result.observationSha256}`);
});

test("disposable database target connects locally while production-classified configuration is rejected pre-connect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governed-database-isolation-evidence-"));
  const databaseName = process.env.DISPOSABLE_ACCEPTANCE_DATABASE_NAME;
  execFileSync("dropdb", ["-h", "127.0.0.1", "--if-exists", databaseName]);
  execFileSync("createdb", ["-h", "127.0.0.1", databaseName]);
  t.after(() => execFileSync("dropdb", ["-h", "127.0.0.1", "--if-exists", databaseName]));
  const { Client } = await import("pg");
  let attempts = 0;
  const base = fixture();
  base.binding = {
    ...base.binding,
    requirementId: "REQ-A42EC85F62AEFC15",
    scenarioId: "disposable_database_isolation",
  };
  base.inventory.register({
    resourceId: "disposable-database-focused",
    type: "disposable_database",
    identity: { databaseName, host: "127.0.0.1" },
    creatingStep: "scenario.disposable_database_isolation",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "delete",
    expectedTerminalState: "deleted",
  });
  const substantive = await observeDisposableDatabaseIsolation({
    acceptanceRunId: base.binding.acceptanceRunId,
    candidateIdentitySha256: base.binding.candidateIdentitySha256,
    databaseResourceInventoryId: "disposable-database-focused",
    connectionConfiguration: { host: "127.0.0.1", databaseName, ssl: false },
    connectDisposable: async () => {
      attempts += 1;
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        assert.equal((await client.query("SELECT current_database() database")).rows[0].database, databaseName);
      } finally {
        await client.end();
      }
    },
    connectionAttempts: () => attempts,
  });
  const state = canonicalHash({ databaseName, attempts });
  const result = await executeFocusedScenario(
    base,
    async (binding) => ({
      ...binding,
      schemaVersion: "disposable-database-isolation-observation/2",
      baselineStateSha256: state,
      terminalStateSha256: state,
      observedCommandIdentity: randomUUID(),
      observedResultIdentity: canonicalHash(substantive),
      observedAt: new Date().toISOString(),
      ...substantive,
    }),
    root,
  );
  assert.equal(substantive.connectionAttemptsBeforeForbidden, substantive.connectionAttemptsAfterForbidden);
  assert.equal(substantive.actualRejectionCode, "PRODUCTION_RESOURCE_FORBIDDEN");
  t.diagnostic(`REQ-A42EC85F62AEFC15 observation_sha256=${result.observationSha256}`);
});

test("active scenario observations reject wrong assignment, attempt, provider, model, role, and profile bindings", async () => {
  for (const [field, changed] of [
    ["assignmentId", randomUUID()],
    ["attemptId", randomUUID()],
    ["provider", "claude_code"],
    ["model", "wrong-model"],
    ["role", "planner_a"],
    ["runtimeProfile", "wrong-profile"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `governed-binding-${field}-`));
    const base = activeFixture("REQ-8F07660DBDB2F890", "lease_loss");
    await assert.rejects(
      executeFocusedScenario(
        base,
        async (binding) => ({
          ...binding,
          [field]: changed,
          schemaVersion: "lease-loss-observation/2",
          baselineStateSha256: "a".repeat(64),
          terminalStateSha256: "a".repeat(64),
          observedCommandIdentity: randomUUID(),
          observedResultIdentity: randomUUID(),
          observedAt: new Date().toISOString(),
        }),
        root,
      ),
      /active-provider binding is incomplete or changed/,
    );
  }
});

test("wrong requirement, undefined observation, secret scan, and persistence failures fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "governed-scenario-negative-"));
  const wrong = fixture();
  await assert.rejects(
    executeGovernedScenario({
      binding: { ...wrong.binding, requirementId: "REQ-F726328FF0F3994B" },
      driver: productionDriver,
      evidenceRoot: root,
      inventory: wrong.inventory,
      persistInventory: () => {},
      retentionPolicyIdentity: "b".repeat(64),
      candidateBindings,
      secretScan: () => {},
    }),
    /requirement\/implementation binding/,
  );
  const undefinedFixture = fixture();
  await assert.rejects(
    executeGovernedScenario({
      binding: undefinedFixture.binding,
      driver: async (binding) => ({ ...(await productionDriver(binding)), forbiddenUndefined: undefined }),
      evidenceRoot: root,
      inventory: undefinedFixture.inventory,
      persistInventory: () => {},
      retentionPolicyIdentity: "b".repeat(64),
      candidateBindings,
      secretScan: () => {},
    }),
    /contains undefined/,
  );
  const secretFixture = fixture();
  await assert.rejects(
    executeGovernedScenario({
      binding: secretFixture.binding,
      driver: productionDriver,
      evidenceRoot: root,
      inventory: secretFixture.inventory,
      persistInventory: () => {},
      retentionPolicyIdentity: "b".repeat(64),
      candidateBindings,
      secretScan: () => {
        throw new Error("secret scan rejected observation");
      },
    }),
    /secret scan rejected/,
  );
  const missingRootFixture = fixture();
  await assert.rejects(
    executeGovernedScenario({
      binding: missingRootFixture.binding,
      driver: productionDriver,
      evidenceRoot: join(root, "missing", "root"),
      inventory: missingRootFixture.inventory,
      persistInventory: () => {},
      retentionPolicyIdentity: "b".repeat(64),
      candidateBindings,
      secretScan: () => {},
    }),
    /ENOENT/,
  );
});
