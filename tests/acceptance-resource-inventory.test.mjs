import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceResourceInventory, acceptanceResourceTypes } from "../lib/acceptance-resource-inventory.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../lib/canonical-json.ts";

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
const run = "00000000-0000-4000-8000-000000000020";
const now = "2026-08-07T00:00:00.000Z";
const retentionPolicyIdentity = "e".repeat(64);
const { repositorySnapshotSha256, ...preSnapshotBindings } = bindings;
const inventoryForTest = () => {
  const inventory = new AcceptanceResourceInventory(run, preSnapshotBindings, "a".repeat(64), now);
  inventory.bindRepositorySnapshot(repositorySnapshotSha256);
  return inventory;
};
const resource = (resourceId, type = "temporary_directory", expectedTerminalState = "deleted") => ({
  resourceId,
  type,
  identity: { path: `/tmp/${resourceId}` },
  creatingStep: "workflow.preflight",
  createdAt: now,
  cleanupPolicy: "delete",
  expectedTerminalState,
});
const outcome = (value, record) => {
  const observation = {
    resourceId: value.resourceId,
    resourceType: record.type,
    expectedTerminalState: record.expectedTerminalState,
    observedTerminalState: value.state,
    cleanupAction: record.cleanupPolicy,
    probeIdentity: `probe:${record.resourceId}`,
    cleanupStartedAt: now,
    cleanupCompletedAt: now,
    ...value.observation,
  };
  return {
    ...value,
    observation,
    cleanupEvidenceIdentity: createHash("sha256").update(canonicalJson(observation)).digest("hex"),
  };
};

test("resource inventory covers every declared category and seals only exact registered outcomes", () => {
  assert.equal(new Set(acceptanceResourceTypes).size, 24);
  const inventory = inventoryForTest();
  const temp = resource("temp-1");
  inventory.register(temp);
  inventory.recordOutcome(
    outcome(
      {
        resourceId: "temp-1",
        acceptanceRunId: run,
        state: "deleted",
        completedAt: now,
        observation: { exists: false },
      },
      temp,
    ),
  );
  const sealed = inventory.sealForSuccess();
  assert.equal(sealed.resources.length, 1);
  assert.equal(sealed.outcomes.length, 1);
  assert.match(sealed.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => inventory.register(resource("late")), /sealed/);
});

test("cleanup cannot omit, invent, reuse, cross-run, retain, or misstate a resource", () => {
  const inventory = inventoryForTest();
  const temp = resource("temp-1");
  inventory.register(temp);
  assert.throws(() => inventory.register(temp), /already registered/);
  assert.throws(
    () =>
      inventory.recordOutcome(
        outcome(
          { resourceId: "unknown", acceptanceRunId: run, state: "deleted", completedAt: now, observation: {} },
          temp,
        ),
      ),
    /binding/,
  );
  assert.throws(
    () =>
      inventory.recordOutcome(
        outcome(
          { resourceId: "temp-1", acceptanceRunId: "wrong", state: "deleted", completedAt: now, observation: {} },
          temp,
        ),
      ),
    /binding/,
  );
  assert.throws(() => inventory.sealForSuccess(), /missing/);
  inventory.recordOutcome(
    outcome(
      {
        resourceId: "temp-1",
        acceptanceRunId: run,
        state: "cleanup_failed",
        completedAt: now,
        observation: { exists: true },
      },
      temp,
    ),
  );
  assert.throws(() => inventory.sealForSuccess(), /terminal state/);
});

test("retention requires a predeclared policy, matching terminal state, and approved reason", () => {
  const inventory = inventoryForTest();
  const evidence = {
    ...resource("evidence", "evidence_directory", "retained_with_approved_reason"),
    cleanupPolicy: "retain_evidence_only",
    retentionPolicyIdentity,
  };
  inventory.register(evidence);
  assert.throws(
    () =>
      inventory.recordOutcome(
        outcome(
          {
            resourceId: "evidence",
            acceptanceRunId: run,
            state: "retained_with_approved_reason",
            completedAt: now,
            observation: {},
          },
          evidence,
        ),
      ),
    /reason/,
  );
  inventory.recordOutcome(
    outcome(
      {
        resourceId: "evidence",
        acceptanceRunId: run,
        state: "retained_with_approved_reason",
        retainedReason: "approved local acceptance evidence",
        retentionPolicyIdentity,
        completedAt: now,
        observation: { bounded: true },
      },
      evidence,
    ),
  );
  assert.equal(inventory.sealForSuccess().outcomes[0].state, "retained_with_approved_reason");
});
