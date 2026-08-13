import assert from "node:assert/strict";
import test from "node:test";

const { parseExecutionAuthorityPresentation, executionAuthorityPresentationIdentity } =
  await import("../domain/execution-authority-presentation.ts");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (c) => c.repeat(64);
const valid = {
  schemaVersion: "execution-authority-presentation/1",
  workspaceId: id(1),
  parentMissionId: id(2),
  childMissionId: id(3),
  assignmentId: id(4),
  assignmentAttempt: 1,
  providerAttemptId: "1-1",
  agentId: id(5),
  providerId: "codex",
  requestedModelId: "gpt-5.6-luna",
  runtimeProfileId: "codex-implementation-macos-v2",
  runtimeProfileHash: hash("a"),
  executableIdentitySha256: hash("b"),
  executableSha256: hash("c"),
  authenticationBindingSha256: hash("d"),
  capabilityAttestationId: id(6),
  capabilityAttestationHash: hash("e"),
  repositoryId: id(7),
  repositorySnapshotSha256: hash("f"),
  repositoryAuthoritySha256: hash("1"),
  contextSha256: hash("2"),
  canonicalPlanSha256: hash("3"),
  leaseReceiptId: id(8),
  leaseTokenFingerprint: hash("4"),
  leaseOwner: "mission-agent-owner",
  fencingToken: 2,
  operationIdentitySha256: hash("5"),
  resultAttemptIdentitySha256: hash("6"),
};

test("valid non-secret execution authority presentation canonicalizes deterministically", () => {
  assert.deepEqual(parseExecutionAuthorityPresentation(valid), valid);
  assert.equal(executionAuthorityPresentationIdentity({ ...valid }), executionAuthorityPresentationIdentity(valid));
});

test("schema, binding, fence, and secret mutations fail closed", () => {
  for (const changed of [
    { schemaVersion: "execution-authority-presentation/2" },
    { executableSha256: "bad" },
    { assignmentAttempt: 0 },
    { fencingToken: -1 },
    { rawLeaseToken: "mc_lease_forbidden_value_123456789" },
  ])
    assert.throws(() => parseExecutionAuthorityPresentation({ ...valid, ...changed }));
});

test("schema version and substantive authority changes alter canonical identity", () => {
  const base = executionAuthorityPresentationIdentity(valid);
  assert.notEqual(executionAuthorityPresentationIdentity({ ...valid, executableSha256: hash("7") }), base);
  assert.notEqual(
    executionAuthorityPresentationIdentity({ ...valid, schemaVersion: "execution-authority-presentation/2" }),
    base,
  );
});
