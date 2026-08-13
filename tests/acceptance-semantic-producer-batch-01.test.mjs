import assert from "node:assert/strict";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json" with { type: "json" };
import {
  preReviewProducerRegistrations,
  producePreReviewEvidence,
  validateProducedPreReviewEvidence,
} from "../lib/acceptance-pre-review-producers.ts";

const run = "00000000-0000-4000-8000-000000000041";
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
const agents = ["codex", "claude_code"].map((provider, index) => ({
  provider,
  agentId: `agent-${index}`,
  artifactSha256: bindings.artifactSha256,
  registryHash: bindings.disposableRegistrySha256,
  authenticatedCredentialEvents: 1,
  authenticatedHeartbeatCurrent: true,
  capabilityAttestationId: `attestation-${index}`,
  capabilityAttestationHash: "a".repeat(64),
}));
const assignments = [
  ["planner_a", "claude_code", "claude-fable-5"],
  ["planner_b", "codex", "gpt-5.6-sol"],
  ["synthesizer", "claude_code", "claude-fable-5"],
  ["executor", "codex", "gpt-5.6-luna"],
].map(([role, provider, model], index) => ({
  role,
  provider,
  model,
  fallback: "disabled",
  agentId: `agent-${index % 2}`,
  capabilityAttestationId: `attestation-${index % 2}`,
  repositoryId: "repository-1",
}));
const sources = {
  packet: {
    registryContentHash: bindings.disposableRegistrySha256,
    approvedPacket: { acceptanceContractCanonicalSha256: bindings.acceptanceContractSha256 },
    observed: {
      sha256: bindings.artifactSha256,
      artifactMetadataSha256: bindings.artifactMetadataSha256,
      capabilityManifestSha256: bindings.capabilityManifestSha256,
      acceptanceSourceManifestCanonicalSha256: bindings.acceptanceSourceManifestSha256,
      acceptanceContractCanonicalSha256: bindings.acceptanceContractSha256,
    },
  },
  registry: {
    valid_from: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
    scope: "consensus_real_provider_acceptance",
  },
  preflight: {
    repositoryId: "repository-1",
    agents,
    assignments,
    repository: {
      authenticatedRegistrations: 2,
      identityVersion: "stable-v2",
      fingerprint: "fingerprint",
      snapshotArtifactId: "snapshot-artifact",
      snapshotHash: bindings.repositorySnapshotSha256,
      stateHash: "b".repeat(64),
      projectBrainContextBound: true,
    },
  },
};
const context = { acceptanceRunId: run, candidateBindings: bindings, observedAt: "2026-08-07T00:00:00.000Z" };
const batch = preReviewProducerRegistrations.slice(0, 20);

test("batch 01 maps the first twenty authoritative pre-review requirements exactly", () => {
  const expected = contract.steps.filter((s) => s.lifecycle_phase === "pre_review").slice(0, 20);
  assert.deepEqual(
    batch.map((r) => r.stepId),
    expected.map((s) => s.step_id),
  );
  assert.deepEqual(
    batch.map((r) => r.validatorId),
    expected.map((s) => s.validator_id),
  );
  assert.equal(new Set(batch.map((r) => r.producerId)).size, 20);
  assert.equal(new Set(batch.map((r) => r.schemaId)).size, 20);
});

for (const registration of batch)
  test(`${registration.stepId} accepts exact evidence and rejects substantive mutation`, () => {
    const proof = producePreReviewEvidence(registration.stepId, sources, context);
    assert.deepEqual(validateProducedPreReviewEvidence(registration.stepId, proof, context), []);
    const changed = { ...proof };
    let missingField;
    if ("actualSha256" in changed) {
      changed.actualSha256 = "f".repeat(64);
      missingField = "actualSha256";
    } else if (registration.stepId === "registry.validity_window") {
      changed.expiresAt = "2026-08-06T00:00:00.000Z";
      missingField = "expiresAt";
    } else if (registration.stepId.startsWith("agent.")) {
      if (registration.stepId === "agent.capability_attestation_exact") {
        changed.agents = [];
        missingField = "agents";
      } else {
        changed.authenticatedCredentialEvents = 0;
        missingField = "authenticatedCredentialEvents";
      }
    } else if (registration.stepId === "repository.authenticated_registration") {
      changed.authenticatedRegistrations = 0;
      missingField = "authenticatedRegistrations";
    } else if (registration.stepId === "repository.same_identity") {
      changed.assignmentRepositoryIds = ["wrong"];
      missingField = "assignmentRepositoryIds";
    } else if (registration.stepId === "repository.same_snapshot") {
      changed.locallyRecomputedSha256 = "f".repeat(64);
      missingField = "locallyRecomputedSha256";
    } else if (registration.stepId.startsWith("project_brain.")) {
      changed.contextBound = false;
      missingField = "contextBound";
    } else {
      changed.model = "wrong-model";
      missingField = "model";
    }
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

test("unmapped and broad evidence fail without a fallback", () => {
  assert.throws(() => producePreReviewEvidence("semantic.unmapped_probe", sources, context), /unmapped/);
  assert.notDeepEqual(validateProducedPreReviewEvidence("packet.artifact", sources.packet, context), []);
});

test("model mappings reject wrong provider, role, fallback, and missing substantive fields", () => {
  const proof = producePreReviewEvidence("models.planner_a_claude_fable_5", sources, context);
  for (const changed of [
    { ...proof, provider: "codex" },
    { ...proof, role: "planner_b" },
    { ...proof, fallback: "enabled" },
    { ...proof, agentId: undefined },
  ])
    assert.notDeepEqual(validateProducedPreReviewEvidence("models.planner_a_claude_fable_5", changed, context), []);
});
