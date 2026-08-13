import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import type { AcceptanceCandidateBindings } from "./acceptance-requirement-evidence";
import { preReviewProducerByStep, validateProducedPreReviewEvidence } from "./acceptance-pre-review-producers";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const forbidden = new Set(["satisfied", "passed", "success", "result", "status", "prevalidated", "suiteSuccess"]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const at = (value: unknown, path: string) =>
  path.split(".").reduce<unknown>((current, key) => object(current)?.[key], value);
const containsForbidden = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsForbidden);
  const record = object(value);
  return record
    ? Object.entries(record).some(([key, nested]) => forbidden.has(key) || containsForbidden(nested))
    : false;
};
const exact = (actual: unknown, expected: unknown) => canonicalJson(actual) === canonicalJson(expected);
const nonempty = (value: unknown) =>
  typeof value === "string"
    ? value.length > 0
    : Array.isArray(value)
      ? value.length > 0
      : Boolean(object(value) && Object.keys(object(value)!).length);

export function validateSemanticRequirement(args: {
  stepId: string;
  acceptanceRunId: string;
  observation: unknown;
  details: unknown;
  candidateBindings: AcceptanceCandidateBindings;
  provider: string | null;
  model: string | null;
  role: string | null;
  profile: string | null;
}) {
  const reasons: string[] = [];
  const observation = object(args.observation);
  if (!observation || containsForbidden(observation)) return ["HARNESS_AUTHORED_SATISFACTION_FIELD"];
  if (
    observation.stepId !== args.stepId ||
    !UUID.test(String(observation.attemptId ?? "")) ||
    !HASH.test(String(observation.sourceEvidenceSha256 ?? ""))
  )
    return ["OBSERVATION_BINDING_INVALID"];
  if (observation.sourceEvidenceSha256 !== createEvidenceHash(args.details))
    reasons.push("OBSERVATION_SOURCE_HASH_MISMATCH");
  const details = object(args.details);
  if (!details) return [...reasons, "OBSERVATION_DETAILS_MALFORMED"];

  const fail = (condition: boolean, reason: string) => {
    if (!condition) reasons.push(reason);
  };
  const step = args.stepId;
  if (preReviewProducerByStep.has(step)) {
    reasons.push(
      ...validateProducedPreReviewEvidence(step, details, {
        acceptanceRunId: args.acceptanceRunId,
        candidateBindings: args.candidateBindings,
      }),
    );
  } else if (step.startsWith("source.")) {
    fail(
      details.checkpoint === step.slice("source.".length) &&
        details.result === "pass" &&
        ["missing_files", "unexpected_files", "changed_files", "invalid_file_types"].every(
          (key) => Array.isArray(details[key]) && (details[key] as unknown[]).length === 0,
        ),
      "SOURCE_CHECKPOINT_INVARIANT_FAILED",
    );
  } else if (step === "secrets.exact_credential_scan") {
    fail(
      exact(details.secretScan, { durableMatches: 0, artifactFileMatches: 0, providerLogMatches: 0 }),
      "EXACT_CREDENTIAL_SCAN_FAILED",
    );
  } else if (step === "secrets.credential_pattern_scan") {
    fail(Number(at(details, "credentialPatternMatches")) === 0, "CREDENTIAL_PATTERN_SCAN_FAILED");
  } else if (step === "secrets.lease_token_pattern_scan") {
    fail(exact(details.rawLeaseTokenPatternMatches, { database: 0, localEvidenceFiles: 0 }), "LEASE_TOKEN_SCAN_FAILED");
  } else if (step === "secrets.forbidden_lease_token_key_scan") {
    fail(exact(details.forbiddenLeaseTokenKeys, { database: 0, localEvidenceFiles: 0 }), "LEASE_TOKEN_KEY_SCAN_FAILED");
  } else if (step.startsWith("replay.")) {
    const field = (
      {
        "replay.projections_deleted": "deleted",
        "replay.projections_rebuilt": "rebuilt",
        "replay.live_equals_replay": "equal",
      } as Record<string, string>
    )[step];
    fail(details[field] === true, `PROJECTION_${field.toUpperCase()}_FAILED`);
  } else if (step.startsWith("models.")) {
    const assignments = at(details, "preflight.assignments") as unknown[] | undefined;
    if (step === "models.implementation_reviewer_disabled")
      fail(at(details, "preflight.implementationReviewer") === "disabled", "IMPLEMENTATION_REVIEWER_ENABLED");
    else if (step === "models.fallback_disabled")
      fail(at(details, "preflight.noFallback") === true, "PROVIDER_FALLBACK_ENABLED");
    else
      fail(
        Boolean(
          assignments?.some((value) => {
            const item = object(value);
            return (
              item?.role === args.role &&
              item?.provider === args.provider &&
              item?.model === args.model &&
              item?.fallback === "disabled"
            );
          }),
        ),
        "MODEL_ASSIGNMENT_MISMATCH",
      );
  } else if (step.startsWith("runtime.")) {
    const assignments = at(details, "preflight.assignments") as unknown[] | undefined;
    fail(
      Boolean(
        assignments?.some((value) => {
          const item = object(value);
          return (
            item?.provider === args.provider &&
            item?.runtimeProfileId === args.profile &&
            HASH.test(String(item?.runtimeBindingHash ?? ""))
          );
        }),
      ),
      "RUNTIME_PROFILE_BINDING_MISMATCH",
    );
  } else if (step.startsWith("workflow.")) {
    const assertions = object(details.assertions) ?? details;
    const checks: Record<string, () => boolean> = {
      "workflow.preflight": () => at(assertions, "preflight.classification") === "READY",
      "workflow.mission_creation": () => UUID.test(String(details.consensusMissionId ?? "")),
      "workflow.proposal_rounds": () => Number(assertions.proposals) === 2,
      "workflow.canonical_synthesis": () => HASH.test(String(assertions.canonicalPlanHash ?? "")),
      "workflow.human_approval": () => assertions.singleHumanApproval === true,
      "workflow.child_creation": () => UUID.test(String(details.childMissionId ?? "")),
      "workflow.executor_claim": () => nonempty(assertions.childExecution),
      "workflow.child_success": () => at(assertions, "childExecution.status") === "succeeded",
      "workflow.durable_evidence": () => HASH.test(String(at(assertions, "childExecution.commitId") ?? "")),
      "workflow.independent_proposals_same_snapshot": () => assertions.sameSnapshot === true,
      "workflow.critiques_same_context": () => assertions.sameContext === true && Number(assertions.critiques) === 2,
      "workflow.revisions_same_plan_identity": () => Number(assertions.revisions) === 2,
      "workflow.canonical_verdict_exact_hash": () =>
        Array.isArray(assertions.verdicts) &&
        (assertions.verdicts as unknown[]).length === 2 &&
        (assertions.verdicts as unknown[]).every((value) => object(value)?.hash === assertions.canonicalPlanHash),
      "workflow.single_human_approval": () => assertions.singleHumanApproval === true,
      "workflow.child_authority_inheritance": () => at(assertions, "childExecution.authorityInherited") === true,
      "workflow.executor_exact_assignment": () => at(assertions, "childExecution.executorExact") === true,
      "workflow.durable_success_receipt": () => nonempty(assertions.childExecution),
      "workflow.project_brain_learning_candidate_only": () =>
        at(assertions, "learningCandidate.status") === "candidate",
    };
    fail(Boolean(checks[step]?.()), "WORKFLOW_REQUIREMENT_FAILED");
  } else if (step.startsWith("review.")) {
    const checks: Record<string, boolean> = {
      "review.independent_security_correctness_runtime":
        details.schemaVersion === "consensus-independent-review-evidence/2",
      "review.zero_unresolved_high": details.unresolvedHigh === 0,
      "review.zero_unresolved_medium": details.unresolvedMedium === 0,
      "review.contract_evidence_complete": details.requirementLedgerComplete === true,
    };
    fail(checks[step] === true, "INDEPENDENT_REVIEW_REQUIREMENT_FAILED");
  } else if (step.startsWith("cleanup.")) {
    const inventory = object(details.resourceInventory);
    const resources = inventory?.resources as unknown[] | undefined;
    const outcomes = inventory?.outcomes as unknown[] | undefined;
    const terminal = (type: string, state: string) => {
      const matching = resources?.filter((value) => object(value)?.type === type) ?? [];
      return (
        matching.length > 0 &&
        Boolean(
          outcomes &&
          matching.every((value) =>
            outcomes.some(
              (outcome) =>
                object(outcome)?.resourceId === object(value)?.resourceId && object(outcome)?.state === state,
            ),
          ),
        )
      );
    };
    const checks: Record<string, boolean> = {
      "cleanup.provider_processes_quiescent":
        terminal("provider_subprocess", "stopped") &&
        terminal("mission_agent_process", "stopped") &&
        terminal("process_group", "stopped"),
      "cleanup.server_stopped": terminal("mission_control_server", "stopped") && terminal("listener", "stopped"),
      "cleanup.database_removed": terminal("disposable_database", "deleted"),
      "cleanup.disposable_files_accounted": Boolean(
        resources &&
        outcomes &&
        resources.length === outcomes.length &&
        new Set(outcomes.map((value) => object(value)?.resourceId)).size === resources.length,
      ),
      "cleanup.production_untouched":
        at(details, "productionObservation.runtimeMode") === "disposable_acceptance" &&
        at(details, "productionObservation.disposable") === true &&
        at(details, "productionObservation.productionResourcesAllowed") === false,
    };
    fail(checks[step] === true, "CLEANUP_REQUIREMENT_FAILED");
  } else reasons.push("REQUIREMENT_SPECIFIC_SEMANTIC_VALIDATOR_UNMAPPED");
  return reasons;
}

export function createEvidenceHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
