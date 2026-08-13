import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import {
  preReviewProducerRegistrations,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "../lib/acceptance-pre-review-producers.ts";

const run = "00000000-0000-4000-8000-000000000045";
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
const rejectionDefinitions = [
  ["malformedCritique", "critique_schema", "MALFORMED_CONSENSUS_CRITIQUE"],
  ["malformedRevision", "revision_schema", "MALFORMED_CONSENSUS_REVISION"],
  ["malformedSynthesis", "synthesis_schema", "MALFORMED_CANONICAL_SYNTHESIS"],
  ["malformedVerdict", "verdict_schema", "MALFORMED_CANONICAL_VERDICT"],
  ["wrongConsensusState", "consensus_state", "CONSENSUS_STATE_MISMATCH"],
  ["wrongRepositorySnapshot", "repository_snapshot", "REPOSITORY_SNAPSHOT_MISMATCH"],
  ["wrongContextPack", "context_pack", "CONTEXT_PACK_MISMATCH"],
  ["wrongArtifactHash", "artifact_hash", "ARTIFACT_HASH_MISMATCH"],
];
const adversarial = Object.fromEntries(
  rejectionDefinitions.map(([key, mutationKind, rejectionCode]) => [
    key,
    {
      mutationKind,
      rejectionCode,
      attemptedValueSha256: hash("a"),
      approvedValueSha256: hash("b"),
      providerInvocationCountBefore: 0,
      providerInvocationCountAfter: 0,
      durableStateBeforeSha256: hash("c"),
      durableStateAfterSha256: hash("c"),
    },
  ]),
);
adversarial.duplicateMessage = {
  messageId: uuid("1"),
  bodySha256: hash("d"),
  firstReceiptSha256: hash("e"),
  replayReceiptSha256: hash("e"),
  durableEventCountBeforeReplay: 4,
  durableEventCountAfterReplay: 4,
};
for (const [key, mutationKind, actualRejectionCode] of [
  ["wrongCanonicalPlanHash", "canonical_plan_hash", "CANONICAL_PLAN_HASH_MISMATCH"],
  ["repositoryDrift", "repository_drift", "REPOSITORY_DRIFT_REJECTED"],
])
  adversarial[key] = {
    mutationKind,
    protectedOperation: key === "wrongCanonicalPlanHash" ? "record_verdict" : "authorize_executor_claim",
    commandIdentity: uuid("2"),
    repositoryId: uuid("3"),
    mutationPath: "/tmp/disposable/repository/file.ts",
    actualTopLevelErrorCode: "validation_failed",
    actualRejectionCode,
    attemptedValueSha256: hash("a"),
    approvedValueSha256: hash("b"),
    providerInvocationCountBefore: 0,
    providerInvocationCountAfter: 0,
    verdictCountBefore: 2,
    verdictCountAfter: 2,
    approvalCountBefore: 0,
    approvalCountAfter: 0,
    childMissionCountBefore: 0,
    childMissionCountAfter: 0,
    executionCountBefore: 0,
    executionCountAfter: 0,
    artifactCountBefore: 0,
    artifactCountAfter: 0,
    durableStateBeforeSha256: hash("c"),
    durableStateAfterSha256: hash("c"),
  };
adversarial.sourceClosureMutation = {
  sourceManifestSha256: hash("f"),
  cases: ["changed_file", "added_file", "deleted_file", "symlink_substitution", "file_type_substitution"].map(
    (mutationKind) => ({
      mutationKind,
      actualRejectionCode: "ACCEPTANCE_SOURCE_CLOSURE_FAILURE",
      sourceStateBeforeSha256: hash("f"),
      mutatedSourceStateSha256: hash("1"),
      protectedActionInvocations: 0,
      evidence: { result: "fail" },
    }),
  ),
};
adversarial.checkpointMisuse = {
  cases: ["wrong_run", "wrong_candidate", "wrong_phase", "wrong_action", "reuse", "stale_identity"].map(
    (misuseKind, index) => ({
      misuseKind,
      checkpointId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
      bindingSha256: hash("2"),
      actualRejectionCode: "SOURCE_CHECKPOINT_REUSE_REJECTED",
      protectedActionInvocations: 0,
      durableStateBeforeSha256: hash("3"),
      durableStateAfterSha256: hash("3"),
    }),
  ),
};
adversarial.realProviderLifecycle = ["codex", "claude_code"].flatMap((provider) =>
  ["planning", "implementation"].flatMap((operationClass) =>
    ["timeout", "cancellation"].map((probe) => ({
      provider,
      profileId: `${provider}-${operationClass}`,
      operationClass,
      probe,
      requestedModel: `${provider}-model`,
      exitCode: null,
      terminationSignal: "SIGTERM",
      timedOut: probe === "timeout",
      cancellationRequested: probe === "cancellation",
      processTreeTerminationAttempted: true,
      processGroupAliveAfterTermination: false,
    })),
  ),
);
const applicability = [
  { role: "planner_a", provider: "claude_code", model: "claude-fable-5", profile: "claude-planning-macos-v2" },
  { role: "planner_b", provider: "codex", model: "gpt-5.6-sol", profile: "codex-planning-macos-v2" },
  { role: "synthesizer", provider: "claude_code", model: "claude-fable-5", profile: "claude-planning-macos-v2" },
  { role: "executor", provider: "codex", model: "gpt-5.6-luna", profile: "codex-implementation-macos-v2" },
];
const diagnostics = {
  evidenceMode: "mock_fixture",
  applicability,
  exactModelArgument: applicability.map((item) => ({
    ...item,
    modelArgument: item.model,
    modelArgumentAccepted: true,
  })),
  runtimeIdentityHonesty: applicability.map((item) => ({
    ...item,
    declaredRuntimeIdentity: "unverifiable",
    independentlyVerifiable: false,
  })),
  processTreeTerminated: applicability.map((item) => ({
    ...item,
    processTreeTerminationAttempted: true,
    processGroupAliveAfterTermination: false,
  })),
  secretRedaction: applicability.map((item) => ({
    ...item,
    exactCredentialMatches: 0,
    credentialPatternMatches: 0,
    redactionApplied: true,
  })),
};
const recovery = {
  providerRestart: {
    originalProcessResourceId: "provider-1",
    replacementProcessResourceId: "provider-2",
    originalPid: 101,
    replacementPid: 202,
    originalPgid: 101,
    replacementPgid: 202,
    originalProcessIdentitySha256: hash("1"),
    replacementProcessIdentitySha256: hash("2"),
    provider: "codex",
    model: "gpt-5.6-luna",
    runtimeProfile: "codex-implementation-macos-v2",
    terminationObserved: true,
    resumedOperationIdentity: uuid("7"),
    resumedResultIdentity: uuid("8"),
    staleOutputRejected: true,
    originalProcessStopped: true,
    authoritativeStateCoherent: true,
    providerProcessReceivedLeaseCredential: false,
    providerProcessReceivedFencingBinding: true,
    originalExitCode: 1,
    replacementExitCode: 0,
    originalStdoutSha256: hash("5"),
    replacementStdoutSha256: hash("6"),
    selectedProviderAttemptId: "1-2",
    resultArtifactProviderAttemptId: "1-2",
    originalResultArtifactCount: 0,
    replacementResultArtifactCount: 1,
    authoritativeResultCountBefore: 0,
    authoritativeResultCountAfter: 1,
    duplicateAuthoritativeResultCount: 0,
    cleanupResourceIds: ["provider-1", "provider-2"],
    assignmentId: uuid("4"),
    assignmentAttemptBefore: 1,
    assignmentAttemptAfter: 1,
    firstProviderAttemptId: "1-1",
    restartedProviderAttemptId: "1-2",
    leaseIdBefore: uuid("5"),
    leaseIdAfter: uuid("5"),
    leaseFingerprintBefore: hash("4"),
    leaseFingerprintAfter: hash("4"),
    fencingTokenBefore: 3,
    fencingTokenAfter: 3,
    durableStateBeforeSha256: hash("3"),
    durableStateAfterSha256: hash("4"),
  },
  missionControlRestart: {
    serverResourceId: "server-1",
    restartedServerResourceId: "server-2",
    originalPid: 301,
    restartedPid: 302,
    originalProcessIdentitySha256: hash("1"),
    restartedProcessIdentitySha256: hash("2"),
    executableIdentitySha256: hash("3"),
    restartedExecutableIdentitySha256: hash("3"),
    originalListenerStopped: true,
    originalProcessTerminated: true,
    listenerResourceId: "listener-1",
    restartedListenerResourceId: "listener-2",
    shutdownInitiatedAt: "2026-08-07T00:00:00Z",
    shutdownCompletedAt: "2026-08-07T00:00:01Z",
    shutdownRequestIdentity: hash("6"),
    shutdownEvidenceIdentity: hash("7"),
    readinessObserved: true,
    revalidation: { candidate: true, source: true, contract: true, registry: true },
    nextOperationResult: { applied: true, eventId: uuid("8") },
    missionCountBefore: 1,
    missionCountAfter: 1,
    artifactCountBefore: 10,
    artifactCountAfter: 10,
    assignmentCountBefore: 4,
    assignmentCountAfter: 4,
    eventContinuity: true,
    cleanupResourceIds: ["server-1", "server-2", "listener-1", "listener-2"],
    missionId: uuid("9"),
    acceptanceRunIdBefore: run,
    acceptanceRunIdAfter: run,
    canonicalEventSetSha256Before: hash("4"),
    canonicalEventSetSha256After: hash("4"),
    projectionSha256Before: hash("5"),
    projectionSha256After: hash("5"),
  },
};
const sources = { packet: {}, registry: {}, preflight: {}, adversarial, diagnostics, recovery };
const context = { acceptanceRunId: run, candidateBindings: bindings, observedAt: "2026-08-07T00:00:00.000Z" };
const batch = preReviewProducerRegistrations.slice(80, 100);

test("batch 05 maps authoritative pre-review requirements 81 through 100 exactly", () => {
  const expected = contract.steps.filter((step) => step.lifecycle_phase === "pre_review").slice(80, 100);
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

function mutation(stepId, proof) {
  if (stepId.startsWith("diagnostic."))
    return [
      {
        ...proof,
        applicability: proof.applicability.map((item, index) => (index ? item : { ...item, model: "changed" })),
      },
      "observations",
    ];
  if (stepId === "adversarial.duplicate_message_idempotent")
    return [{ ...proof, replayReceiptSha256: hash("9") }, "bodySha256"];
  if (stepId === "adversarial.source_closure_mutation_matrix")
    return [{ ...proof, cases: proof.cases.slice(1) }, "cases"];
  if (stepId === "adversarial.checkpoint_identity_and_reuse")
    return [{ ...proof, cases: proof.cases.slice(1) }, "cases"];
  if (stepId === "adversarial.provider_lifecycle_matrix")
    return [
      {
        ...proof,
        observations: proof.observations.map((item, index) =>
          index ? item : { ...item, processGroupAliveAfterTermination: true },
        ),
      },
      "observations",
    ];
  if (stepId === "recovery.provider_restart")
    return [{ ...proof, fencingTokenAfter: proof.fencingTokenBefore - 1 }, "restartedProviderAttemptId"];
  if (stepId === "recovery.mission_control_restart")
    return [{ ...proof, projectionSha256After: hash("9") }, "canonicalEventSetSha256After"];
  return [{ ...proof, rejectionCode: "CHANGED" }, "attemptedValueSha256"];
}

for (const registration of batch)
  test(`${registration.stepId} validates narrow or explicitly deferred evidence`, () => {
    const proof = producePreReviewEvidence(registration.stepId, sources, context);
    const expected = registration.stepId.startsWith("diagnostic.") ? ["DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"] : [];
    assert.deepEqual(validateProducedPreReviewEvidence(registration.stepId, proof, context), expected);
    const [changed, missingField] = mutation(registration.stepId, proof);
    assert.notDeepEqual(validateProducedPreReviewEvidence(registration.stepId, changed, context), expected);
    const missing = { ...proof };
    delete missing[missingField];
    assert.notDeepEqual(validateProducedPreReviewEvidence(registration.stepId, missing, context), expected);
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(registration.stepId, { ...proof, acceptanceRunId: "wrong" }, context),
      expected,
    );
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(registration.stepId, { ...proof, candidateIdentitySha256: hash("9") }, context),
      expected,
    );
    const otherStep = batch.find((item) => item.stepId !== registration.stepId).stepId;
    assert.notDeepEqual(validateProducedPreReviewEvidence(otherStep, proof, context), expected);
  });

test("all four diagnostics reject provider, model, role, and profile substitutions and remain deferred", () => {
  for (const registration of batch.filter((item) => item.stepId.startsWith("diagnostic."))) {
    const proof = producePreReviewEvidence(registration.stepId, sources, context);
    for (const field of ["provider", "model", "role", "profile"]) {
      const applicabilityChanged = proof.applicability.map((item, index) =>
        index ? item : { ...item, [field]: "changed" },
      );
      const reasons = validateProducedPreReviewEvidence(
        registration.stepId,
        { ...proof, applicability: applicabilityChanged },
        context,
      );
      assert.ok(reasons.includes("DIAGNOSTIC_EVIDENCE_INVALID"));
      assert.ok(reasons.includes("DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"));
    }
  }
});

test("mock diagnostic observations cannot be relabeled as authenticated runtime evidence", () => {
  for (const registration of batch.filter((item) => item.stepId.startsWith("diagnostic."))) {
    const proof = producePreReviewEvidence(registration.stepId, sources, context);
    const reasons = validateProducedPreReviewEvidence(
      registration.stepId,
      { ...proof, evidenceMode: "authenticated_runtime" },
      context,
    );
    assert.ok(reasons.includes("DIAGNOSTIC_EVIDENCE_INVALID"));
    assert.ok(!reasons.includes("DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"));
  }
});

test("broad adversarial evidence and the next unmapped requirement remain fail-closed", () => {
  assert.notDeepEqual(
    validateProducedPreReviewEvidence("adversarial.malformed_critique_rejected", adversarial, context),
    [],
  );
  assert.throws(() => producePreReviewEvidence("semantic.unmapped_probe", sources, context), /unmapped/);
});

test("v2 restart schemas reject summary-only, same-generation, and missing terminal evidence", () => {
  for (const stepId of ["recovery.provider_restart", "recovery.mission_control_restart"]) {
    const proof = producePreReviewEvidence(stepId, sources, context);
    assert.notDeepEqual(validateProducedPreReviewEvidence(stepId, { ...proof, observation: undefined }, context), []);
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(
        stepId,
        {
          ...proof,
          observation: {
            ...proof.observation,
            replacementPid: proof.observation.originalPid,
            restartedPid: proof.observation.originalPid,
          },
        },
        context,
      ),
      [],
    );
    assert.notDeepEqual(
      validateProducedPreReviewEvidence(
        stepId,
        {
          ...proof,
          observation: { ...proof.observation, terminationObserved: false, originalProcessTerminated: false },
        },
        context,
      ),
      [],
    );
  }
});

test("provider restart v4 preserves assignment authority and rejects wrong generation or result selection", () => {
  const stepId = "recovery.provider_restart";
  const proof = producePreReviewEvidence(stepId, sources, context);
  assert.deepEqual(validateProducedPreReviewEvidence(stepId, proof, context), []);
  for (const mutation of [
    { ...proof, assignmentId: uuid("9") },
    { ...proof, assignmentAttemptAfter: proof.assignmentAttemptBefore + 1 },
    { ...proof, leaseIdAfter: uuid("9") },
    { ...proof, leaseFingerprintAfter: hash("9") },
    { ...proof, fencingTokenAfter: proof.fencingTokenBefore + 1 },
    { ...proof, restartedProviderAttemptId: proof.firstProviderAttemptId },
    {
      ...proof,
      observation: {
        ...proof.observation,
        replacementProcessIdentitySha256: proof.observation.originalProcessIdentitySha256,
      },
    },
    { ...proof, observation: { ...proof.observation, selectedProviderAttemptId: proof.firstProviderAttemptId } },
    { ...proof, observation: { ...proof.observation, originalResultArtifactCount: 1 } },
    { ...proof, observation: { ...proof.observation, duplicateAuthoritativeResultCount: 1 } },
    { ...proof, observation: undefined },
  ])
    assert.notDeepEqual(validateProducedPreReviewEvidence(stepId, mutation, context), []);
});
