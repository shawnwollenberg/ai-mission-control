import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConsensusArtifactSecretSafe,
  assertConsensusTransition,
  assertProjectBrainContextPack,
  canonicalConsensusObjectionId,
  consensusReached,
  parseConsensusArtifact,
} from "../domain/consensus-plan.ts";
import { parseAgentProviderProfile, supportsAgentOperation } from "../domain/agent-provider.ts";
import {
  parseProviderRuntimeStatus,
  providerRuntimeBindingFor,
  providerRuntimeRequirements,
  providerRuntimeStatusSatisfies,
} from "../domain/provider-runtime-requirements.ts";
import {
  expectedProviderRuntimeProfileBindings,
  proposedProviderRuntimeProfiles,
  providerRuntimeProfileFor,
} from "../domain/provider-runtime-profiles.ts";
import { canonicalHash } from "../lib/canonical-json.ts";
import {
  parseProviderRuntimeDiagnostic,
  serverSanitizeProviderRuntimeDiagnostic,
} from "../domain/provider-runtime-diagnostic.ts";
import {
  assertDurableProtocolReceipt,
  durableProtocolReceipt,
  processingProtocolReceipt,
} from "../domain/agent-protocol-receipt.ts";

const missionId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const snapshot = "a".repeat(64);
const contextHash = "b".repeat(64);

test("canonical objection identity is stable and collision-resistant across every authority dimension", () => {
  const base = {
    missionId,
    consensusAttempt: 1,
    sourceArtifactId: artifactId,
    participantAssignmentId: assignmentId,
    round: 1,
    rawProviderObjectionId: "B1",
  };
  const canonical = canonicalConsensusObjectionId(base);
  assert.equal(canonicalConsensusObjectionId(base), canonical);
  for (const changed of [
    { missionId: "44444444-4444-4444-8444-444444444444" },
    { consensusAttempt: 2 },
    { sourceArtifactId: "55555555-5555-4555-8555-555555555555" },
    { participantAssignmentId: "66666666-6666-4666-8666-666666666666" },
    { round: 2 },
    { rawProviderObjectionId: "B2" },
  ])
    assert.notEqual(canonicalConsensusObjectionId({ ...base, ...changed }), canonical);
});

test("durable protocol receipts retain lease correlation without retaining bearer authority", () => {
  const rawLeaseToken = `mc_lease_${"sensitive".repeat(5)}`;
  const receipt = durableProtocolReceipt(
    {
      protocolVersion: "1.0",
      messageId: missionId,
      assignment: {
        assignmentId,
        executionId: artifactId,
        leaseOwner: "worker-1",
        leaseToken: rawLeaseToken,
        leaseIssuedAt: "2026-08-04T12:00:00.000Z",
        leaseExpiresAt: "2026-08-04T12:01:00.000Z",
        fencingToken: 7,
      },
    },
    { workspace_id: missionId, agent_id: assignmentId, credential_id: artifactId },
    "execution_assignment",
  );
  assertDurableProtocolReceipt(receipt);
  const text = JSON.stringify(receipt);
  assert.equal(text.includes(rawLeaseToken), false);
  assert.equal(/mc_(?:pb_)?lease_/i.test(text), false);
  assert.match(receipt.authorization.tokenFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(receipt.authorization.fencingToken, 7);
  assert.deepEqual(processingProtocolReceipt(missionId), {
    schemaVersion: "agent-protocol-receipt/2",
    status: "processing",
    protocolVersion: "1.0",
    messageId: missionId,
  });
});

test("Project Brain lease receipts preserve their operation authority even when an execution is linked", () => {
  const operationId = "44444444-4444-4444-8444-444444444444";
  const receipt = durableProtocolReceipt(
    {
      protocolVersion: "1.0",
      messageId: missionId,
      assignment: {
        assignmentId,
        executionId: artifactId,
        operationId,
        leaseOwner: "project-brain-worker",
        leaseToken: `mc_pb_lease_${"sensitive".repeat(5)}`,
        leaseIssuedAt: "2026-08-04T12:00:00.000Z",
        leaseExpiresAt: "2026-08-04T12:01:00.000Z",
      },
    },
    { workspace_id: missionId, agent_id: assignmentId, credential_id: artifactId },
    "project_brain_assignment",
  );
  assert.equal(receipt.authorization.kind, "project_brain_assignment");
  assert.equal(receipt.authorization.binding.operationId, operationId);
  assert.equal(receipt.authorization.fencingToken, null);
  assertDurableProtocolReceipt(receipt);
});

test("durable receipt schemas reject unknown and secret-like fields at every depth and casing", () => {
  const base = processingProtocolReceipt(missionId);
  assert.throws(() => assertDurableProtocolReceipt({ ...base, LeaseToken: "x".repeat(40) }), /forbidden/);
  const completed = {
    schemaVersion: "agent-protocol-receipt/2",
    status: "completed",
    protocolVersion: "1.0",
    messageId: missionId,
    responseChecksum: "a".repeat(64),
  };
  assert.throws(
    () => assertDurableProtocolReceipt({ ...completed, authorization: { nested: { aUtH_tOkEn: "x" } } }),
    /forbidden/,
  );
  assert.throws(() => assertDurableProtocolReceipt({ ...completed, unexpected: true }), /unknown/);
});

function providerDiagnostic(overrides = {}) {
  return {
    schemaVersion: "provider-runtime-diagnostic/1",
    provider: "codex",
    requestedModel: "gpt-5.6-sol",
    cliVersion: "codex-cli 0.146.0",
    runtimeProfileId: "codex-planning-macos-v2",
    runtimeProfileHash: "c".repeat(64),
    sandboxProfileHash: "d".repeat(64),
    providerAttemptId: "1-1",
    processStartedAt: "2026-08-04T12:00:00.000Z",
    processTerminatedAt: "2026-08-04T12:00:01.000Z",
    exitCode: 1,
    terminationSignal: null,
    timedOut: false,
    cancellationRequested: false,
    stdoutHash: "d".repeat(64),
    stderrHash: "e".repeat(64),
    stdoutExcerpt: "safe stdout",
    stderrExcerpt: "operation not permitted",
    textAvailable: true,
    failedInitializationPhase: "app_server_initialization",
    childProcess: {
      pid: 54321,
      processGroupId: 54321,
      detachedProcessGroup: true,
      processTreeTerminationAttempted: false,
      processTreeTerminationVerified: false,
    },
    sandboxDenial: { detected: true, excerpt: "operation not permitted" },
    temporaryDirectoryIdentity: "f".repeat(64),
    workingDirectoryIdentity: "0".repeat(64),
    environmentVariableNames: ["PATH", "HOME", "PATH"],
    localSecretScan: "passed_exact_and_pattern",
    ...overrides,
  };
}

test("provider runtime diagnostics are strict, canonical, and contain environment names only", () => {
  const parsed = parseProviderRuntimeDiagnostic(providerDiagnostic());
  assert.deepEqual(parsed.environmentVariableNames, ["HOME", "PATH"]);
  assert.throws(
    () => parseProviderRuntimeDiagnostic(providerDiagnostic({ environmentVariableNames: ["TOKEN=value"] })),
    /environment names/,
  );
  assert.throws(
    () => parseProviderRuntimeDiagnostic({ ...providerDiagnostic(), rawEnvironment: { TOKEN: "secret" } }),
    /unsupported fields/,
  );
});

test("server sanitization removes every excerpt when any diagnostic text contains a secret", () => {
  const result = serverSanitizeProviderRuntimeDiagnostic(
    providerDiagnostic({ stderrExcerpt: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" }),
  );
  assert.equal(result.serverSecretScan, "text_removed");
  assert.equal(result.diagnostic.stdoutExcerpt, null);
  assert.equal(result.diagnostic.stderrExcerpt, null);
  assert.equal(result.diagnostic.sandboxDenial.excerpt, null);
  assert.equal(result.diagnostic.textAvailable, false);
  assert.match(result.diagnosticHash, /^[a-f0-9]{64}$/);
});

function proposal(overrides = {}) {
  return {
    schema_version: "consensus-plan-proposal/1",
    mission_id: missionId,
    assignment_id: assignmentId,
    repository_snapshot: snapshot,
    context_pack_hash: contextHash,
    problem_definition: "Bounded problem",
    assumptions: [],
    proposed_approach: "Bounded approach",
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
    confidence: 0.8,
    ...overrides,
  };
}

test("Claude provider capabilities are parsed independently of model marketing names", () => {
  const profile = parseAgentProviderProfile({
    provider: "claude_code",
    agent_version: "0.7.0",
    supported_mission_roles: ["planner", "reviewer", "executor"],
    supported_operations: ["generate_structured_plan", "implement_change"],
    supported_models: ["provider-model-a", "provider-model-b"],
    model_capabilities: ["provider-model-a", "provider-model-b"].map((model_id) => ({
      model_id,
      display_name: model_id,
      provider: "claude_code",
      supported_roles: ["planner", "executor"],
      supported_operations: ["generate_structured_plan", "implement_change"],
      structured_output: true,
      repository_read: true,
      repository_mutation: true,
      plan_mode: true,
      runtime_model_identity: "reported",
    })),
    capability_attestation_version: 1,
    capability_source: "operator_allowlist",
    structured_output: true,
    project_brain_context: true,
    repository_mutation: true,
  });
  assert.equal(profile.provider, "claude_code");
  assert.equal(supportsAgentOperation(profile, "planner", "generate_structured_plan", "provider-model-b"), true);
  assert.equal(supportsAgentOperation(profile, "planner", "generate_structured_plan", "not-advertised"), false);
  assert.throws(() => parseAgentProviderProfile({ ...profile, provider: "claude" }), /Unsupported agent provider/);
});

test("every provider has one immutable, explicit runtime requirement contract", () => {
  assert.deepEqual(Object.keys(providerRuntimeRequirements.providers).sort(), [
    "claude_code",
    "codex",
    "generic",
    "hermes",
    "mock",
  ]);
  const bindings = Object.keys(providerRuntimeRequirements.providers).map((provider) =>
    providerRuntimeBindingFor(provider),
  );
  assert.equal(new Set(bindings.map((binding) => binding.requirementsId)).size, bindings.length);
  assert.ok(bindings.every((binding) => /^[0-9a-f]{64}$/.test(binding.requirementsHash)));
  for (const provider of Object.keys(providerRuntimeRequirements.providers))
    assert.equal(
      providerRuntimeBindingFor(provider).requirementsHash,
      canonicalHash({
        contractVersion: providerRuntimeRequirements.contractVersion,
        contractScope: providerRuntimeRequirements.contractScope,
        provider,
        requirement: providerRuntimeRequirements.providers[provider],
      }),
    );
  for (const provider of ["codex", "claude_code"]) {
    const requirement = providerRuntimeRequirements.providers[provider];
    assert.equal(requirement.executionMode, "local_cli");
    assert.equal(requirement.supportedCliVersions.length, 1);
    assert.equal(requirement.modelSelection.argument, "--model");
    assert.equal(requirement.modelSelection.fallback, "disabled");
    assert.equal(requirement.modelSelection.runtimeIdentity, "unverifiable");
    assert.equal(requirement.isolation.planningRepositoryAccess, "none");
    assert.equal(requirement.isolation.implementationRepositoryAccess, "isolated_worktree");
    assert.equal(requirement.requiresCleanPlanningWorktree, true);
  }
  assert.deepEqual(providerRuntimeRequirements.providers.codex.isolation.credentialReadScopes, ["codex_home"]);
  assert.deepEqual(providerRuntimeRequirements.providers.claude_code.isolation.credentialReadScopes, [
    "claude_home",
    "macos_keychain_service",
  ]);
  assert.equal(providerRuntimeRequirements.providers.hermes.consensusEligible, false);
  assert.equal(providerRuntimeRequirements.providers.generic.consensusEligible, false);
  assert.equal(providerRuntimeRequirements.providers.mock.consensusEligible, false);
});

test("runtime readiness binds the exact provider contract and fails closed", () => {
  const binding = providerRuntimeBindingFor("codex");
  const ready = parseProviderRuntimeStatus(
    {
      ...binding,
      platform: "darwin",
      executableAvailable: true,
      providerVersion: "codex-cli 0.146.0",
      authenticationAvailable: true,
      isolationMechanism: "sandbox-exec",
      isolationAvailable: true,
      modelSelectionMechanism: "argv",
      runtimeModelIdentity: "unverifiable",
      runtimeProfiles: expectedProviderRuntimeProfileBindings("codex"),
    },
    "codex",
  );
  assert.equal(providerRuntimeStatusSatisfies("codex", ready), true);
  assert.equal(providerRuntimeStatusSatisfies("codex", { ...ready, providerVersion: "codex-cli 0.145.0" }), false);
  assert.equal(providerRuntimeStatusSatisfies("codex", { ...ready, authenticationAvailable: false }), false);
  assert.equal(providerRuntimeStatusSatisfies("codex", { ...ready, runtimeModelIdentity: "verified" }), false);
  assert.throws(
    () => parseProviderRuntimeStatus({ ...ready, requirementsHash: "0".repeat(64) }, "codex"),
    /does not bind the current requirement contract/,
  );
  assert.throws(
    () => parseProviderRuntimeStatus({ ...ready, runtimeProfiles: [] }, "codex"),
    /do not match the proposed catalog/,
  );
});

test("provider-specific planning and implementation profiles are unique and hash-bound", () => {
  assert.deepEqual(Object.keys(proposedProviderRuntimeProfiles.profiles).sort(), [
    "claude-implementation-macos-v2",
    "claude-planning-macos-v2",
    "codex-implementation-macos-v2",
    "codex-planning-macos-v2",
  ]);
  const codexPlanning = providerRuntimeProfileFor("codex", "planner", ["generate_structured_plan"]);
  const codexImplementation = providerRuntimeProfileFor("codex", "executor", ["implement_change"]);
  const claudePlanning = providerRuntimeProfileFor("claude_code", "synthesizer", ["generate_structured_plan"]);
  const claudeImplementation = providerRuntimeProfileFor("claude_code", "executor", ["implement_change"]);
  assert.equal(codexPlanning.profileId, "codex-planning-macos-v2");
  assert.equal(codexImplementation.profileId, "codex-implementation-macos-v2");
  assert.equal(claudePlanning.profileId, "claude-planning-macos-v2");
  assert.equal(claudeImplementation.profileId, "claude-implementation-macos-v2");
  for (const binding of [codexPlanning, codexImplementation, claudePlanning, claudeImplementation])
    assert.match(binding.profileHash, /^[a-f0-9]{64}$/);
  assert.equal(claudePlanning.profile.keychainScope.includes("exact_Claude_Code-credentials_item"), true);
  for (const binding of [claudePlanning, claudeImplementation]) {
    assert.deepEqual(binding.profile.supportedCliVersions, ["2.1.224"]);
    assert.equal(binding.profile.providerInvocation.relativeExecutableFromInstallationRoot, "2.1.224");
    assert.equal(
      binding.profile.approvedRuntimeBinding.providerExecutableSha256,
      "391df9d2ab04e4cf32199335720ac7715a582e91eaecfd4d2198a16f57ea59b3",
    );
    assert.equal(
      binding.profile.approvedRuntimeBinding.resolvedExecutableIdentitySha256,
      "75c342cc706ad06d985b0073dce7866cd9e25419487c2266c9940313b9953db7",
    );
    assert.equal(binding.profile.environmentAllowlist.includes("CLAUDE_CODE_TMPDIR"), true);
    assert.equal(binding.profile.environmentAllowlist.includes("TMPDIR"), true);
    assert.equal(binding.profile.filesystemWriteScope.includes("assignment_private_state"), true);
    assert.equal(
      binding.profile.filesystemWriteScope.some((path) => path === "/tmp" || path === "/private/tmp"),
      false,
    );
  }
  assert.deepEqual(providerRuntimeRequirements.providers.claude_code.supportedCliVersions, ["2.1.224"]);
  assert.equal(providerRuntimeRequirements.providers.claude_code.supportedCliVersions.includes("2.1.221"), false);
  assert.equal(providerRuntimeRequirements.providers.claude_code.modelSelection.fallback, "disabled");
  assert.equal(
    codexImplementation.profile.knownPlatformLimitations.includes(
      "outer_sandbox_is_sole_filesystem_authority_because_nested_codex_sandbox_fails",
    ),
    true,
  );
});

test("proposal validation rejects malformed binding and preserves normalized output", () => {
  const parsed = parseConsensusArtifact("consensus_proposal", Buffer.from(JSON.stringify(proposal())));
  assert.equal(parsed.schemaVersion, "consensus-plan-proposal/1");
  assert.equal(parsed.normalized.repository_snapshot, snapshot);
  assert.throws(
    () =>
      parseConsensusArtifact(
        "consensus_proposal",
        Buffer.from(JSON.stringify(proposal({ context_pack_hash: "wrong" }))),
      ),
    /SHA-256 hash/,
  );
});

test("artifact schemas reject extensions, structured list entries, and non-finite confidence", () => {
  for (const malformed of [
    proposal({ unexpected_authority: "expand" }),
    proposal({ validation_plan: [{ command: "npm test" }] }),
    proposal({ confidence: Number.POSITIVE_INFINITY }),
  ])
    assert.throws(
      () => parseConsensusArtifact("consensus_proposal", Buffer.from(JSON.stringify(malformed))),
      /unknown fields|bounded strings|confidence/,
    );
});

test("consensus artifacts reject JSON and environment-style generic secrets", () => {
  for (const secret of [
    '{"password":"abcdefghijklmnop"}',
    '{"access_token":"token-value-abcdefghijkl"}',
    "CLIENT_SECRET=abcdefghijklmnop",
  ])
    assert.throws(() => assertConsensusArtifactSecretSafe(Buffer.from(secret)), /secret-like material/);
  assert.doesNotThrow(() =>
    assertConsensusArtifactSecretSafe(Buffer.from('{"security_considerations":["Use a credential reference"]}')),
  );
});

test("canonical plans have deterministic hashes and verdicts bind the exact hash", () => {
  const plan = {
    schema_version: "canonical-implementation-plan/1",
    mission_id: missionId,
    repository_snapshot: snapshot,
    context_pack_hash: contextHash,
    objective: "Implement safely",
    accepted_assumptions: [],
    rejected_assumptions: [],
    architecture: "Use existing command layer",
    affected_components: [],
    data_model_changes: [],
    api_changes: [],
    migration_plan: [],
    ordered_implementation_steps: [],
    acceptance_criteria: [],
    validation_plan: ["npm test"],
    rollback_plan: [],
    security_requirements: [],
    operational_requirements: [],
    known_risks: [],
    deferred_items: [],
    executor_requirements: [],
    source_artifact_ids: [artifactId],
  };
  const parsedPlan = parseConsensusArtifact("canonical_implementation_plan", Buffer.from(JSON.stringify(plan)));
  assert.equal(parsedPlan.canonicalPlanHash, canonicalHash(plan));
  const verdict = (assignment, decision = "approve", blockers = []) =>
    parseConsensusArtifact(
      "canonical_plan_verdict",
      Buffer.from(
        JSON.stringify({
          schema_version: "canonical-plan-verdict/1",
          mission_id: missionId,
          assignment_id: assignment,
          canonical_plan_artifact_id: artifactId,
          canonical_plan_hash: parsedPlan.canonicalPlanHash,
          verdict: decision,
          blocking_objections: blockers,
          non_blocking_notes: [],
          confidence: 0.9,
        }),
      ),
    );
  assert.equal(consensusReached([verdict(assignmentId), verdict("44444444-4444-4444-8444-444444444444")]), true);
  assert.equal(
    consensusReached([verdict(assignmentId), verdict("44444444-4444-4444-8444-444444444444", "reject")]),
    false,
  );
});

test("canonical synthesis rejects missing, empty, and malformed owner-governed validation commands", () => {
  const valid = {
    schema_version: "canonical-implementation-plan/1",
    mission_id: missionId,
    repository_snapshot: snapshot,
    context_pack_hash: contextHash,
    objective: "Implement safely",
    accepted_assumptions: [],
    rejected_assumptions: [],
    architecture: "Use existing command layer",
    affected_components: [],
    data_model_changes: [],
    api_changes: [],
    migration_plan: [],
    ordered_implementation_steps: [],
    acceptance_criteria: [],
    validation_plan: ["npm test"],
    rollback_plan: [],
    security_requirements: [],
    operational_requirements: [],
    known_risks: [],
    deferred_items: [],
    executor_requirements: [],
    source_artifact_ids: [artifactId],
  };
  assert.doesNotThrow(() =>
    parseConsensusArtifact("canonical_implementation_plan", Buffer.from(JSON.stringify(valid))),
  );
  for (const malformed of [
    { ...valid, validation_plan: [] },
    { ...valid, validation_plan: [{ command: "npm test" }] },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "validation_plan")),
  ])
    assert.throws(
      () => parseConsensusArtifact("canonical_implementation_plan", Buffer.from(JSON.stringify(malformed))),
      /owner-governed validation command|bounded strings|bounded list|exactly match/,
    );
});

test("state transitions and Project Brain repository binding are server validated", () => {
  assert.doesNotThrow(() => assertConsensusTransition("proposals_complete", "critique_round"));
  assert.throws(() => assertConsensusTransition("ready", "approved"), /not allowed/);
  const commit = "c".repeat(40);
  const context = Buffer.from(`schema_version: 2.5.0\nartifact_type: context-pack\nrepository_sha: ${commit}\n`);
  assert.doesNotThrow(() => assertProjectBrainContextPack(context, commit));
  assert.throws(() => assertProjectBrainContextPack(context, "d".repeat(40)), /binding does not match/);
});
