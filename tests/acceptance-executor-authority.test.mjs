import assert from "node:assert/strict";
import test from "node:test";

const { loadPersistedExecutorAuthorityBinding } = await import("../lib/acceptance-executor-authority.ts");
const { executionAuthorityPresentationIdentity } = await import("../domain/execution-authority-presentation.ts");

const sha = "a".repeat(64);
const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  parent: "00000000-0000-4000-8000-000000000002",
  child: "00000000-0000-4000-8000-000000000003",
  assignment: "00000000-0000-4000-8000-000000000004",
  execution: "00000000-0000-4000-8000-000000000005",
  agent: "00000000-0000-4000-8000-000000000006",
  capability: "00000000-0000-4000-8000-000000000007",
  repository: "00000000-0000-4000-8000-000000000008",
  lease: "00000000-0000-4000-8000-000000000009",
};
const presentation = {
  schemaVersion: "execution-authority-presentation/1",
  workspaceId: ids.workspace,
  parentMissionId: ids.parent,
  childMissionId: ids.child,
  assignmentId: ids.assignment,
  assignmentAttempt: 1,
  providerAttemptId: "1-1",
  agentId: ids.agent,
  providerId: "codex",
  requestedModelId: "gpt-5.6-luna",
  runtimeProfileId: "codex-implementation-macos-v2",
  runtimeProfileHash: sha,
  executableIdentitySha256: sha,
  executableSha256: sha,
  authenticationBindingSha256: sha,
  capabilityAttestationId: ids.capability,
  capabilityAttestationHash: sha,
  repositoryId: ids.repository,
  repositorySnapshotSha256: sha,
  repositoryAuthoritySha256: sha,
  contextSha256: sha,
  canonicalPlanSha256: sha,
  leaseReceiptId: ids.lease,
  leaseTokenFingerprint: sha,
  leaseOwner: "lease-owner-1",
  fencingToken: 3,
  operationIdentitySha256: sha,
  resultAttemptIdentitySha256: sha,
};
const row = {
  assignment_id: ids.assignment,
  execution_id: ids.execution,
  assignment_attempt: "1",
  assignment_agent_id: ids.agent,
  assignment_lease_owner: "lease-owner-1",
  assignment_fencing_token: "3",
  validation_receipt_id: "receipt-1",
  receipt_attempt: 1,
  receipt_agent_id: ids.agent,
  receipt_lease_owner: "lease-owner-1",
  receipt_fencing_token: "3",
  receipt_provider_id: "codex",
  receipt_model_id: "gpt-5.6-luna",
  receipt_capability_attestation_id: ids.capability,
  receipt_capability_attestation_hash: sha,
  receipt_hash: sha,
  provenance_message_id: "message-1",
  diagnostic_provenance_message_id: "message-1",
  provider_attempt_id: "1-1",
  diagnostic_provider_id: "codex",
  diagnostic_requested_model_id: "gpt-5.6-luna",
  diagnostic_runtime_profile_id: "codex-implementation-macos-v2",
  diagnostic_runtime_profile_hash: sha,
  diagnostic_id: "diagnostic-1",
  diagnostic_assignment_id: ids.assignment,
  diagnostic_attempt: 1,
  diagnostic_agent_id: ids.agent,
  diagnostic_lease_owner: "lease-owner-1",
  diagnostic_fencing_token: "3",
  execution_authority_presentation: presentation,
  execution_authority_presentation_sha256: executionAuthorityPresentationIdentity(presentation),
};
const input = {
  workspaceId: ids.workspace,
  executionId: ids.execution,
  assignmentId: ids.assignment,
  agentId: ids.agent,
};
const database = (value) => ({ query: async () => ({ rows: value ? [value] : [] }) });

test("terminal executor authority is derived from matching assignment, immutable receipt, and diagnostic", async () => {
  const binding = await loadPersistedExecutorAuthorityBinding(database(row), input);
  assert.equal(binding.fencingToken, 3);
  assert.equal(binding.attempt, 1);
  assert.equal(binding.validationReceiptSha256, sha);
});

test("terminal projection replay retains the same immutable historical fencing binding", async () => {
  const before = await loadPersistedExecutorAuthorityBinding(database(row), input);
  const after = await loadPersistedExecutorAuthorityBinding(database({ ...row }), input);
  assert.deepEqual(after, before);
});

test("wrong, stale, zero, and missing persisted fencing sources fail closed", async () => {
  for (const changed of [
    { receipt_fencing_token: "2" },
    { diagnostic_fencing_token: "2" },
    { assignment_fencing_token: "0", receipt_fencing_token: "0", diagnostic_fencing_token: "0" },
    { assignment_lease_owner: null },
  ])
    await assert.rejects(
      loadPersistedExecutorAuthorityBinding(database({ ...row, ...changed }), input),
      /inconsistent or incomplete/,
    );
  await assert.rejects(loadPersistedExecutorAuthorityBinding(database(null), input), /unavailable/);
});

test("wrong assignment, execution, attempt, agent, lease owner, and receipt hash fail closed", async () => {
  for (const changed of [
    { diagnostic_assignment_id: "assignment-other" },
    { execution_id: "execution-other" },
    { receipt_attempt: 2 },
    { receipt_agent_id: "agent-other" },
    { diagnostic_lease_owner: "lease-owner-other" },
    { diagnostic_provenance_message_id: "message-other" },
    { diagnostic_provider_id: "claude_code" },
    { diagnostic_requested_model_id: "model-other" },
    { diagnostic_runtime_profile_hash: "b".repeat(64) },
    { receipt_capability_attestation_hash: "b".repeat(64) },
    { receipt_hash: "not-a-hash" },
  ])
    await assert.rejects(
      loadPersistedExecutorAuthorityBinding(database({ ...row, ...changed }), input),
      /inconsistent or incomplete/,
    );
});
