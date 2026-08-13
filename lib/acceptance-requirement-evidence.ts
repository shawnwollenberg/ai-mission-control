import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { validateSemanticRequirement } from "./acceptance-semantic-validation";

export const ACCEPTANCE_REQUIREMENT_EVIDENCE_VERSION = "acceptance-requirement-evidence/1" as const;
export const ACCEPTANCE_EVIDENCE_INDEX_VERSION = "acceptance-evidence-index/1" as const;

export type AcceptanceCandidateBindings = Readonly<{
  artifactSha256: string;
  artifactMetadataSha256: string;
  capabilityManifestSha256: string;
  acceptanceSourceManifestSha256: string;
  acceptanceContractSha256: string;
  executableRegistrySha256: string;
  disposableRegistrySha256: string;
  providerRequirementsSha256: string;
  providerProfilesSha256: string;
  runtimeBindingsSha256: string;
  modelAssignmentsSha256: string;
  repositorySnapshotSha256: string;
  validatorRegistrySha256: string;
  reviewChecklistSha256: string;
  finalizerChecklistSha256: string;
  reviewerImplementationSha256: string;
  resourceInventoryImplementationSha256: string;
  cleanupFinalizerSha256: string;
  realAcceptanceHarnessSha256: string;
}>;

export type RequirementEvidenceInput = Readonly<{
  schemaVersion: typeof ACCEPTANCE_REQUIREMENT_EVIDENCE_VERSION;
  acceptanceRunId: string;
  attemptId: string;
  stepId: string;
  requirementId: string;
  validatorId: string;
  candidateBindings: AcceptanceCandidateBindings;
  provider: string | null;
  model: string | null;
  role: string | null;
  profile: string | null;
  assignmentId: string | null;
  lifecyclePhase: string;
  startedAt: string;
  completedAt: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256: string;
  fields: Readonly<Record<string, unknown>>;
}>;

export type RequirementValidationResult = Readonly<{
  schemaVersion: "acceptance-requirement-validation-result/1";
  acceptanceRunId: string;
  attemptId: string;
  stepId: string;
  requirementId: string;
  validatorId: string;
  validatorIdentity: string;
  candidateIdentitySha256: string;
  result: "passed" | "failed" | "deferred_to_authenticated_acceptance";
  startedAt: string;
  completedAt: string;
  evidenceArtifactId: string;
  evidenceSha256: string;
  validationResultIdentity: string;
  failureClassification?: string;
  provider?: string;
  model?: string;
  role?: string;
  profile?: string;
  assignmentId?: string;
}>;

export const candidateIdentity = (bindings: AcceptanceCandidateBindings) =>
  createHash("sha256").update(canonicalJson(bindings)).digest("hex");
export const validationResultIdentity = (
  row:
    | Omit<RequirementValidationResult, "validationResultIdentity">
    | RequirementValidationResult
    | Record<string, unknown>,
) => {
  const value = row as Record<string, unknown>;
  const fields = Object.fromEntries(
    [
      "schemaVersion",
      "acceptanceRunId",
      "attemptId",
      "stepId",
      "requirementId",
      "validatorId",
      "validatorIdentity",
      "candidateIdentitySha256",
      "result",
      "startedAt",
      "completedAt",
      "evidenceArtifactId",
      "evidenceSha256",
      "failureClassification",
      "provider",
      "model",
      "role",
      "profile",
      "assignmentId",
    ]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
};

export function getRequiredField(fields: Readonly<Record<string, unknown>>, path: string) {
  let current: unknown = fields;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function validateRequirementEvidence(args: {
  input: RequirementEvidenceInput;
  acceptanceRunId: string;
  expectedAttemptId: string;
  stepId: string;
  requirementId: string;
  validatorId: string;
  validatorIdentity: string;
  expectedCandidateBindings: AcceptanceCandidateBindings;
  requiredFields: readonly string[];
  passCriteriaId: string;
  applicableProviders: readonly string[];
  applicableModels: readonly string[];
  applicableRoles: readonly string[];
  applicableProfiles: readonly string[];
  lifecyclePhase: string;
}): RequirementValidationResult {
  const { input } = args;
  const fail = (classification: string): RequirementValidationResult => {
    const base = {
      schemaVersion: "acceptance-requirement-validation-result/1" as const,
      acceptanceRunId: args.acceptanceRunId,
      attemptId: args.expectedAttemptId,
      stepId: args.stepId,
      requirementId: args.requirementId,
      validatorId: args.validatorId,
      validatorIdentity: args.validatorIdentity,
      candidateIdentitySha256: candidateIdentity(args.expectedCandidateBindings),
      result: "failed" as const,
      startedAt: input?.startedAt ?? new Date().toISOString(),
      completedAt: input?.completedAt ?? new Date().toISOString(),
      evidenceArtifactId: input?.evidenceArtifactId ?? "missing",
      evidenceSha256: /^[a-f0-9]{64}$/.test(input?.evidenceArtifactSha256 ?? "")
        ? input.evidenceArtifactSha256
        : "0".repeat(64),
      failureClassification: classification,
    };
    return { ...base, validationResultIdentity: validationResultIdentity(base) };
  };
  if (!input || input.schemaVersion !== ACCEPTANCE_REQUIREMENT_EVIDENCE_VERSION)
    return fail("EVIDENCE_SCHEMA_MISMATCH");
  if (input.acceptanceRunId !== args.acceptanceRunId) return fail("EVIDENCE_RUN_MISMATCH");
  if (input.attemptId !== args.expectedAttemptId) return fail("EVIDENCE_ATTEMPT_MISMATCH");
  if (input.stepId !== args.stepId || input.requirementId !== args.requirementId)
    return fail("EVIDENCE_REQUIREMENT_MISMATCH");
  if (input.validatorId !== args.validatorId) return fail("EVIDENCE_VALIDATOR_MISMATCH");
  if (input.lifecyclePhase !== args.lifecyclePhase) return fail("EVIDENCE_LIFECYCLE_PHASE_MISMATCH");
  if (candidateIdentity(input.candidateBindings) !== candidateIdentity(args.expectedCandidateBindings))
    return fail("EVIDENCE_CANDIDATE_MISMATCH");
  if (args.applicableProviders.length && !args.applicableProviders.includes(input.provider ?? ""))
    return fail("EVIDENCE_PROVIDER_MISMATCH");
  if (args.applicableModels.length && !args.applicableModels.includes(input.model ?? ""))
    return fail("EVIDENCE_MODEL_MISMATCH");
  if (args.applicableRoles.length && !args.applicableRoles.includes(input.role ?? ""))
    return fail("EVIDENCE_ROLE_MISMATCH");
  if (args.applicableProfiles.length && !args.applicableProfiles.includes(input.profile ?? ""))
    return fail("EVIDENCE_PROFILE_MISMATCH");
  if (!Date.parse(input.startedAt) || !Date.parse(input.completedAt) || input.completedAt < input.startedAt)
    return fail("EVIDENCE_TIMESTAMP_INVALID");
  if (
    !/^(requirement|review|cleanup):[A-Za-z0-9._:-]{8,300}$/.test(input.evidenceArtifactId) ||
    !/^[a-f0-9]{64}$/.test(input.evidenceArtifactSha256) ||
    /^0{64}$/.test(input.evidenceArtifactSha256)
  )
    return fail("EVIDENCE_ARTIFACT_INVALID");
  if (args.requiredFields.some((field) => getRequiredField(input.fields, field) === undefined))
    return fail("EVIDENCE_REQUIRED_FIELD_MISSING");
  if (input.fields.passCriteriaId !== args.passCriteriaId) return fail("EVIDENCE_PASS_CRITERIA_MISMATCH");
  const semanticReasons = validateSemanticRequirement({
    stepId: args.stepId,
    acceptanceRunId: args.acceptanceRunId,
    observation: input.fields.observation,
    details: input.fields.details,
    candidateBindings: args.expectedCandidateBindings,
    provider: input.provider,
    model: input.model,
    role: input.role,
    profile: input.profile,
  });
  if (
    semanticReasons.length === 1 &&
    semanticReasons[0] === "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE" &&
    process.env.APP_ENV === "disposable_acceptance" &&
    process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance" &&
    [
      "diagnostic.exact_model_argument",
      "diagnostic.runtime_identity_honesty",
      "diagnostic.process_tree_terminated",
      "diagnostic.secret_redaction",
    ].includes(args.stepId)
  ) {
    const base = {
      schemaVersion: "acceptance-requirement-validation-result/1" as const,
      acceptanceRunId: input.acceptanceRunId,
      attemptId: input.attemptId,
      stepId: input.stepId,
      requirementId: input.requirementId,
      validatorId: input.validatorId,
      validatorIdentity: args.validatorIdentity,
      candidateIdentitySha256: candidateIdentity(input.candidateBindings),
      result: "deferred_to_authenticated_acceptance" as const,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      evidenceArtifactId: input.evidenceArtifactId,
      evidenceSha256: input.evidenceArtifactSha256,
      failureClassification: "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE",
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    };
    return { ...base, validationResultIdentity: validationResultIdentity(base) };
  }
  if (semanticReasons.length) return fail(semanticReasons.join(","));
  const base = {
    schemaVersion: "acceptance-requirement-validation-result/1" as const,
    acceptanceRunId: input.acceptanceRunId,
    attemptId: input.attemptId,
    stepId: input.stepId,
    requirementId: input.requirementId,
    validatorId: input.validatorId,
    validatorIdentity: args.validatorIdentity,
    candidateIdentitySha256: candidateIdentity(input.candidateBindings),
    result: "passed" as const,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    evidenceArtifactId: input.evidenceArtifactId,
    evidenceSha256: input.evidenceArtifactSha256,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
  };
  return { ...base, validationResultIdentity: validationResultIdentity(base) };
}

export function createImmutableEvidenceIndex(rows: readonly (RequirementValidationResult | Record<string, unknown>)[]) {
  const byStep = new Map<string, RequirementValidationResult>();
  for (const value of rows) {
    const row = value as RequirementValidationResult;
    if (
      !row.stepId ||
      !row.validationResultIdentity ||
      row.schemaVersion !== "acceptance-requirement-validation-result/1"
    )
      throw new Error("Immutable requirement result is malformed");
    if (validationResultIdentity(row) !== row.validationResultIdentity)
      throw new Error(`Immutable requirement result identity changed: ${row.stepId}`);
    const existing = byStep.get(row.stepId);
    if (existing) {
      if (existing.validationResultIdentity !== row.validationResultIdentity)
        throw new Error(`Conflicting immutable requirement result: ${row.stepId}`);
      throw new Error(`Duplicate validator credit: ${row.stepId}`);
    }
    byStep.set(row.stepId, row);
  }
  const entries = Array.from(byStep.values()).sort((left, right) => left.stepId.localeCompare(right.stepId));
  return Object.freeze({
    schemaVersion: ACCEPTANCE_EVIDENCE_INDEX_VERSION,
    entries,
    sha256: createHash("sha256")
      .update(canonicalJson({ schemaVersion: ACCEPTANCE_EVIDENCE_INDEX_VERSION, entries }))
      .digest("hex"),
  });
}
