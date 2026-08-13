import assert from "node:assert/strict";
import test from "node:test";
import {
  NEXT_CONSENSUS_OBSERVATION_DEFINITIONS,
  generateRemainingConsensusObservations,
} from "../lib/acceptance-consensus-observations.ts";
import { producePreReviewEvidence, validateProducedPreReviewEvidence } from "../lib/acceptance-pre-review-producers.ts";

const h = (c) => c.repeat(64);
const u = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const run = u("1");
const roles = [
  ["planner_a", "claude_code", "claude-fable-5", "claude-planning-macos-v2"],
  ["planner_b", "codex", "gpt-5.6-sol", "codex-planning-macos-v2"],
  ["synthesizer", "claude_code", "claude-fable-5", "claude-planning-macos-v2"],
  ["executor", "codex", "gpt-5.6-luna", "codex-implementation-macos-v2"],
];
const artifacts = Object.fromEntries(
  ["proposal", "critique", "revision", "synthesis", "verdict"].map((key, index) => [
    key,
    {
      artifactKind: [
        "consensus_proposal",
        "consensus_critique",
        "consensus_revision",
        "canonical_implementation_plan",
        "canonical_plan_verdict",
      ][index],
      schemaVersion: [
        "consensus-plan-proposal/1",
        "consensus-plan-critique/1",
        "consensus-plan-revision/1",
        "canonical-implementation-plan/1",
        "canonical-plan-verdict/1",
      ][index],
      artifactId: u(String(index + 2)),
      artifactSha256: h(String(index + 2)),
      assignmentId: u(String(index + 3)),
      provider: "codex",
      model: "gpt-5.6-sol",
      role: "planner_b",
      runtimeProfile: "codex-planning-macos-v2",
    },
  ]),
);
const baseline = {
  acceptanceRunId: run,
  candidateIdentitySha256: h("a"),
  missionId: u("2"),
  assignmentId: u("3"),
  attemptId: u("4"),
  provider: "codex",
  model: "gpt-5.6-luna",
  role: "executor",
  runtimeProfile: "codex-implementation-macos-v2",
  expectedProvider: "codex",
  expectedModel: "gpt-5.6-luna",
  expectedRole: "executor",
  expectedRuntimeProfile: "codex-implementation-macos-v2",
  repositorySnapshotSha256: h("b"),
  repositoryAuthoritySha256: h("c"),
  contextPackSha256: h("d"),
  consensusState: "awaiting_human_approval",
  providerInvocationCount: 10,
  durableStateSha256: h("e"),
  artifacts,
  canonicalPlanSha256: h("f"),
  duplicateMessage: {
    messageId: u("5"),
    bodySha256: h("1"),
    firstReceiptSha256: h("2"),
    replayReceiptSha256: h("2"),
    durableEventCountBeforeReplay: 8,
    durableEventCountAfterReplay: 8,
  },
  sourceClosureMutationCases: ["changed_file", "missing_file", "unexpected_file", "invalid_file_type"].map(
    (mutationKind, index) => ({
      mutationKind,
      rejectionCode: "ACCEPTANCE_SOURCE_CLOSURE_FAILURE",
      sourceStateBeforeSha256: h("3"),
      mutatedSourceStateSha256: h(String(index + 4)),
    }),
  ),
  checkpointIdentity: {
    firstCheckpointId: u("6"),
    replayCheckpointId: u("7"),
    firstBindingSha256: h("8"),
    replayBindingSha256: h("8"),
    reuseRejectionCode: "SOURCE_CHECKPOINT_REUSE_REJECTED",
  },
  providerLifecycle: roles.flatMap(([role, provider, model, profileId]) =>
    ["timeout", "cancellation"].map((probe) => ({
      role,
      provider,
      profileId,
      operationClass: role === "executor" ? "implementation" : "planning",
      probe,
      requestedModel: model,
      exitCode: null,
      terminationSignal: "SIGTERM",
      timedOut: probe === "timeout",
      cancellationRequested: probe === "cancellation",
      processTreeTerminationAttempted: true,
      processGroupAliveAfterTermination: false,
    })),
  ),
  providerDiagnostics: roles.map(([role, provider, model, profile]) => ({
    role,
    provider,
    model,
    profile,
    modelArgument: model,
    modelArgumentAccepted: true,
    declaredRuntimeIdentity: "unverifiable",
    independentlyVerifiable: false,
    processTreeTerminationAttempted: true,
    processGroupAliveAfterTermination: false,
    exactCredentialMatches: 0,
    credentialPatternMatches: 0,
    redactionApplied: true,
  })),
};
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
  ].map((key) => [key, h("9")]),
);
const context = { acceptanceRunId: run, candidateBindings, observedAt: "2026-08-08T20:00:00.000Z" };
const sources = (o) => ({ adversarial: o, diagnostics: o.diagnostics });

test("the next ten observations match authoritative contract order and validate", () => {
  const observations = generateRemainingConsensusObservations(baseline);
  assert.equal(NEXT_CONSENSUS_OBSERVATION_DEFINITIONS.length, 10);
  for (const [stepId] of NEXT_CONSENSUS_OBSERVATION_DEFINITIONS) {
    const proof = producePreReviewEvidence(stepId, sources(observations), context);
    const reasons = validateProducedPreReviewEvidence(stepId, proof, context);
    if (stepId.startsWith("diagnostic.")) assert.deepEqual(reasons, ["DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"]);
    else assert.deepEqual(reasons, []);
  }
});

test("substantive, rejection, durable-state, run, candidate, and runtime-binding mutations fail closed", () => {
  const observations = generateRemainingConsensusObservations(baseline);
  for (const [stepId] of NEXT_CONSENSUS_OBSERVATION_DEFINITIONS) {
    const proof = producePreReviewEvidence(stepId, sources(observations), context);
    const mutations = [
      { ...proof, acceptanceRunId: "wrong" },
      { ...proof, candidateIdentitySha256: h("0") },
    ];
    if (stepId.includes("wrong_") || stepId.includes("repository_drift"))
      mutations.push({ ...proof, attemptedValueSha256: proof.approvedValueSha256 });
    if (stepId === "adversarial.duplicate_message_idempotent")
      mutations.push({ ...proof, durableEventCountAfterReplay: 9 });
    if (stepId === "adversarial.source_closure_mutation_matrix")
      mutations.push({ ...proof, cases: proof.cases.slice(1) });
    if (stepId === "adversarial.checkpoint_identity_and_reuse")
      mutations.push({ ...proof, replayBindingSha256: h("0") });
    if (stepId === "adversarial.provider_lifecycle_matrix")
      mutations.push({
        ...proof,
        observations: proof.observations.map((item, index) =>
          index ? item : { ...item, processGroupAliveAfterTermination: true },
        ),
      });
    if (stepId.startsWith("diagnostic."))
      mutations.push({
        ...proof,
        observations: proof.observations.map((item, index) => (index ? item : { ...item, model: "wrong" })),
      });
    for (const mutation of mutations)
      assert.notDeepEqual(validateProducedPreReviewEvidence(stepId, mutation, context), []);
  }
});

test("wrong assignment, provider, model, role, and profile never enter observation generation", () => {
  for (const changed of [
    { assignmentId: "" },
    { provider: "claude_code" },
    { model: "wrong" },
    { role: "planner_b" },
    { runtimeProfile: "wrong" },
  ])
    assert.throws(
      () => generateRemainingConsensusObservations({ ...baseline, ...changed }),
      /exact orchestration state/,
    );
});
