import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import {
  preReviewProducerRegistrations,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "../lib/acceptance-pre-review-producers.ts";

const run = "00000000-0000-4000-8000-000000000043";
const bindings = Object.fromEntries(
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
  ].map((key, index) => [key, (index % 10).toString(16).repeat(64)]),
);
const assignmentId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const checkpointIds = [
  "33333333-3333-4333-8333-333333333331",
  "33333333-3333-4333-8333-333333333332",
  "33333333-3333-4333-8333-333333333333",
  "33333333-3333-4333-8333-333333333334",
];
const hash = (character) => character.repeat(64);
const authorityDefinitions = [
  ["authority.changed_executable_rejected", "executable_identity", "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED"],
  ["authority.changed_runtime_profile_rejected", "runtime_profile", "ASSIGNMENT_RUNTIME_PROFILE_CHANGED"],
  [
    "authority.changed_authentication_binding_rejected",
    "authentication_binding",
    "ASSIGNMENT_AUTHENTICATION_BINDING_CHANGED",
  ],
  [
    "authority.changed_repository_authority_rejected",
    "repository_authority",
    "ASSIGNMENT_REPOSITORY_AUTHORITY_CHANGED",
  ],
  [
    "authority.expired_capability_attestation_rejected",
    "capability_attestation_expiry",
    "CAPABILITY_ATTESTATION_EXPIRED",
  ],
  ["authority.stale_lease_rejected", "lease_sequence", "ASSIGNMENT_LEASE_STALE"],
  ["authority.stale_fencing_token_rejected", "fencing_token", "ASSIGNMENT_FENCING_TOKEN_STALE"],
  ["authority.lease_loss_rejects_output", "lease_loss_output", "ASSIGNMENT_LEASE_LOST"],
  ["authority.delayed_provider_output_rejected", "delayed_provider_output", "DELAYED_PROVIDER_OUTPUT_REJECTED"],
  ["authority.conflicting_receipt_rejected", "conflicting_receipt", "CONFLICTING_RECEIPT_REJECTED"],
  [
    "authority.cancelled_assignment_claim_rejected",
    "cancelled_assignment_claim",
    "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
  ],
];
const authorityChecks = authorityDefinitions.map(([requirement, mutationKind, rejectionCode], index) => ({
  requirement,
  mutationKind,
  assignmentId,
  attemptId,
  approvedBindingSha256: hash("a"),
  attemptedBindingSha256: hash("b"),
  rejectionCode,
  durableStateBeforeSha256: hash("c"),
  durableStateAfterSha256: hash("c"),
  leaseSequence: 7,
  fencingToken: 9,
  ...(index < 7
    ? {
        assignmentStateAtSubmission: "acknowledged",
        leaseReceiptId: "00000000-0000-4000-8000-000000000003",
        leaseTokenFingerprint: hash("d"),
        leaseExpiresAt: "2030-01-01T00:00:00.000Z",
        baselineValid: true,
        mutatedField: "runtimeProfileHash",
        routeIdentity: "agent-protocol.messages.POST/active-execution-fence/1",
        durableCountsBefore: { receipt_count: 0, artifact_count: 4, execution_status: "running" },
        durableCountsAfter: { receipt_count: 0, artifact_count: 4, execution_status: "running" },
      }
    : {}),
  ...(index === 10
    ? {
        missionId: "00000000-0000-4000-8000-000000000004",
        agentId: "00000000-0000-4000-8000-000000000005",
        assignmentStateBeforeCancellation: "available",
        assignmentStateAfterCancellation: "cancelled",
        assignmentStateAtSubmission: "cancelled",
        assignmentStateAfterRejection: "cancelled",
        assignmentRecordStatusBeforeCancellation: "available",
        assignmentRecordStatusAfterCancellation: "completed",
        assignmentRecordStatusAtSubmission: "completed",
        assignmentRecordStatusAfterRejection: "completed",
        cancellationCommandIdentitySha256: hash("1"),
        cancellationEventIdentitySha256: hash("2"),
        cancellationEvents: [
          {
            event_id: "00000000-0000-4000-8000-000000000011",
            event_type: "execution.cancellation_requested",
            aggregate_id: attemptId,
            aggregate_version: 2,
          },
          {
            event_id: "00000000-0000-4000-8000-000000000012",
            event_type: "execution.cancelled",
            aggregate_id: attemptId,
            aggregate_version: 3,
          },
        ],
        claimCommandIdentitySha256: hash("3"),
        topLevelCode: "validation_failed",
        durableCountsBefore: {
          assignment_status: "completed",
          execution_status: "cancelled",
          validation_receipt_count: 0,
          artifact_count: 0,
          provider_diagnostic_count: 0,
          lease_owner: null,
          lease_expires_at: null,
          lease_token_hash: null,
          lease_token_fingerprint: null,
          claimed_at: null,
        },
        durableCountsAfter: {
          assignment_status: "completed",
          execution_status: "cancelled",
          validation_receipt_count: 0,
          artifact_count: 0,
          provider_diagnostic_count: 0,
          lease_owner: null,
          lease_expires_at: null,
          lease_token_hash: null,
          lease_token_fingerprint: null,
          claimed_at: null,
        },
        leaseReceiptIdBefore: null,
        leaseReceiptIdAfter: null,
        fencingTokenBefore: 0,
        fencingTokenAfter: 0,
        providerInvocationCountBefore: 4,
        providerInvocationCountAfter: 4,
        positiveCompanion: {
          assignmentId: "00000000-0000-4000-8000-000000000006",
          assignmentStateAtSubmission: "available",
          claimable: true,
          leaseReceiptId: "00000000-0000-4000-8000-000000000013",
          fencingToken: 1,
        },
      }
    : {}),
}));
const runtimeDefinitions = [
  ["claude_code", "claude-implementation-macos-v2"],
  ["claude_code", "claude-planning-macos-v2"],
  ["codex", "codex-implementation-macos-v2"],
  ["codex", "codex-planning-macos-v2"],
];
const runtimeProfiles = runtimeDefinitions.map(([provider, profileId], index) => ({
  provider,
  profileId,
  catalogVersion: "provider-runtime-profiles/2",
  profileHash: hash(String((index + 1) % 10)),
  runtimeBindingHash: hash(String((index + 2) % 10)),
  providerCliVersion: "1.2.3",
  invokedExecutableSha256: hash(String((index + 3) % 10)),
  sandboxPolicySha256: hash(String((index + 4) % 10)),
}));
const checkpoints = [
  "before_mission_creation",
  "before_human_approval",
  "before_child_creation",
  "before_executor_claim",
];
const sourceCheckpoints = checkpoints.map((checkpoint, index) => ({
  checkpoint,
  checkpoint_id: checkpointIds[index],
  acceptance_run_id: run,
  action_binding: { action: checkpoint, object_id: assignmentId },
  authority_binding: { candidate_identity_sha256: hash("d") },
  manifest_sha256: hash("e"),
  manifest_canonical_sha256: hash("f"),
  governed_file_count: 42,
  result: "pass",
  missing_files: [],
  unexpected_files: [],
  changed_files: [],
  invalid_file_types: [],
  binding_hash: hash("a"),
}));
const preflight = {
  classification: "READY",
  repositoryId: "repository-1",
  noFallback: true,
  server: {
    runtimeMode: "disposable_acceptance",
    registryContentHash: bindings.disposableRegistrySha256,
    productionResourcesAllowed: false,
  },
  agents: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
  assignments: ["planner_a", "planner_b", "synthesizer", "executor"].map((role) => ({ role })),
};
const sources = {
  packet: {},
  registry: {},
  preflight,
  authorityChecks,
  runtimeProfiles,
  sourceCheckpoints,
  workflow: { disposableRegistrySha256: bindings.disposableRegistrySha256, repositoryId: "repository-1" },
};
const context = { acceptanceRunId: run, candidateBindings: bindings, observedAt: "2026-08-07T00:00:00.000Z" };
const batch = preReviewProducerRegistrations.slice(40, 60);

test("batch 03 maps authoritative pre-review requirements 41 through 60 exactly", () => {
  const expected = contract.steps.filter((step) => step.lifecycle_phase === "pre_review").slice(40, 60);
  assert.deepEqual(
    batch.map((registration) => registration.stepId),
    expected.map((step) => step.step_id),
  );
  assert.deepEqual(
    batch.map((registration) => registration.validatorId),
    expected.map((step) => step.validator_id),
  );
  assert.equal(new Set(batch.map((registration) => registration.producerId)).size, 20);
  assert.equal(new Set(batch.map((registration) => registration.schemaId)).size, 20);
});

function mutations(stepId, proof) {
  if (stepId.startsWith("authority.")) return [{ ...proof, rejectionCode: "CHANGED" }, "rejectionCode"];
  if (stepId.startsWith("runtime.")) return [{ ...proof, runtimeBindingHash: hash("f") }, "runtimeBindingHash"];
  if (stepId.startsWith("source.")) return [{ ...proof, changedFiles: ["changed.ts"] }, "bindingHash"];
  return [{ ...proof, classification: "NOT_READY" }, "registryContentHash"];
}

for (const registration of batch) {
  test(`${registration.stepId} accepts narrow evidence and rejects mutations and missing fields`, () => {
    const proof = producePreReviewEvidence(registration.stepId, sources, context);
    assert.deepEqual(validateProducedPreReviewEvidence(registration.stepId, proof, context), []);
    const [changed, missingField] = mutations(registration.stepId, proof);
    assert.notDeepEqual(validateProducedPreReviewEvidence(registration.stepId, changed, context), []);
    const missing = { ...proof };
    delete missing[missingField];
    assert.notDeepEqual(validateProducedPreReviewEvidence(registration.stepId, missing, context), []);
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(registration.stepId, { ...proof, acceptanceRunId: "wrong" }, context),
      [],
    );
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(registration.stepId, { ...proof, candidateIdentitySha256: hash("f") }, context),
      [],
    );
    const otherStep = batch.find((item) => item.stepId !== registration.stepId).stepId;
    assert.notDeepEqual(validateProducedPreReviewEvidence(otherStep, proof, context), []);
  });
}

test("runtime mappings reject provider and profile substitutions", () => {
  const proof = producePreReviewEvidence("runtime.codex_planning_macos_v2", sources, context);
  for (const changed of [
    { ...proof, provider: "claude_code" },
    { ...proof, profileId: "changed-profile" },
  ])
    assert.notDeepEqual(validateProducedPreReviewEvidence("runtime.codex_planning_macos_v2", changed, context), []);
});

test("presentation rows reject terminal, stale, inner-only, and secret-bearing evidence", () => {
  const proof = producePreReviewEvidence("authority.changed_executable_rejected", sources, context);
  for (const changed of [
    { ...proof, assignmentStateAtSubmission: "completed" },
    { ...proof, leaseExpiresAt: "invalid" },
    { ...proof, fencingToken: 0 },
    { ...proof, baselineValid: false },
    { ...proof, routeIdentity: "inner-validator-only" },
    { ...proof, leaseTokenFingerprint: "mc_lease_forbidden" },
  ])
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(proof.stepId ?? "authority.changed_executable_rejected", changed, context),
      [],
    );
});

test("source mapping rejects a checkpoint from another acceptance run", () => {
  const proof = producePreReviewEvidence("source.before_mission_creation", sources, context);
  assert.notDeepEqual(
    validateProducedPreReviewEvidence(
      "source.before_mission_creation",
      { ...proof, sourceAcceptanceRunId: "wrong" },
      context,
    ),
    [],
  );
});

test("broad sources and the next unmapped requirement remain fail-closed", () => {
  assert.notDeepEqual(validateProducedPreReviewEvidence("workflow.preflight", preflight, context), []);
  assert.throws(() => producePreReviewEvidence("semantic.unmapped_probe", sources, context), /unmapped/);
});
