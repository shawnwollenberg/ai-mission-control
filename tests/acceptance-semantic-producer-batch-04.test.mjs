import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import {
  preReviewProducerRegistrations,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "../lib/acceptance-pre-review-producers.ts";

const run = "00000000-0000-4000-8000-000000000044";
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
const missionId = uuid("1");
const childMissionId = uuid("2");
const assignmentA = uuid("3");
const assignmentB = uuid("4");
const canonicalPlanSha256 = hash("a");
const snapshotSha256 = hash("b");
const contextPackSha256 = hash("c");
const workflow = {
  missionId,
  childMissionId,
  repositoryId: "repository-1",
  repositorySnapshotSha256: snapshotSha256,
  contextPackSha256,
  missionLifecycleState: "awaiting_human_approval",
  proposals: [assignmentA, assignmentB].map((assignmentId, index) => ({
    artifactId: uuid(String(index + 5)),
    assignmentId,
    artifactSha256: hash(String(index + 1)),
    repositorySnapshotSha256: snapshotSha256,
  })),
  critiques: [assignmentA, assignmentB].map((assignmentId, index) => ({
    artifactId: uuid(String(index + 7)),
    assignmentId,
    contextPackSha256,
  })),
  revisions: [assignmentA, assignmentB].map((assignmentId, index) => ({
    artifactId: uuid(String(index + 7)),
    assignmentId,
    planIdentitySha256: canonicalPlanSha256,
  })),
  verdicts: [
    { decision: "approve", canonicalPlanSha256 },
    { decision: "approve", canonicalPlanSha256 },
  ],
  canonicalPlanArtifactId: uuid("9"),
  canonicalPlanSha256,
  synthesisAssignmentId: uuid("5"),
  approvalId: uuid("6"),
  approvedPlanSha256: canonicalPlanSha256,
  durableApprovalCount: 1,
  approvalActorId: uuid("7"),
  childApprovedPlanSha256: canonicalPlanSha256,
  childCreationCount: 1,
  executionId: uuid("8"),
  assignmentId: assignmentA,
  executorAgentId: uuid("9"),
  executorProvider: "codex",
  executorModel: "gpt-5.6-luna",
  claimedAgentId: uuid("9"),
  claimedProvider: "codex",
  claimedModel: "gpt-5.6-luna",
  leaseSequence: 3,
  fencingToken: 4,
  childLifecycleState: "succeeded",
  commitId: "d".repeat(40),
  patchSha256: hash("e"),
  validationReceiptSha256: hash("f"),
  implementationEvidenceArtifactId: "artifact:implementation-receipt",
  parentRepositoryAuthoritySha256: hash("1"),
  childRepositoryAuthoritySha256: hash("1"),
  learningArtifactId: "artifact:learning-candidate",
  learningDisposition: "proposed",
  curatedKnowledgeWriteCount: 0,
};
const adversarial = {
  credentialFreeArtifactPreflight: {
    artifactSha256: bindings.artifactSha256,
    exitCode: 0,
    stdoutSha256: hash("2"),
    credentialReferenceCount: 0,
  },
  changedModelAssignment: {
    assignmentRole: "planner_a",
    originalProvider: "claude_code",
    originalModel: "claude-fable-5",
    attemptedProvider: "claude_code",
    attemptedModel: "claude-fable-5-changed",
    rejectionCode: "disposable_model_assignment_mismatch",
    rejectedBeforeProviderInvocation: true,
    fallbackOccurred: false,
    durableStateBeforeSha256: hash("3"),
    durableStateAfterSha256: hash("3"),
  },
  malformedProposal: {
    artifactKind: "consensus_proposal",
    schemaVersion: "consensus-plan-proposal/1",
    mutationPath: "repository_snapshot",
    rejectionCode: "MALFORMED_CONSENSUS_PROPOSAL",
    providerInvocationCountBefore: 0,
    providerInvocationCountAfter: 0,
    durableStateBeforeSha256: hash("4"),
    durableStateAfterSha256: hash("4"),
  },
};
const sources = { packet: {}, registry: {}, preflight: {}, workflow, adversarial };
const context = { acceptanceRunId: run, candidateBindings: bindings, observedAt: "2026-08-07T00:00:00.000Z" };
const batch = preReviewProducerRegistrations.slice(60, 80);

test("batch 04 maps authoritative pre-review requirements 61 through 80 exactly", () => {
  const expected = contract.steps.filter((step) => step.lifecycle_phase === "pre_review").slice(60, 80);
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
  if (stepId === "workflow.mission_creation")
    return [{ ...proof, lifecycleState: "created" }, "repositorySnapshotSha256"];
  if (stepId === "workflow.proposal_rounds") return [{ ...proof, proposals: [] }, "proposals"];
  if (stepId === "workflow.canonical_synthesis")
    return [{ ...proof, canonicalPlanSha256: "wrong" }, "canonicalPlanArtifactId"];
  if (stepId === "workflow.human_approval") return [{ ...proof, durableApprovalCount: 2 }, "actorId"];
  if (stepId === "workflow.child_creation") return [{ ...proof, childApprovedPlanSha256: hash("9") }, "childMissionId"];
  if (stepId === "workflow.executor_claim") return [{ ...proof, provider: "" }, "assignmentId"];
  if (stepId === "workflow.child_success") return [{ ...proof, lifecycleState: "failed" }, "validationReceiptSha256"];
  if (stepId === "workflow.durable_evidence") return [{ ...proof, patchSha256: "wrong" }, "evidenceArtifactId"];
  if (stepId === "workflow.independent_proposals_same_snapshot")
    return [
      {
        ...proof,
        proposals: proof.proposals.map((item, index) =>
          index ? item : { ...item, repositorySnapshotSha256: hash("9") },
        ),
      },
      "expectedSnapshotSha256",
    ];
  if (stepId === "workflow.critiques_same_context")
    return [
      {
        ...proof,
        critiques: proof.critiques.map((item, index) => (index ? item : { ...item, contextPackSha256: hash("9") })),
      },
      "critiques",
    ];
  if (stepId === "workflow.revisions_same_plan_identity")
    return [
      {
        ...proof,
        revisions: proof.revisions.map((item, index) => (index ? item : { ...item, planIdentitySha256: hash("9") })),
      },
      "revisions",
    ];
  if (stepId === "workflow.canonical_verdict_exact_hash")
    return [{ ...proof, verdicts: [{ ...proof.verdicts[0], decision: "reject" }, proof.verdicts[1]] }, "verdicts"];
  if (stepId === "workflow.single_human_approval") return [{ ...proof, durableApprovalCount: 2 }, "approvalId"];
  if (stepId === "workflow.child_authority_inheritance")
    return [{ ...proof, childRepositoryAuthoritySha256: hash("9") }, "childRepositoryAuthoritySha256"];
  if (stepId === "workflow.executor_exact_assignment") return [{ ...proof, claimedModel: "changed" }, "claimedAgentId"];
  if (stepId === "workflow.durable_success_receipt")
    return [{ ...proof, validationReceiptSha256: "wrong" }, "receiptArtifactId"];
  if (stepId === "workflow.project_brain_learning_candidate_only")
    return [{ ...proof, disposition: "curated" }, "learningArtifactId"];
  if (stepId === "adversarial.credential_free_artifact_preflight")
    return [{ ...proof, credentialReferenceCount: 1 }, "stdoutSha256"];
  if (stepId === "adversarial.changed_model_rejected") return [{ ...proof, fallbackOccurred: true }, "rejectionCode"];
  return [{ ...proof, providerInvocationCountAfter: 1 }, "mutationPath"];
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
      validateProducedPreReviewEvidence(registration.stepId, { ...proof, candidateIdentitySha256: hash("9") }, context),
      [],
    );
    const otherStep = batch.find((item) => item.stepId !== registration.stepId).stepId;
    assert.notDeepEqual(validateProducedPreReviewEvidence(otherStep, proof, context), []);
  });
}

test("canonical verdict evidence accepts both domain-approved decisions and rejects terminal decisions", () => {
  const proof = producePreReviewEvidence("workflow.canonical_verdict_exact_hash", sources, context);
  const withNotes = {
    ...proof,
    verdicts: proof.verdicts.map((item) => ({ ...item, decision: "approve_with_non_blocking_notes" })),
  };
  assert.deepEqual(validateProducedPreReviewEvidence("workflow.canonical_verdict_exact_hash", withNotes, context), []);
  for (const decision of ["reject", "unknown"])
    assert.ok(
      validateProducedPreReviewEvidence(
        "workflow.canonical_verdict_exact_hash",
        { ...proof, verdicts: [{ ...proof.verdicts[0], decision }, proof.verdicts[1]] },
        context,
      ).includes("CANONICAL_VERDICT_BINDING_INVALID"),
    );
});

test("changed-model evidence rejects provider, model, and fallback substitutions", () => {
  const proof = producePreReviewEvidence("adversarial.changed_model_rejected", sources, context);
  for (const changed of [
    { ...proof, attemptedProvider: "codex" },
    { ...proof, attemptedModel: proof.originalModel },
    { ...proof, fallbackOccurred: true },
  ])
    assert.notDeepEqual(validateProducedPreReviewEvidence("adversarial.changed_model_rejected", changed, context), []);
});

test("broad workflow evidence and the next unmapped requirement remain fail-closed", () => {
  assert.notDeepEqual(validateProducedPreReviewEvidence("workflow.mission_creation", workflow, context), []);
  assert.throws(() => producePreReviewEvidence("semantic.unmapped_probe", sources, context), /unmapped/);
});
