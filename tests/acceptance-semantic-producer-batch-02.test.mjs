import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import {
  preReviewProducerRegistrations,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "../lib/acceptance-pre-review-producers.ts";

const run = "00000000-0000-4000-8000-000000000042";
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
const authorityHash = "a".repeat(64);
const proposedHash = "b".repeat(64);
const agentA = "11111111-1111-4111-8111-111111111111";
const agentB = "22222222-2222-4222-8222-222222222222";
const assignments = [
  ["planner_a", "claude_code", "claude-fable-5", "read"],
  ["planner_b", "codex", "gpt-5.6-sol", "read"],
  ["synthesizer", "claude_code", "claude-fable-5", "read"],
  ["executor", "codex", "gpt-5.6-luna", "isolated_worktree_write"],
].map(([role, provider, model, repositoryPermission]) => ({
  role,
  provider,
  model,
  repositoryPermission,
  pushAllowed: false,
  fallback: "disabled",
  agentId: agentA,
  capabilityAttestationId: "attestation-1",
}));
const sources = {
  packet: {},
  registry: {},
  preflight: {
    repositoryId: "repository-1",
    implementationReviewer: "disabled",
    noFallback: true,
    assignments,
    repository: {
      repositoryAuthorityHash: authorityHash,
      genericWriteAllowed: false,
      genericCommitAllowed: false,
      isolatedWorktreeWriteAllowed: true,
      missionAgentLocalCommitAllowed: true,
      providerDirectCommitAllowed: false,
      pushAllowed: false,
      pullRequestAllowed: false,
      publicationAllowed: false,
      deploymentAllowed: false,
      infrastructureMutationAllowed: false,
      authenticatedAuthorityReceipts: 1,
    },
  },
  repositoryAuthority: {
    projection: { repository_authority: { implementationAgentIds: [agentA] } },
    receipt: { command_id: "33333333-3333-4333-8333-333333333333" },
  },
  repositoryRuntime: {
    registeredPath: "/private/tmp/acceptance/repository",
    canonicalPath: "/private/tmp/acceptance/repository",
    pathIdentitySha256: "c".repeat(64),
    executorWorktreePath: "/private/tmp/acceptance/worktree",
    executorRepositoryPermission: "isolated_worktree_write",
    executorWorktreeGitCommonDir: "/private/tmp/acceptance/repository/.git",
    sourceGitCommonDir: "/private/tmp/acceptance/repository/.git",
    sourceHeadBefore: "d".repeat(40),
    sourceHeadAfter: "d".repeat(40),
    sourceTrackedStateBeforeSha256: "e".repeat(64),
    sourceTrackedStateAfterSha256: "e".repeat(64),
    authorityReplay: {
      firstAuthorityHash: authorityHash,
      replayedAuthorityHash: authorityHash,
      receiptCountBeforeReplay: 1,
      receiptCountAfterReplay: 1,
    },
    authorityDowngrade: {
      proposedAuthorityHash: proposedHash,
      proposedImplementationAgentIds: [agentB],
      matchingApprovalReceiptCount: 0,
    },
    authorityExpansion: {
      proposedAuthorityHash: proposedHash,
      proposedImplementationAgentIds: [agentA, agentB],
      matchingApprovalReceiptCount: 0,
    },
    childAuthorityHash: authorityHash,
    childImplementationAgentIds: [agentA],
    pushEnabledProbe: {
      mutatedField: "pushAllowed",
      mutatedValue: true,
      rejectionCode: "REPOSITORY_PROHIBITED_AUTHORITY",
    },
  },
};
const context = {
  acceptanceRunId: run,
  candidateBindings: bindings,
  observedAt: "2026-08-07T00:00:00.000Z",
};
const batch = preReviewProducerRegistrations.slice(20, 40);

test("batch 02 maps authoritative pre-review requirements 21 through 40 exactly", () => {
  const expected = contract.steps.filter((step) => step.lifecycle_phase === "pre_review").slice(20, 40);
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
  if (stepId === "models.implementation_reviewer_disabled") return [{ ...proof, actualMode: "enabled" }, "actualMode"];
  if (stepId === "models.fallback_disabled")
    return [
      {
        ...proof,
        assignments: proof.assignments.map((item, index) => (index ? item : { ...item, model: "changed-model" })),
      },
      "assignments",
    ];
  if (stepId === "repository.canonical_path") return [{ ...proof, registeredPath: "/wrong" }, "registeredPath"];
  if (stepId === "repository.isolated_executor_worktree")
    return [{ ...proof, repositoryPermission: "read" }, "worktreePath"];
  if (stepId === "repository.source_unchanged") return [{ ...proof, headAfter: "f".repeat(40) }, "headAfter"];
  if (stepId === "repository.planning_push_disabled")
    return [
      {
        ...proof,
        planningAssignments: proof.planningAssignments.map((item, index) =>
          index ? item : { ...item, pushAllowed: true },
        ),
      },
      "planningAssignments",
    ];
  if (
    [
      "repository.mission_agent_local_commit_allowed",
      "repository.provider_direct_commit_denied",
      "repository.push_denied",
      "repository.pull_request_denied",
      "repository.publication_denied",
      "repository.deployment_denied",
      "repository.infrastructure_denied",
    ].includes(stepId)
  )
    return [{ ...proof, actualValue: !proof.actualValue }, "actualValue"];
  if (stepId === "repository.generic_write_does_not_imply_push")
    return [{ ...proof, pushAllowed: true }, "pushAllowed"];
  if (stepId === "repository.authority_replay_idempotent")
    return [{ ...proof, replayedAuthorityHash: proposedHash }, "replayedAuthorityHash"];
  if (["repository.authority_downgrade_rejected", "repository.authority_expansion_requires_approval"].includes(stepId))
    return [{ ...proof, matchingApprovalReceiptCount: 1 }, "matchingApprovalReceiptCount"];
  if (stepId === "repository.child_authority_not_broadened")
    return [{ ...proof, childImplementationAgentIds: [agentA, agentB] }, "childImplementationAgentIds"];
  if (stepId === "repository.push_enabled_preflight_fails")
    return [{ ...proof, rejectionCode: "UNEXPECTED" }, "rejectionCode"];
  return [{ ...proof, authenticatedAuthorityReceipts: 0 }, "authenticatedAuthorityReceipts"];
}

for (const registration of batch) {
  test(`${registration.stepId} accepts substantive evidence and rejects mutations and missing fields`, () => {
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
      validateProducedPreReviewEvidence(
        registration.stepId,
        { ...proof, candidateIdentitySha256: "f".repeat(64) },
        context,
      ),
      [],
    );
    const otherStep = batch.find((item) => item.stepId !== registration.stepId).stepId;
    assert.notDeepEqual(validateProducedPreReviewEvidence(otherStep, proof, context), []);
  });
}

test("fallback mapping rejects provider, model, role, and fallback substitutions", () => {
  const proof = producePreReviewEvidence("models.fallback_disabled", sources, context);
  for (const field of ["provider", "model", "role", "fallback"]) {
    const assignments = proof.assignments.map((item, index) => (index ? item : { ...item, [field]: "changed" }));
    assert.notDeepEqual(
      validateProducedPreReviewEvidence("models.fallback_disabled", { ...proof, assignments }, context),
      [],
    );
  }
});

test("broad evidence and the next unmapped requirement remain fail-closed", () => {
  assert.notDeepEqual(
    validateProducedPreReviewEvidence("repository.push_disabled_preflight_passes", sources.preflight, context),
    [],
  );
  assert.throws(() => producePreReviewEvidence("semantic.unmapped_probe", sources, context), /unmapped/);
});
