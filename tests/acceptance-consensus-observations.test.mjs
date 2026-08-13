import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSENSUS_OBSERVATION_DEFINITIONS,
  generateConsensusOrchestrationObservations,
} from "../lib/acceptance-consensus-observations.ts";
import { producePreReviewEvidence, validateProducedPreReviewEvidence } from "../lib/acceptance-pre-review-producers.ts";

const hash = (character) => character.repeat(64);
const run = "00000000-0000-4000-8000-000000000092";
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
  ].map((key, index) => [key, String(index % 10).repeat(64)]),
);
const artifact = (artifactKind, schemaVersion, digit, role = "planner_a") => ({
  artifactKind,
  schemaVersion,
  artifactId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
  artifactSha256: hash(digit),
  assignmentId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-9${digit.repeat(3)}-${digit.repeat(12)}`,
  provider: role === "planner_b" ? "codex" : "claude_code",
  model: role === "planner_b" ? "gpt-5.6-sol" : "claude-fable-5",
  role,
  runtimeProfile: role === "planner_b" ? "codex-planning-macos-v2" : "claude-planning-macos-v2",
});
const baseline = {
  acceptanceRunId: run,
  candidateIdentitySha256: hash("a"),
  missionId: "11111111-1111-4111-8111-111111111111",
  assignmentId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  provider: "codex",
  model: "gpt-5.6-luna",
  role: "executor",
  runtimeProfile: "codex-implementation-macos-v2",
  expectedProvider: "codex",
  expectedModel: "gpt-5.6-luna",
  expectedRole: "executor",
  expectedRuntimeProfile: "codex-implementation-macos-v2",
  repositorySnapshotSha256: hash("b"),
  repositoryAuthoritySha256: hash("c"),
  contextPackSha256: hash("d"),
  consensusState: "awaiting_human_approval",
  providerInvocationCount: 10,
  durableStateSha256: hash("e"),
  artifacts: {
    proposal: artifact("consensus_proposal", "consensus-plan-proposal/1", "1", "planner_a"),
    critique: artifact("consensus_critique", "consensus-plan-critique/1", "2", "planner_b"),
    revision: artifact("consensus_revision", "consensus-plan-revision/1", "3", "planner_a"),
    synthesis: artifact("canonical_implementation_plan", "canonical-implementation-plan/1", "4", "synthesizer"),
    verdict: artifact("canonical_plan_verdict", "canonical-plan-verdict/1", "5", "planner_b"),
  },
};
const context = { acceptanceRunId: run, candidateBindings, observedAt: "2026-08-08T19:00:00.000Z" };

const sourceFor = (observations) => ({
  authorityChecks: [observations.cancelledAssignmentClaim],
  adversarial: {
    malformedProposal: observations.malformedProposal,
    malformedCritique: observations.malformedCritique,
    malformedRevision: observations.malformedRevision,
    malformedSynthesis: observations.malformedSynthesis,
    malformedVerdict: observations.malformedVerdict,
    wrongConsensusState: observations.wrongConsensusState,
    wrongRepositorySnapshot: observations.wrongRepositorySnapshot,
    wrongContextPack: observations.wrongContextPack,
    wrongArtifactHash: observations.wrongArtifactHash,
  },
});

test("the next ten observations are generated in authoritative order from narrow runtime bindings", () => {
  const observations = generateConsensusOrchestrationObservations(baseline);
  assert.equal(CONSENSUS_OBSERVATION_DEFINITIONS.length, 10);
  assert.equal(observations.malformedProposal.provider, "claude_code");
  assert.equal(observations.malformedCritique.provider, "codex");
  assert.equal(observations.malformedProposal.assignmentId, baseline.artifacts.proposal.assignmentId);
  assert.equal(observations.cancelledAssignmentClaim.attemptId, baseline.attemptId);
});

test("all ten requirement-specific producers accept the generated observations", () => {
  const observations = generateConsensusOrchestrationObservations(baseline);
  const sources = sourceFor(observations);
  for (const [stepId] of CONSENSUS_OBSERVATION_DEFINITIONS) {
    const proof = producePreReviewEvidence(stepId, sources, context);
    assert.deepEqual(validateProducedPreReviewEvidence(stepId, proof, context), []);
    assert.doesNotMatch(JSON.stringify(proof), /undefined/);
  }
});

test("substantive values, rejection codes, durable state, run, and candidate mutations fail closed", () => {
  const sources = sourceFor(generateConsensusOrchestrationObservations(baseline));
  for (const [stepId] of CONSENSUS_OBSERVATION_DEFINITIONS) {
    const proof = producePreReviewEvidence(stepId, sources, context);
    const substantiveMutation = stepId.startsWith("authority.")
      ? { attemptedBindingSha256: proof.approvedBindingSha256 }
      : stepId === "adversarial.malformed_proposal_rejected"
        ? { mutationPath: "" }
        : { attemptedValueSha256: proof.approvedValueSha256 };
    for (const changed of [
      { ...proof, rejectionCode: "CHANGED" },
      { ...proof, durableStateAfterSha256: hash("f") },
      { ...proof, ...substantiveMutation },
      { ...proof, acceptanceRunId: "wrong" },
      { ...proof, candidateIdentitySha256: hash("9") },
    ])
      assert.notDeepEqual(validateProducedPreReviewEvidence(stepId, changed, context), []);
  }
});

test("missing and substituted assignment/provider/model/profile bindings are rejected at observation input", () => {
  for (const changed of [
    { ...baseline, assignmentId: "" },
    { ...baseline, provider: "claude_code" },
    { ...baseline, model: "gpt-5.6-sol" },
    { ...baseline, role: "planner_b" },
    { ...baseline, runtimeProfile: "codex-planning-macos-v2" },
  ])
    assert.throws(() => generateConsensusOrchestrationObservations(changed), /not bound to exact orchestration state/);
});
