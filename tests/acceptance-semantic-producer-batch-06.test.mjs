import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import {
  preReviewProducerRegistrations,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "../lib/acceptance-pre-review-producers.ts";

const run = "00000000-0000-4000-8000-000000000046";
const uuid = (digit) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const hash = (character) => character.repeat(64);
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
const unchanged = { durableStateBeforeSha256: hash("a"), durableStateAfterSha256: hash("a") };
const recovery = {
  leaseLoss: {
    activeLeaseFingerprint: hash("1"),
    activeFencingIdentity: hash("2"),
    providerProcessIdentitySha256: hash("3"),
    stateBeforeLeaseLoss: "running",
    leaseLossEventIdentity: uuid("4"),
    cancellationFencingActionIdentity: uuid("5"),
    processDisposition: "terminated",
    postLossSubmissionIdentity: uuid("6"),
    actualRejectionCode: "ASSIGNMENT_LEASE_LOST",
    artifactCountBefore: 1,
    artifactCountAfter: 1,
    eventCountBefore: 2,
    eventCountAfter: 2,
    receiptCountBefore: 1,
    receiptCountAfter: 1,
    cleanupEvidenceSha256: hash("4"),
    assignmentId: uuid("1"),
    attemptId: uuid("2"),
    leaseSequence: 3,
    fencingToken: 4,
    outputReceiptSha256: hash("b"),
    rejectionCode: "ASSIGNMENT_LEASE_LOST",
    ...unchanged,
  },
  delayedOutput: {
    provider: "codex",
    model: "gpt-5.6-luna",
    runtimeProfile: "codex-implementation-macos-v2",
    authorizedLifecycleState: "running",
    staleTransitionIdentity: uuid("7"),
    staleTransitionEventIdentity: uuid("8"),
    delayedSubmissionIdentity: uuid("9"),
    delayedSubmissionAt: "2026-08-07T00:00:00Z",
    leaseFingerprintAtSubmission: hash("5"),
    fencingIdentityAtSubmission: hash("6"),
    actualRejectionCode: "DELAYED_PROVIDER_OUTPUT_REJECTED",
    artifactCountBefore: 1,
    artifactCountAfter: 1,
    eventCountBefore: 2,
    eventCountAfter: 2,
    receiptCountBefore: 1,
    receiptCountAfter: 1,
    staleContentAuthoritative: false,
    assignmentId: uuid("1"),
    attemptId: uuid("2"),
    completedAttemptId: uuid("3"),
    outputReceiptSha256: hash("c"),
    rejectionCode: "DELAYED_PROVIDER_OUTPUT_REJECTED",
    ...unchanged,
  },
  conflictingReceipt: {
    originalReceiptId: uuid("4"),
    conflictingReceiptId: uuid("5"),
    originalReceiptSha256: hash("d"),
    conflictingReceiptSha256: hash("e"),
    immutableBindings: { assignmentId: uuid("1") },
    conflictingFields: ["resultCommit"],
    submissionResult: "rejected",
    actualRejectionCode: "CONFLICTING_RECEIPT_REJECTED",
    receiptStoreIdentityBefore: hash("7"),
    receiptStoreIdentityAfter: hash("7"),
    eventStateIdentityBefore: hash("8"),
    eventStateIdentityAfter: hash("8"),
    projectionStateIdentityBefore: hash("9"),
    projectionStateIdentityAfter: hash("9"),
    authoritativeReceiptSha256After: hash("d"),
    assignmentId: uuid("1"),
    acceptedReceiptSha256: hash("d"),
    conflictingReceiptSha256: hash("e"),
    rejectionCode: "CONFLICTING_RECEIPT_REJECTED",
    ...unchanged,
  },
};
const isolation = {
  productionResourceRejection: {
    requestedClassification: "production",
    localTargetRepresentation: "postgresql://production.invalid/local-probe",
    preflightOperationIdentity: uuid("7"),
    policyDecision: "rejected",
    actualTopLevelErrorCode: "validation_failed",
    actualRejectionCode: "PRODUCTION_RESOURCE_FORBIDDEN",
    authorityPolicyVersion: "resource-authority-policy/1",
    evaluationIdentity: hash("f"),
    runtimeMode: "disposable_acceptance",
    productionAuthority: false,
    resourceType: "database",
    requestedOperation: "connect",
    dnsResolutionAttemptsBefore: 0,
    dnsResolutionAttemptsAfter: 0,
    socketConnectionAttemptsBefore: 0,
    socketConnectionAttemptsAfter: 0,
    databaseConnectionAttemptsBefore: 0,
    databaseConnectionAttemptsAfter: 0,
    providerInvocationCountBefore: 0,
    providerInvocationCountAfter: 0,
    remoteHttpAttemptsBefore: 0,
    remoteHttpAttemptsAfter: 0,
    durableStateBeforeSha256: hash("a"),
    durableStateAfterSha256: hash("a"),
    productionEndpointContacted: false,
    terminalState: "rejected_before_access",
  },
  runtimeMode: "disposable_acceptance",
  productionResourcesAllowed: false,
  productionResourceProbeCount: 4,
  rejectedProbeCount: 4,
  disposableDatabaseIsolation: {
    runtimeMode: "disposable_acceptance",
    productionAuthority: false,
    databaseResourceInventoryId: "disposable-database",
    connectionConfigurationIdentity: hash("0"),
    acceptedDisposableTargetResult: "accepted",
    forbiddenTargetResult: "rejected_before_connection",
    actualRejectionCode: "PRODUCTION_RESOURCE_FORBIDDEN",
    connectionAttemptsBeforeForbidden: 1,
    connectionAttemptsAfterForbidden: 1,
    productionEndpointContacted: false,
    expectedDatabaseIdentitySha256: hash("1"),
    actualDatabaseIdentitySha256: hash("1"),
    forbiddenDatabaseIdentitySha256: hash("2"),
    databaseScope: "disposable",
  },
  databaseIdentitySha256: hash("1"),
  disposableDatabaseIdentitySha256: hash("1"),
  productionDatabaseIdentitySha256: hash("2"),
  databaseScope: "disposable",
  observedWritableRoots: ["/tmp/acceptance/artifacts", "/tmp/acceptance/worktree"],
  approvedWritableRoots: ["/tmp/acceptance/artifacts", "/tmp/acceptance/worktree"],
  deniedWriteProbeCount: 3,
  escapedWriteCount: 0,
  sourceRepositoryStateBeforeSha256: hash("3"),
  sourceRepositoryStateAfterSha256: hash("3"),
  executorWorktreeStateBeforeSha256: hash("4"),
  executorWorktreeStateAfterSha256: hash("5"),
  mutationPath: "/tmp/acceptance/worktree/change.ts",
  approvedWorktreePath: "/tmp/acceptance/worktree",
};
const replay = {
  workspaceId: run,
  liveProjectionSha256: hash("6"),
  replayedProjectionSha256: hash("6"),
  deletionReceiptSha256: hash("7"),
  rebuildReceiptSha256: hash("8"),
  comparisonReceiptSha256: hash("9"),
  canonicalEventSetSha256: hash("a"),
  projectionRowsBeforeDelete: 12,
  projectionRowsAfterDelete: 0,
  projectionRowsAfterRebuild: 12,
};
const secrets = {
  scanArtifactSha256: hash("b"),
  scannedByteCount: 4096,
  exactCredentialMatches: 0,
  credentialPatternMatches: 0,
  rawLeaseTokenPatternMatches: 0,
  forbiddenLeaseTokenKeys: 0,
};
const sources = { packet: {}, registry: {}, preflight: {}, recovery, isolation, replay, secrets };
const context = { acceptanceRunId: run, candidateBindings: bindings, observedAt: "2026-08-07T00:00:00.000Z" };
const batch = preReviewProducerRegistrations.slice(100, 114);

test("batch 06 maps the exact final authoritative pre-review requirement set", () => {
  const expected = contract.steps.filter((step) => step.lifecycle_phase === "pre_review").slice(100);
  assert.equal(preReviewProducerRegistrations.length, 114);
  assert.deepEqual(
    batch.map((registration) => registration.stepId),
    expected.map((step) => step.step_id),
  );
  assert.deepEqual(
    batch.map((registration) => registration.validatorId),
    expected.map((step) => step.validator_id),
  );
  assert.equal(new Set(preReviewProducerRegistrations.map((registration) => registration.stepId)).size, 114);
  assert.equal(new Set(preReviewProducerRegistrations.map((registration) => registration.producerId)).size, 114);
  assert.equal(new Set(preReviewProducerRegistrations.map((registration) => registration.schemaId)).size, 114);
  assert.equal(new Set(preReviewProducerRegistrations.map((registration) => registration.validatorId)).size, 114);
});

function mutation(stepId, proof) {
  if (stepId === "recovery.lease_loss") return [{ ...proof, rejectionCode: "CHANGED" }, "outputReceiptSha256"];
  if (stepId === "recovery.delayed_output")
    return [{ ...proof, completedAttemptId: proof.attemptId }, "outputReceiptSha256"];
  if (stepId === "recovery.conflicting_receipt")
    return [{ ...proof, conflictingReceiptSha256: proof.acceptedReceiptSha256 }, "conflictingReceiptSha256"];
  if (stepId === "isolation.production_resources_rejected")
    return [{ ...proof, productionResourcesAllowed: true }, "productionResourceProbeCount"];
  if (stepId === "isolation.disposable_database_only")
    return [{ ...proof, databaseIdentitySha256: proof.productionDatabaseIdentitySha256 }, "databaseIdentitySha256"];
  if (stepId === "isolation.provider_writable_roots_bounded")
    return [
      { ...proof, observedWritableRoots: [...proof.observedWritableRoots, "/production"] },
      "observedWritableRoots",
    ];
  if (stepId === "isolation.repository_mutation_isolated")
    return [{ ...proof, sourceRepositoryStateAfterSha256: hash("f") }, "mutationPath"];
  if (stepId === "replay.projections_deleted")
    return [{ ...proof, projectionRowsAfterDelete: 1 }, "deletionReceiptSha256"];
  if (stepId === "replay.projections_rebuilt")
    return [{ ...proof, projectionRowsAfterRebuild: 0 }, "rebuildReceiptSha256"];
  if (stepId === "replay.live_equals_replay")
    return [{ ...proof, replayedProjectionSha256: hash("f") }, "comparisonReceiptSha256"];
  const resultField = {
    "secrets.exact_credential_scan": "exactCredentialMatches",
    "secrets.credential_pattern_scan": "credentialPatternMatches",
    "secrets.lease_token_pattern_scan": "rawLeaseTokenPatternMatches",
    "secrets.forbidden_lease_token_key_scan": "forbiddenLeaseTokenKeys",
  }[stepId];
  return [{ ...proof, [resultField]: 1 }, resultField];
}

for (const registration of batch)
  test(`${registration.stepId} validates narrow substantive and immutable proof evidence`, () => {
    const proof = producePreReviewEvidence(registration.stepId, sources, context);
    assert.deepEqual(validateProducedPreReviewEvidence(registration.stepId, proof, context), []);
    const [changed, missingField] = mutation(registration.stepId, proof);
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

test("exact requirement-set equality holds and unknown requirements remain fail-closed", () => {
  const authoritative = new Set(
    contract.steps.filter((step) => step.lifecycle_phase === "pre_review").map((step) => step.step_id),
  );
  const mapped = new Set(preReviewProducerRegistrations.map((registration) => registration.stepId));
  assert.deepEqual([...mapped].sort(), [...authoritative].sort());
  assert.throws(() => producePreReviewEvidence("semantic.unmapped_probe", sources, context), /unmapped/);
  assert.deepEqual(validateProducedPreReviewEvidence("semantic.unmapped_probe", {}, context), [
    "REQUIREMENT_SPECIFIC_SEMANTIC_VALIDATOR_UNMAPPED",
  ]);
});

test("broad source structures cannot satisfy final requirement proofs", () => {
  for (const registration of batch)
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(registration.stepId, sources[registration.stepId.split(".")[0]], context),
      [],
    );
});

test("v2 operational recovery schemas reject summary-only and mutated raw observations", () => {
  for (const stepId of [
    "recovery.lease_loss",
    "recovery.delayed_output",
    "recovery.conflicting_receipt",
    "isolation.production_resources_rejected",
  ]) {
    const proof = producePreReviewEvidence(stepId, sources, context);
    assert.notDeepEqual(validateProducedPreReviewEvidence(stepId, { ...proof, observation: undefined }, context), []);
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(
        stepId,
        { ...proof, observation: { ...proof.observation, actualRejectionCode: "SYNTHETIC_EXPECTED_LABEL" } },
        context,
      ),
      [],
    );
    const terminalMutation =
      stepId === "recovery.lease_loss"
        ? { processDisposition: "running" }
        : stepId === "recovery.delayed_output"
          ? { staleContentAuthoritative: true }
          : stepId === "recovery.conflicting_receipt"
            ? { authoritativeReceiptSha256After: hash("0") }
            : { terminalState: "connection_attempted" };
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(
        stepId,
        { ...proof, observation: { ...proof.observation, ...terminalMutation } },
        context,
      ),
      [],
    );
  }
});
