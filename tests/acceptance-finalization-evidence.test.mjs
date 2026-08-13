import assert from "node:assert/strict";
import test from "node:test";
import { validateCleanupEvidence, validateIndependentReviewEvidence } from "../lib/acceptance-finalization-evidence.ts";
import { canonicalHash } from "../lib/canonical-json.ts";

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
const expected = {
  acceptanceRunId: "00000000-0000-4000-8000-000000000010",
  candidateBindings: bindings,
  evidenceIndexSha256: "d".repeat(64),
};
const requirementRows = [
  {
    step_id: "workflow.preflight",
    requirement_id: "REQ-TEST",
    validatorId: "validate:workflow.preflight/1",
    validationResultIdentity: "a".repeat(64),
    evidenceArtifactId: "artifact:test",
    result: "passed",
  },
];
const deferredRequirementRow = {
  step_id: "diagnostic.exact_model_argument",
  requirement_id: "REQ-C04376FEDC746AF4",
  validatorId: "validate:diagnostic.exact_model_argument/1",
  validationResultIdentity: "b".repeat(64),
  evidenceArtifactId: "artifact:deferred",
  result: "deferred_to_authenticated_acceptance",
};
const review = {
  schemaVersion: "consensus-independent-review-evidence/2",
  ...expected,
  canonicalEventSetSha256: "e".repeat(64),
  checklistVersion: "consensus-acceptance-independent-review-checklist/1",
  reviewerImplementationIdentity: bindings.reviewerImplementationSha256,
  reviewChecklistSha256: bindings.reviewChecklistSha256,
  sourceCheckpointIdentity: "checkpoint-1",
  startedAt: "2026-08-05T00:00:00.000Z",
  completedAt: "2026-08-05T00:01:00.000Z",
  unresolvedHigh: 0,
  unresolvedMedium: 0,
  requirementLedgerComplete: true,
  requirementLedger: [
    {
      requirementId: "REQ-TEST",
      stepId: "workflow.preflight",
      validatorId: "validate:workflow.preflight/1",
      validationResultIdentity: "a".repeat(64),
      evidenceArtifactId: "artifact:test",
      result: "passed",
      reviewerDisposition: "accepted",
      finding: null,
    },
  ],
};
const cleanup = {
  schemaVersion: "consensus-acceptance-cleanup-evidence/2",
  ...expected,
  startedAt: "2026-08-05T00:01:00.000Z",
  completedAt: "2026-08-05T00:02:00.000Z",
  allRunResourcesAccounted: true,
  cleanupSucceeded: true,
  resourceInventory: {
    schemaVersion: "acceptance-resource-inventory/1",
    acceptanceRunId: expected.acceptanceRunId,
    resources: [
      {
        resourceId: "server",
        type: "mission_control_server",
        identity: { pid: 101 },
        expectedTerminalState: "stopped",
      },
      {
        resourceId: "temp",
        type: "temporary_directory",
        identity: { path: "/tmp/disposable-run" },
        expectedTerminalState: "deleted",
      },
    ],
    outcomes: [
      {
        resourceId: "server",
        acceptanceRunId: expected.acceptanceRunId,
        state: "stopped",
        observation: {
          resourceId: "server",
          resourceType: "mission_control_server",
          expectedTerminalState: "stopped",
          observedTerminalState: "stopped",
          cleanupAction: "stop",
          probeIdentity: "probe:server",
          cleanupStartedAt: "2026-08-05T00:01:00.000Z",
          cleanupCompletedAt: "2026-08-05T00:01:01.000Z",
        },
      },
      {
        resourceId: "temp",
        acceptanceRunId: expected.acceptanceRunId,
        state: "deleted",
        observation: {
          resourceId: "temp",
          resourceType: "temporary_directory",
          expectedTerminalState: "deleted",
          observedTerminalState: "deleted",
          cleanupAction: "delete",
          probeIdentity: "probe:temp",
          cleanupStartedAt: "2026-08-05T00:01:01.000Z",
          cleanupCompletedAt: "2026-08-05T00:01:02.000Z",
        },
      },
    ],
  },
};
for (const outcome of cleanup.resourceInventory.outcomes)
  outcome.cleanupEvidenceIdentity = canonicalHash(outcome.observation);
cleanup.resourceInventory.sha256 = canonicalHash(cleanup.resourceInventory);
expected.resourceInventory = { resources: cleanup.resourceInventory.resources };

test("review evidence is exact-run, exact-candidate, event-set, checklist, implementation, and evidence-index bound", () => {
  const reviewExpected = {
    ...expected,
    canonicalEventSetSha256: review.canonicalEventSetSha256,
    sourceCheckpointIdentity: "checkpoint-1",
    requirementRows,
  };
  assert.equal(validateIndependentReviewEvidence(review, reviewExpected), true);
  for (const changed of [
    { acceptanceRunId: "wrong" },
    { evidenceIndexSha256: "0".repeat(64) },
    { candidateBindings: { ...bindings, artifactSha256: "1".repeat(64) } },
    { canonicalEventSetSha256: "0".repeat(64) },
    { unresolvedHigh: 1 },
    { unresolvedMedium: 1 },
    { requirementLedgerComplete: false },
  ])
    assert.throws(() => validateIndependentReviewEvidence({ ...review, ...changed }, reviewExpected));
});

test("review evidence accepts only an exact authenticated-runtime deferral", () => {
  const deferredReview = {
    ...review,
    requirementLedger: [
      {
        requirementId: deferredRequirementRow.requirement_id,
        stepId: deferredRequirementRow.step_id,
        validatorId: deferredRequirementRow.validatorId,
        validationResultIdentity: deferredRequirementRow.validationResultIdentity,
        evidenceArtifactId: deferredRequirementRow.evidenceArtifactId,
        result: deferredRequirementRow.result,
        reviewerDisposition: "accepted",
        finding: null,
      },
    ],
  };
  const reviewExpected = {
    ...expected,
    canonicalEventSetSha256: review.canonicalEventSetSha256,
    sourceCheckpointIdentity: "checkpoint-1",
    requirementRows: [deferredRequirementRow],
  };
  assert.equal(validateIndependentReviewEvidence(deferredReview, reviewExpected), true);
  assert.throws(() =>
    validateIndependentReviewEvidence(
      {
        ...deferredReview,
        requirementLedger: [{ ...deferredReview.requirementLedger[0], stepId: "workflow.preflight" }],
      },
      { ...reviewExpected, requirementRows: [{ ...deferredRequirementRow, step_id: "workflow.preflight" }] },
    ),
  );
});

test("cleanup evidence accounts for every run resource and rejects partial cleanup across terminal paths", () => {
  assert.equal(validateCleanupEvidence(cleanup, expected), true);
  const terminalPaths = [
    "setup_failure",
    "planning_fail_stop",
    "cancellation",
    "timeout",
    "lease_loss",
    "server_crash",
    "provider_crash",
    "review_failure",
    "cleanup_retry",
  ];
  for (const terminalPath of terminalPaths) {
    assert.equal(validateCleanupEvidence({ ...cleanup, terminalPath }, expected), true);
    assert.throws(
      () =>
        validateCleanupEvidence(
          {
            ...cleanup,
            terminalPath,
            resourceInventory: { ...cleanup.resourceInventory, outcomes: cleanup.resourceInventory.outcomes.slice(1) },
          },
          expected,
        ),
      /identity changed|every run resource|reconciliation mismatch/,
    );
  }
  assert.throws(() => validateCleanupEvidence({ ...cleanup, acceptanceRunId: "wrong" }, expected), /binding/);
  assert.throws(
    () =>
      validateCleanupEvidence(
        { ...cleanup, candidateBindings: { ...bindings, artifactSha256: "1".repeat(64) } },
        expected,
      ),
    /candidate/,
  );
});
