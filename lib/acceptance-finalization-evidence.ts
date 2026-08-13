import { canonicalHash, canonicalJson } from "./canonical-json";
import type { AcceptanceCandidateBindings } from "./acceptance-requirement-evidence";
import { assertExactAcceptanceResourceReconciliation } from "./acceptance-resource-inventory";

const HASH = /^[a-f0-9]{64}$/;
export const AUTHENTICATED_RUNTIME_DEFERRED_STEP_IDS = new Set([
  "diagnostic.exact_model_argument",
  "diagnostic.runtime_identity_honesty",
  "diagnostic.process_tree_terminated",
  "diagnostic.secret_redaction",
]);
const validTimes = (value: Record<string, unknown>) =>
  Boolean(Date.parse(String(value.startedAt ?? ""))) &&
  Boolean(Date.parse(String(value.completedAt ?? ""))) &&
  String(value.completedAt) >= String(value.startedAt);
const exact = (left: unknown, right: unknown, label: string) => {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${label} binding changed`);
};

export function validateIndependentReviewEvidence(
  review: Record<string, unknown>,
  expected: {
    acceptanceRunId: string;
    candidateBindings: AcceptanceCandidateBindings;
    evidenceIndexSha256: string;
    canonicalEventSetSha256: string;
    sourceCheckpointIdentity: string;
    sourceCheckpointValidatedAt?: string;
    requirementRows: readonly Record<string, unknown>[];
  },
) {
  if (review.schemaVersion !== "consensus-independent-review-evidence/2" || !validTimes(review))
    throw new Error("Independent review schema or timestamps are invalid");
  if (
    review.acceptanceRunId !== expected.acceptanceRunId ||
    review.evidenceIndexSha256 !== expected.evidenceIndexSha256
  )
    throw new Error("Independent review run/evidence-index binding changed");
  exact(review.candidateBindings, expected.candidateBindings, "Independent review candidate");
  if (
    review.canonicalEventSetSha256 !== expected.canonicalEventSetSha256 ||
    !HASH.test(String(review.canonicalEventSetSha256))
  )
    throw new Error("Independent review canonical-event binding changed");
  if (
    review.checklistVersion !== "consensus-acceptance-independent-review-checklist/1" ||
    !HASH.test(String(review.reviewerImplementationIdentity))
  )
    throw new Error("Independent review implementation/checklist binding is invalid");
  if (review.unresolvedHigh !== 0 || review.unresolvedMedium !== 0 || review.requirementLedgerComplete !== true)
    throw new Error("Independent review has unresolved findings or incomplete ledger");
  if (
    review.reviewChecklistSha256 !== expected.candidateBindings.reviewChecklistSha256 ||
    review.reviewerImplementationIdentity !== expected.candidateBindings.reviewerImplementationSha256 ||
    review.sourceCheckpointIdentity !== expected.sourceCheckpointIdentity
  )
    throw new Error("Independent review checklist/implementation/checkpoint binding changed");
  if (expected.sourceCheckpointValidatedAt && String(review.startedAt) < expected.sourceCheckpointValidatedAt)
    throw new Error("Independent review predates its source checkpoint");
  const ledger = review.requirementLedger as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(ledger) || ledger.length !== expected.requirementRows.length)
    throw new Error("Independent review requirement ledger is incomplete");
  for (const row of expected.requirementRows) {
    const reviewed = ledger.find((item) => item.stepId === row.step_id);
    const resultIsAuthorized =
      reviewed?.result === "passed" ||
      (reviewed?.result === "deferred_to_authenticated_acceptance" &&
        AUTHENTICATED_RUNTIME_DEFERRED_STEP_IDS.has(String(row.step_id)));
    if (
      !reviewed ||
      reviewed.requirementId !== row.requirement_id ||
      reviewed.validatorId !== row.validatorId ||
      reviewed.validationResultIdentity !== row.validationResultIdentity ||
      reviewed.evidenceArtifactId !== row.evidenceArtifactId ||
      reviewed.result !== row.result ||
      !resultIsAuthorized ||
      reviewed.reviewerDisposition !== "accepted" ||
      reviewed.finding !== null
    )
      throw new Error(`Independent review requirement disposition changed: ${row.step_id}`);
  }
  return true;
}

export function validateCleanupEvidence(
  cleanup: Record<string, unknown>,
  expected: {
    acceptanceRunId: string;
    candidateBindings: AcceptanceCandidateBindings;
    evidenceIndexSha256: string;
    resourceInventory: Record<string, unknown>;
    sourceCheckpointValidatedAt?: string;
  },
) {
  if (cleanup.schemaVersion !== "consensus-acceptance-cleanup-evidence/2" || !validTimes(cleanup))
    throw new Error("Cleanup schema or timestamps are invalid");
  if (
    cleanup.acceptanceRunId !== expected.acceptanceRunId ||
    cleanup.evidenceIndexSha256 !== expected.evidenceIndexSha256
  )
    throw new Error("Cleanup run/evidence-index binding changed");
  exact(cleanup.candidateBindings, expected.candidateBindings, "Cleanup candidate");
  if (expected.sourceCheckpointValidatedAt && String(cleanup.startedAt) < expected.sourceCheckpointValidatedAt)
    throw new Error("Cleanup evidence predates its source checkpoint");
  const inventory = cleanup.resourceInventory as Record<string, unknown> | undefined;
  if (
    !inventory ||
    inventory.acceptanceRunId !== expected.acceptanceRunId ||
    inventory.schemaVersion !== "acceptance-resource-inventory/1"
  )
    throw new Error("Cleanup authoritative resource inventory is missing or cross-run");
  const expectedResources = expected.resourceInventory.resources as Array<Record<string, unknown>> | undefined;
  const resources = inventory.resources as Array<Record<string, unknown>> | undefined;
  const outcomes = inventory.outcomes as Array<Record<string, unknown>> | undefined;
  if (!expectedResources || !resources || !outcomes)
    throw new Error("Cleanup authoritative resource inventory is incomplete");
  assertExactAcceptanceResourceReconciliation(inventory);
  const { sha256: inventorySha256, ...inventoryBase } = inventory;
  if (inventorySha256 !== canonicalHash(inventoryBase))
    throw new Error("Cleanup authoritative resource inventory identity changed");
  exact(resources, expectedResources, "Cleanup authoritative resource registrations");
  if (
    outcomes.length !== resources.length ||
    new Set(outcomes.map((item) => item.resourceId)).size !== resources.length
  )
    throw new Error("Cleanup did not account for every run resource");
  for (const resource of resources) {
    const outcome = outcomes.find((item) => item.resourceId === resource.resourceId);
    if (
      !outcome ||
      outcome.acceptanceRunId !== expected.acceptanceRunId ||
      outcome.state !== resource.expectedTerminalState ||
      outcome.state === "cleanup_failed"
    )
      throw new Error(`Cleanup terminal evidence is invalid: ${resource.resourceId}`);
    const observation = outcome.observation as Record<string, unknown> | undefined;
    if (
      !observation ||
      observation.resourceId !== resource.resourceId ||
      observation.resourceType !== resource.type ||
      observation.expectedTerminalState !== resource.expectedTerminalState ||
      observation.observedTerminalState !== outcome.state ||
      !observation.cleanupAction ||
      !observation.probeIdentity ||
      !Date.parse(String(observation.cleanupStartedAt ?? "")) ||
      !Date.parse(String(observation.cleanupCompletedAt ?? "")) ||
      outcome.cleanupEvidenceIdentity !== canonicalHash(observation)
    )
      throw new Error(`Cleanup substantive terminal observation is invalid: ${resource.resourceId}`);
    if (
      outcome.state === "retained_with_approved_reason" &&
      (!outcome.retainedReason ||
        !resource.retentionPolicyIdentity ||
        outcome.retentionPolicyIdentity !== resource.retentionPolicyIdentity ||
        observation.retainedPathExistsAtCleanup !== true ||
        !/^[a-f0-9]{64}$/.test(String(observation.retainedArtifactSha256 ?? "")) ||
        !Number.isSafeInteger(observation.retainedArtifactSize) ||
        Number(observation.retainedArtifactSize) < 0 ||
        !Date.parse(String(observation.retainedArtifactCreatedAt ?? "")) ||
        !Date.parse(String(observation.retainedArtifactSealedAt ?? "")))
    )
      throw new Error(`Cleanup evidence retention policy is invalid: ${resource.resourceId}`);
  }
  if (cleanup.allRunResourcesAccounted !== true) throw new Error("Cleanup did not seal complete resource accounting");
  if (cleanup.cleanupSucceeded !== true) throw new Error("Cleanup retained an unresolved or surviving run resource");
  return true;
}
