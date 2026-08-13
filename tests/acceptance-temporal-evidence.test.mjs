import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import { producePreReviewEvidence, validateProducedPreReviewEvidence } from "../lib/acceptance-pre-review-producers.ts";

const restartIds = ["recovery.provider_restart", "recovery.mission_control_restart"];

test("pre-review restart schemas contain no future cleanup conclusions", () => {
  for (const id of restartIds) {
    const row = contract.steps.find((step) => step.step_id === id);
    assert.equal(row.lifecycle_phase, "pre_review");
    assert.match(row.evidence_schema, id === "recovery.provider_restart" ? /\/4$/ : /\/3$/);
    assert.doesNotMatch(JSON.stringify(row), /final.cleanup|resource.reconciliation|cleanup.proof/i);
  }
  assert.equal(contract.steps.filter((step) => step.lifecycle_phase === "cleanup").length, 5);
  assert.equal(contract.steps.length, 123);
});

test("cleanup evidence cannot substitute for missing restart and resume evidence", () => {
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
    ].map((key) => [key, "a".repeat(64)]),
  );
  const context = {
    acceptanceRunId: "00000000-0000-4000-8000-000000000001",
    candidateBindings: bindings,
    observedAt: new Date().toISOString(),
  };
  for (const id of restartIds) {
    const proof = producePreReviewEvidence(
      id,
      {
        packet: {},
        registry: {},
        preflight: {},
        recovery: {
          providerRestart: { cleanupResourceIds: ["p1", "p2"] },
          missionControlRestart: { cleanupResourceIds: ["s1", "s2", "l1", "l2"] },
        },
      },
      context,
    );
    assert.notDeepEqual(validateProducedPreReviewEvidence(id, proof, context), []);
  }
});
