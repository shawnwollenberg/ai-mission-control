import { canonicalHash } from "./canonical-json";
import { getDatabasePool } from "./database";
import { parseExecutionAuthorityPresentation } from "../domain/execution-authority-presentation";
import { ACTIVE_PRESENTATION_ROUTE_IDENTITY } from "../application/acceptance-authority-presentation-observations";

export const presentationAuthorityScenarios = [
  ["authority.changed_executable_rejected", "executable_identity", "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED"],
  ["authority.changed_runtime_profile_rejected", "runtime_profile", "ASSIGNMENT_RUNTIME_PROFILE_CHANGED"],
  [
    "authority.changed_authentication_binding_rejected",
    "authentication_binding",
    "ASSIGNMENT_AUTHENTICATION_BINDING_CHANGED",
  ],
  [
    "authority.changed_repository_authority_rejected",
    "repository_authority",
    "ASSIGNMENT_REPOSITORY_AUTHORITY_CHANGED",
  ],
  [
    "authority.expired_capability_attestation_rejected",
    "capability_attestation_expiry",
    "CAPABILITY_ATTESTATION_EXPIRED",
  ],
  ["authority.stale_lease_rejected", "lease_sequence", "ASSIGNMENT_LEASE_STALE"],
  ["authority.stale_fencing_token_rejected", "fencing_token", "ASSIGNMENT_FENCING_TOKEN_STALE"],
  ["authority.stale_provider_attempt_rejected", "provider_attempt", "ATTEMPT_BINDING_MISMATCH"],
] as const;

export async function executePresentationAuthorityScenarios(input: {
  executionId: string;
  assignmentId: string;
  workspaceId: string;
  providerAttemptId: string;
}) {
  const rows = (
    await getDatabasePool().query(
      `SELECT o.*,l.repository_state_before_sha256 local_repository_state_before_sha256,
              l.repository_state_after_sha256 local_repository_state_after_sha256,
              l.repository_head_before,l.repository_head_after,
              l.repository_status_before_sha256,l.repository_status_after_sha256
         FROM acceptance_authority_presentation_observations o
         JOIN acceptance_authority_local_state_observations l USING(workspace_id,execution_id,assignment_id,agent_id,requirement_id)
      WHERE o.workspace_id=$1 AND o.execution_id=$2 AND o.assignment_id=$3 ORDER BY o.recorded_at`,
      [input.workspaceId, input.executionId, input.assignmentId],
    )
  ).rows;
  const observedScenarios = presentationAuthorityScenarios.filter(([requirement]) =>
    rows.some((row) => row.requirement_id === requirement),
  );
  const baselineScenarios = presentationAuthorityScenarios.filter(
    ([requirement]) => requirement !== "authority.stale_provider_attempt_rejected",
  );
  if (
    baselineScenarios.some(([requirement]) => !rows.some((row) => row.requirement_id === requirement)) ||
    rows.length !== observedScenarios.length
  )
    throw new Error(`Active execution-authority observation count changed: ${rows.length}`);
  return observedScenarios.map(([requirement, mutationKind, expectedReason]) => {
    const row = rows.find((item) => item.requirement_id === requirement);
    if (!row || row.mutation_kind !== mutationKind || row.reason_code !== expectedReason)
      throw new Error(`Active execution-authority observation is missing or changed: ${requirement}`);
    const baseline = parseExecutionAuthorityPresentation(row.baseline_presentation);
    const attempted = parseExecutionAuthorityPresentation(row.attempted_presentation);
    const changed = Object.keys(baseline).filter(
      (key) =>
        canonicalHash(baseline[key as keyof typeof baseline]) !==
        canonicalHash(attempted[key as keyof typeof attempted]),
    );
    const before = row.durable_counts_before as Record<string, unknown>;
    const after = row.durable_counts_after as Record<string, unknown>;
    const providerAttemptBindingValid =
      requirement === "authority.stale_provider_attempt_rejected"
        ? baseline.providerAttemptId === input.providerAttemptId &&
          attempted.providerAttemptId !== input.providerAttemptId
        : attempted.providerAttemptId === input.providerAttemptId;
    if (
      row.route_identity !== ACTIVE_PRESENTATION_ROUTE_IDENTITY ||
      row.assignment_status !== "acknowledged" ||
      new Date(row.lease_expires_at).getTime() <= new Date(row.recorded_at).getTime() ||
      !row.lease_receipt_id ||
      !/^[a-f0-9]{64}$/.test(row.lease_token_fingerprint) ||
      Number(row.fencing_token) < 1 ||
      row.baseline_valid !== true ||
      !providerAttemptBindingValid ||
      changed.length !== 1 ||
      canonicalHash(before) !== canonicalHash(after) ||
      !Array.isArray(after.validation_receipt_identities) ||
      after.validation_receipt_identities.length !== 0 ||
      row.local_repository_state_before_sha256 !== row.local_repository_state_after_sha256 ||
      row.repository_head_before !== row.repository_head_after ||
      row.repository_status_before_sha256 !== row.repository_status_after_sha256
    )
      throw new Error(`Active execution-authority observation failed semantic validation: ${requirement}`);
    return {
      requirement,
      mutationKind,
      scenarioId: row.scenario_id,
      assignmentId: row.assignment_id,
      attemptId: row.execution_id,
      providerAttemptId: attempted.providerAttemptId,
      approvedBindingSha256: row.baseline_presentation_sha256,
      attemptedBindingSha256: row.attempted_presentation_sha256,
      mutatedField: changed[0],
      rejectionCode: row.reason_code,
      topLevelCode: row.top_level_code,
      durableStateBeforeSha256: row.durable_state_before_sha256,
      durableStateAfterSha256: row.durable_state_after_sha256,
      durableCountsBefore: before,
      durableCountsAfter: after,
      assignmentStateAtSubmission: row.assignment_status,
      leaseReceiptId: row.lease_receipt_id,
      leaseTokenFingerprint: row.lease_token_fingerprint,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      leaseSequence: attempted.assignmentAttempt,
      fencingToken: Number(row.fencing_token),
      governedOperationIdentity: attempted.operationIdentitySha256,
      routeIdentity: row.route_identity,
      baselineValid: true,
    };
  });
}
