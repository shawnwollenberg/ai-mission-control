import { createHash } from "node:crypto";
import { canonicalJson } from "../lib/canonical-json";
import {
  validateRequirementEvidence,
  candidateIdentity,
  type AcceptanceCandidateBindings,
  type RequirementEvidenceInput,
} from "../lib/acceptance-requirement-evidence";

export const ACCEPTANCE_EXECUTABLE_REGISTRY_VERSION = "consensus-acceptance-executable-registry/1" as const;
export const ACCEPTANCE_CONTRACT_VERSION = "consensus-real-provider-acceptance-contract/3" as const;
export const ACCEPTANCE_VALIDATOR_REGISTRY_VERSION = "consensus-acceptance-validator-registry/1" as const;

export type AcceptanceStepCategory =
  "preflight" | "workflow" | "authority" | "adversarial" | "recovery" | "isolation" | "replay" | "review" | "cleanup";
export type AcceptanceStepResult =
  | "passed"
  | "failed"
  | "deferred_to_authenticated_acceptance"
  | "not_reached_due_to_fail_stop"
  | "not_applicable_with_contract_reason";
export type AcceptanceExecutionPhase = "harness" | "post_run";
export type AcceptanceLifecyclePhase = "pre_review" | "review" | "cleanup" | "post_cleanup";
export type AcceptanceStepExecution = {
  result: AcceptanceStepResult;
  startedAt: string;
  completedAt: string;
  evidenceArtifactId?: string;
  evidenceSha256: string;
  failureClassification?: string;
  notApplicableReason?: string;
  failStopStepId?: string;
  provider?: string;
  model?: string;
  profile?: string;
  role?: string;
  assignmentId?: string;
};
export type AcceptanceStepContext = {
  acceptanceRunId: string;
  attemptIdByStep?: Readonly<Record<string, string>>;
  validatorIdentityByStep?: Readonly<Record<string, string>>;
  contractSha256: string;
  candidateBindings: AcceptanceCandidateBindings;
  evidenceByStep: Readonly<Record<string, RequirementEvidenceInput>>;
};
type StepDefinition = {
  name: string;
  category: AcceptanceStepCategory;
  sourceModule: string;
  evidenceSchema: string;
  expectedFailureCode?: string;
  protectedAction?: string;
  applicableRoles?: string[];
  applicableProviders?: string[];
  applicableModels?: string[];
  applicableProfiles?: string[];
  timeoutMs?: number;
  requiredFields?: string[];
  passCriteriaId?: string;
  validatorVersion?: 1 | 2 | 3 | 4;
};
export type AcceptanceExecutableStep = Readonly<{
  stepId: string;
  category: AcceptanceStepCategory;
  requirementId: string;
  mandatory: true;
  applicableRoles: readonly string[];
  applicableProviders: readonly string[];
  applicableModels: readonly string[];
  applicableProfiles: readonly string[];
  protectedAction: string | null;
  expectedFailureCode: string | null;
  evidenceSchema: string;
  implementationModule: "scripts/consensus-real-acceptance-steps.ts";
  boundSourceModules: readonly string[];
  executionPhase: AcceptanceExecutionPhase;
  lifecyclePhase: AcceptanceLifecyclePhase;
  implementationReference: string;
  validatorId: string;
  validatorIdentity: string;
  requiredFields: readonly string[];
  passCriteriaId: string;
  timeoutMs: number;
  implementation: (context: AcceptanceStepContext) => Promise<AcceptanceStepExecution>;
}>;

const group = (
  category: AcceptanceStepCategory,
  sourceModule: string,
  evidenceSchema: string,
  names: readonly string[],
  overrides: Partial<Record<string, Partial<StepDefinition>>> = {},
): StepDefinition[] => names.map((name) => ({ category, sourceModule, evidenceSchema, name, ...overrides[name] }));

// This is the sole authored mandatory inventory. Every entry becomes a live
// executable function, generated contract row, run-plan item, evidence row,
// runbook checklist item, and independent-review checklist item.
const mandatoryDefinitions: StepDefinition[] = [
  ...group("preflight", "scripts/run-consensus-real-acceptance.ts", "packet-verification/1", [
    "packet.artifact",
    "packet.artifact_metadata",
    "packet.capability_manifest",
    "packet.source_manifest",
    "packet.acceptance_contract",
    "registry.exact_hash",
    "registry.validity_window",
    "registry.contract_hash",
  ]),
  ...group(
    "preflight",
    "application/disposable-acceptance-preflight.ts",
    "consensus-acceptance-preflight/1",
    [
      "agent.codex_authenticated",
      "agent.claude_code_authenticated",
      "agent.capability_attestation_exact",
      "repository.authenticated_registration",
      "repository.same_identity",
      "repository.same_snapshot",
      "project_brain.initialized_context",
      "project_brain.governed_context_pack",
      "models.planner_a_claude_fable_5",
      "models.planner_b_gpt_5_6_sol",
      "models.synthesizer_claude_fable_5",
      "models.executor_gpt_5_6_luna",
      "models.implementation_reviewer_disabled",
      "models.fallback_disabled",
    ],
    {
      "agent.codex_authenticated": { applicableProviders: ["codex"] },
      "agent.claude_code_authenticated": { applicableProviders: ["claude_code"] },
      "models.planner_a_claude_fable_5": {
        applicableProviders: ["claude_code"],
        applicableModels: ["claude-fable-5"],
        applicableRoles: ["planner_a"],
      },
      "models.planner_b_gpt_5_6_sol": {
        applicableProviders: ["codex"],
        applicableModels: ["gpt-5.6-sol"],
        applicableRoles: ["planner_b"],
      },
      "models.synthesizer_claude_fable_5": {
        applicableProviders: ["claude_code"],
        applicableModels: ["claude-fable-5"],
        applicableRoles: ["synthesizer"],
      },
      "models.executor_gpt_5_6_luna": {
        applicableProviders: ["codex"],
        applicableModels: ["gpt-5.6-luna"],
        applicableRoles: ["executor"],
      },
    },
  ),
  ...group("authority", "domain/repository-authority.ts", "repository-authority/2", [
    "repository.canonical_path",
    "repository.isolated_executor_worktree",
    "repository.source_unchanged",
    "repository.planning_push_disabled",
    "repository.mission_agent_local_commit_allowed",
    "repository.provider_direct_commit_denied",
    "repository.push_denied",
    "repository.pull_request_denied",
    "repository.publication_denied",
    "repository.deployment_denied",
    "repository.infrastructure_denied",
    "repository.generic_write_does_not_imply_push",
    "repository.authority_replay_idempotent",
    "repository.authority_downgrade_rejected",
    "repository.authority_expansion_requires_approval",
    "repository.child_authority_not_broadened",
    "repository.push_enabled_preflight_fails",
    "repository.push_disabled_preflight_passes",
  ]),
  ...group("authority", "application/pull-assignments.ts", "assignment-authority-check/1", [
    "authority.changed_executable_rejected",
    "authority.changed_runtime_profile_rejected",
    "authority.changed_authentication_binding_rejected",
    "authority.changed_repository_authority_rejected",
    "authority.expired_capability_attestation_rejected",
    "authority.stale_lease_rejected",
    "authority.stale_fencing_token_rejected",
    "authority.lease_loss_rejects_output",
    "authority.delayed_provider_output_rejected",
    "authority.conflicting_receipt_rejected",
    "authority.cancelled_assignment_claim_rejected",
  ]),
  ...group(
    "preflight",
    "domain/provider-runtime-profiles.ts",
    "provider-runtime-binding/1",
    [
      "runtime.claude_implementation_macos_v2",
      "runtime.claude_planning_macos_v2",
      "runtime.codex_implementation_macos_v2",
      "runtime.codex_planning_macos_v2",
    ],
    {
      "runtime.claude_implementation_macos_v2": {
        applicableProviders: ["claude_code"],
        applicableProfiles: ["claude_implementation_macos_v2"],
      },
      "runtime.claude_planning_macos_v2": {
        applicableProviders: ["claude_code"],
        applicableProfiles: ["claude_planning_macos_v2"],
      },
      "runtime.codex_implementation_macos_v2": {
        applicableProviders: ["codex"],
        applicableProfiles: ["codex_implementation_macos_v2"],
      },
      "runtime.codex_planning_macos_v2": {
        applicableProviders: ["codex"],
        applicableProfiles: ["codex_planning_macos_v2"],
      },
    },
  ),
  ...group(
    "authority",
    "lib/acceptance-source-checkpoints.ts",
    "acceptance-source-revalidation/1",
    [
      "source.before_mission_creation",
      "source.before_human_approval",
      "source.before_child_creation",
      "source.before_executor_claim",
    ],
    {
      "source.before_mission_creation": { protectedAction: "create_consensus_mission" },
      "source.before_human_approval": { protectedAction: "submit_human_approval" },
      "source.before_child_creation": { protectedAction: "create_child_implementation_mission" },
      "source.before_executor_claim": { protectedAction: "authorize_executor_claim" },
    },
  ),
  ...group("workflow", "scripts/run-consensus-real-acceptance.ts", "consensus-real-acceptance-step/1", [
    "workflow.preflight",
    "workflow.mission_creation",
    "workflow.proposal_rounds",
    "workflow.canonical_synthesis",
    "workflow.human_approval",
    "workflow.child_creation",
    "workflow.executor_claim",
    "workflow.child_success",
    "workflow.durable_evidence",
    "workflow.independent_proposals_same_snapshot",
    "workflow.critiques_same_context",
    "workflow.revisions_same_plan_identity",
    "workflow.canonical_verdict_exact_hash",
    "workflow.single_human_approval",
    "workflow.child_authority_inheritance",
    "workflow.executor_exact_assignment",
    "workflow.durable_success_receipt",
    "workflow.project_brain_learning_candidate_only",
  ]),
  ...group(
    "adversarial",
    "tests/consensus-plan.test.mjs",
    "deterministic-adversarial-result/1",
    [
      "adversarial.credential_free_artifact_preflight",
      "adversarial.changed_model_rejected",
      "adversarial.malformed_proposal_rejected",
      "adversarial.malformed_critique_rejected",
      "adversarial.malformed_revision_rejected",
      "adversarial.malformed_synthesis_rejected",
      "adversarial.malformed_verdict_rejected",
      "adversarial.wrong_consensus_state_rejected",
      "adversarial.wrong_repository_snapshot_rejected",
      "adversarial.wrong_context_pack_rejected",
      "adversarial.wrong_artifact_hash_rejected",
      "adversarial.wrong_canonical_plan_hash_rejected",
      "adversarial.duplicate_message_idempotent",
      "adversarial.repository_drift_rejected",
    ],
    {
      "adversarial.wrong_canonical_plan_hash_rejected": {
        evidenceSchema: "wrong-canonical-plan-hash-observation/2",
        validatorVersion: 2,
        passCriteriaId: "pass:adversarial.wrong_canonical_plan_hash_rejected/2",
      },
      "adversarial.repository_drift_rejected": {
        evidenceSchema: "repository-drift-observation/2",
        validatorVersion: 2,
        passCriteriaId: "pass:adversarial.repository_drift_rejected/2",
      },
    },
  ),
  ...group(
    "adversarial",
    "tests/acceptance-source-checkpoints.test.mjs",
    "source-mutation-matrix/1",
    ["adversarial.source_closure_mutation_matrix", "adversarial.checkpoint_identity_and_reuse"],
    {
      "adversarial.source_closure_mutation_matrix": {
        evidenceSchema: "source-closure-mutation-observation/2",
        validatorVersion: 2,
        passCriteriaId: "pass:adversarial.source_closure_mutation_matrix/2",
      },
      "adversarial.checkpoint_identity_and_reuse": {
        evidenceSchema: "checkpoint-misuse-observation/2",
        validatorVersion: 2,
        passCriteriaId: "pass:adversarial.checkpoint_identity_and_reuse/2",
      },
    },
  ),
  ...group("adversarial", "scripts/discover-provider-runtime-profiles.mjs", "provider-lifecycle-result/1", [
    "adversarial.provider_lifecycle_matrix",
    "diagnostic.exact_model_argument",
    "diagnostic.runtime_identity_honesty",
    "diagnostic.process_tree_terminated",
    "diagnostic.secret_redaction",
  ]),
  ...group(
    "recovery",
    "scripts/run-consensus-real-acceptance.ts",
    "provider-recovery-result/2",
    [
      "recovery.provider_restart",
      "recovery.mission_control_restart",
      "recovery.lease_loss",
      "recovery.delayed_output",
      "recovery.conflicting_receipt",
    ],
    {
      "recovery.provider_restart": {
        validatorVersion: 4,
        passCriteriaId: "pass:recovery.provider_restart/4",
        evidenceSchema: "provider-recovery-result/4",
      },
      "recovery.mission_control_restart": {
        validatorVersion: 3,
        passCriteriaId: "pass:recovery.mission_control_restart/3",
        evidenceSchema: "mission-control-restart-result/3",
      },
      "recovery.lease_loss": { validatorVersion: 2, passCriteriaId: "pass:recovery.lease_loss/2" },
      "recovery.delayed_output": { validatorVersion: 2, passCriteriaId: "pass:recovery.delayed_output/2" },
      "recovery.conflicting_receipt": {
        validatorVersion: 2,
        passCriteriaId: "pass:recovery.conflicting_receipt/2",
      },
    },
  ),
  ...group(
    "isolation",
    "application/disposable-acceptance-preflight.ts",
    "disposable-isolation-result/1",
    [
      "isolation.production_resources_rejected",
      "isolation.disposable_database_only",
      "isolation.provider_writable_roots_bounded",
      "isolation.repository_mutation_isolated",
    ],
    {
      "isolation.production_resources_rejected": {
        evidenceSchema: "production-resource-rejection-observation/2",
        validatorVersion: 2,
        passCriteriaId: "pass:isolation.production_resources_rejected/2",
      },
      "isolation.disposable_database_only": {
        evidenceSchema: "disposable-database-isolation-observation/2",
        validatorVersion: 2,
        passCriteriaId: "pass:isolation.disposable_database_only/2",
      },
    },
  ),
  ...group("replay", "scripts/projections.ts", "projection-replay-verification/1", [
    "replay.projections_deleted",
    "replay.projections_rebuilt",
    "replay.live_equals_replay",
  ]),
  ...group("adversarial", "scripts/run-consensus-real-acceptance.ts", "secret-scan-result/1", [
    "secrets.exact_credential_scan",
    "secrets.credential_pattern_scan",
    "secrets.lease_token_pattern_scan",
    "secrets.forbidden_lease_token_key_scan",
  ]),
  ...group("review", "scripts/finalize-consensus-real-acceptance.ts", "independent-review-result/2", [
    "review.independent_security_correctness_runtime",
    "review.zero_unresolved_high",
    "review.zero_unresolved_medium",
    "review.contract_evidence_complete",
  ]),
  ...group("cleanup", "scripts/finalize-consensus-real-acceptance.ts", "acceptance-cleanup-result/2", [
    "cleanup.provider_processes_quiescent",
    "cleanup.server_stopped",
    "cleanup.database_removed",
    "cleanup.disposable_files_accounted",
    "cleanup.production_untouched",
  ]),
];

const requirementId = (stepId: string) =>
  `REQ-${createHash("sha256").update(stepId).digest("hex").slice(0, 16).toUpperCase()}`;
const validatorIdentityFor = (definition: StepDefinition, stepId: string) =>
  createHash("sha256")
    .update(
      canonicalJson({
        validatorVersion: `acceptance-requirement-validator/${definition.validatorVersion ?? 1}`,
        stepId,
        validatorId: `validate:${stepId}/${definition.validatorVersion ?? 1}`,
        requiredFields: definition.requiredFields ?? ["passCriteriaId", "observation", "details"],
        passCriteriaId: definition.passCriteriaId ?? `pass:${stepId}/1`,
        evidenceSchema: definition.evidenceSchema,
      }),
    )
    .digest("hex");
const makeExecutable =
  (definition: StepDefinition, stepId: string, requirement: string) => async (context: AcceptanceStepContext) =>
    validateRequirementEvidence({
      input: context.evidenceByStep[stepId],
      acceptanceRunId: context.acceptanceRunId,
      expectedAttemptId: context.attemptIdByStep?.[stepId] ?? context.acceptanceRunId,
      stepId,
      requirementId: requirement,
      validatorId: `validate:${stepId}/${definition.validatorVersion ?? 1}`,
      validatorIdentity: context.validatorIdentityByStep?.[stepId] ?? validatorIdentityFor(definition, stepId),
      expectedCandidateBindings: context.candidateBindings,
      requiredFields: definition.requiredFields ?? ["passCriteriaId", "observation", "details"],
      passCriteriaId: definition.passCriteriaId ?? `pass:${stepId}/1`,
      applicableProviders: definition.applicableProviders ?? [],
      applicableModels: definition.applicableModels ?? [],
      applicableRoles: definition.applicableRoles ?? [],
      applicableProfiles: definition.applicableProfiles ?? [],
      lifecyclePhase:
        definition.category === "review" ? "review" : definition.category === "cleanup" ? "cleanup" : "pre_review",
    });

export const acceptanceExecutableRegistry: readonly AcceptanceExecutableStep[] = Object.freeze(
  mandatoryDefinitions.map((definition) => {
    const stepId = definition.name;
    const requirement = requirementId(stepId);
    return Object.freeze({
      stepId,
      category: definition.category,
      requirementId: requirement,
      mandatory: true as const,
      applicableRoles: Object.freeze([...(definition.applicableRoles ?? [])]),
      applicableProviders: Object.freeze([...(definition.applicableProviders ?? [])]),
      applicableModels: Object.freeze([...(definition.applicableModels ?? [])]),
      applicableProfiles: Object.freeze([...(definition.applicableProfiles ?? [])]),
      protectedAction: definition.protectedAction ?? null,
      expectedFailureCode: definition.expectedFailureCode ?? null,
      evidenceSchema: definition.evidenceSchema,
      implementationModule: "scripts/consensus-real-acceptance-steps.ts" as const,
      boundSourceModules: Object.freeze([
        definition.sourceModule,
        "lib/acceptance-requirement-evidence.ts",
        "lib/acceptance-semantic-validation.ts",
      ]),
      executionPhase: (definition.category === "review" || definition.category === "cleanup"
        ? "post_run"
        : "harness") as AcceptanceExecutionPhase,
      lifecyclePhase: (definition.category === "review"
        ? "review"
        : definition.category === "cleanup"
          ? "cleanup"
          : "pre_review") as AcceptanceLifecyclePhase,
      implementationReference: `acceptanceExecutableRegistry:${stepId}`,
      validatorId: `validate:${stepId}/${definition.validatorVersion ?? 1}`,
      validatorIdentity: validatorIdentityFor(definition, stepId),
      requiredFields: Object.freeze([...(definition.requiredFields ?? ["passCriteriaId", "observation", "details"])]),
      passCriteriaId: definition.passCriteriaId ?? `pass:${stepId}/1`,
      timeoutMs: definition.timeoutMs ?? 0,
      implementation: makeExecutable(definition, stepId, requirement),
    });
  }),
);

export function validateExecutableRegistry(
  registry: readonly AcceptanceExecutableStep[] = acceptanceExecutableRegistry,
) {
  if (!registry.length) throw new Error("Executable acceptance registry is empty");
  const stepIds = new Set<string>();
  const requirementIds = new Set<string>();
  const implementations = new Set<(context: AcceptanceStepContext) => Promise<AcceptanceStepExecution>>();
  const validatorIds = new Set<string>();
  for (const step of registry) {
    if (!step.mandatory) throw new Error(`Mandatory acceptance step was demoted: ${step.stepId}`);
    if (!/^[a-z][a-z0-9_.]{2,159}$/.test(step.stepId)) throw new Error(`Invalid acceptance step ID: ${step.stepId}`);
    if (stepIds.has(step.stepId)) throw new Error(`Duplicate acceptance step ID: ${step.stepId}`);
    if (requirementIds.has(step.requirementId))
      throw new Error(`Duplicate acceptance requirement: ${step.requirementId}`);
    if (implementations.has(step.implementation)) throw new Error(`Executable implementation reused: ${step.stepId}`);
    if (validatorIds.has(step.validatorId)) throw new Error(`Authoritative validator reused: ${step.stepId}`);
    if (!/^[a-f0-9]{64}$/.test(step.validatorIdentity) || !step.requiredFields.length)
      throw new Error(`Authoritative validator registration is incomplete: ${step.stepId}`);
    if (typeof step.implementation !== "function") throw new Error(`Dead executable registration: ${step.stepId}`);
    stepIds.add(step.stepId);
    requirementIds.add(step.requirementId);
    implementations.add(step.implementation);
    validatorIds.add(step.validatorId);
  }
  return true;
}

export type AcceptanceImplementationHashes = Record<string, string>;
export function acceptanceImplementationIdentity(
  step: AcceptanceExecutableStep,
  hashes: AcceptanceImplementationHashes,
) {
  const registryHash = hashes["scripts/consensus-real-acceptance-steps.ts"];
  const boundSourceHashes = step.boundSourceModules.map((sourceModule) => ({
    sourceModule,
    sha256: hashes[sourceModule],
  }));
  if (
    !/^[a-f0-9]{64}$/.test(registryHash ?? "") ||
    boundSourceHashes.some(({ sha256 }) => !/^[a-f0-9]{64}$/.test(sha256 ?? ""))
  )
    throw new Error(`Missing governed implementation source hash: ${step.stepId}`);
  return createHash("sha256")
    .update(
      canonicalJson({
        registryVersion: ACCEPTANCE_EXECUTABLE_REGISTRY_VERSION,
        registryHash,
        boundSourceHashes,
        stepId: step.stepId,
        category: step.category,
        requirementId: step.requirementId,
        mandatory: step.mandatory,
        applicableRoles: step.applicableRoles,
        applicableProviders: step.applicableProviders,
        applicableModels: step.applicableModels,
        applicableProfiles: step.applicableProfiles,
        protectedAction: step.protectedAction,
        expectedFailureCode: step.expectedFailureCode,
        evidenceSchema: step.evidenceSchema,
        implementationModule: step.implementationModule,
        executionPhase: step.executionPhase,
        lifecyclePhase: step.lifecyclePhase,
        implementationReference: step.implementationReference,
        validatorId: step.validatorId,
        validatorIdentity: acceptanceValidatorIdentity(step, hashes),
        requiredFields: step.requiredFields,
        passCriteriaId: step.passCriteriaId,
        timeoutMs: step.timeoutMs,
      }),
    )
    .digest("hex");
}

export function acceptanceValidatorIdentity(step: AcceptanceExecutableStep, hashes: AcceptanceImplementationHashes) {
  const validatorSources = [
    "scripts/consensus-real-acceptance-steps.ts",
    "lib/acceptance-requirement-evidence.ts",
    "lib/acceptance-semantic-validation.ts",
  ].map((sourceModule) => ({ sourceModule, sha256: hashes[sourceModule] }));
  if (validatorSources.some(({ sha256 }) => !/^[a-f0-9]{64}$/.test(sha256 ?? "")))
    throw new Error(`Missing governed validator source hash: ${step.stepId}`);
  return createHash("sha256")
    .update(
      canonicalJson({
        validatorRegistryVersion: ACCEPTANCE_VALIDATOR_REGISTRY_VERSION,
        validatorSources,
        validatorConfigurationIdentity: step.validatorIdentity,
        stepId: step.stepId,
        requirementId: step.requirementId,
        evidenceSchema: step.evidenceSchema,
        requiredFields: step.requiredFields,
        passCriteriaId: step.passCriteriaId,
        applicableRoles: step.applicableRoles,
        applicableProviders: step.applicableProviders,
        applicableModels: step.applicableModels,
        applicableProfiles: step.applicableProfiles,
      }),
    )
    .digest("hex");
}

export function generateAcceptanceContract(hashes: AcceptanceImplementationHashes) {
  validateExecutableRegistry();
  return {
    schema_version: ACCEPTANCE_CONTRACT_VERSION,
    registry_version: ACCEPTANCE_EXECUTABLE_REGISTRY_VERSION,
    validator_registry_version: ACCEPTANCE_VALIDATOR_REGISTRY_VERSION,
    scope: "disposable_consensus_real_provider_acceptance" as const,
    runtime_mode: "disposable_acceptance" as const,
    production_access: false as const,
    steps: acceptanceExecutableRegistry.map((step) => ({
      step_id: step.stepId,
      category: step.category,
      requirement_id: step.requirementId,
      mandatory: step.mandatory,
      applicable_roles: step.applicableRoles,
      applicable_providers: step.applicableProviders,
      applicable_models: step.applicableModels,
      applicable_profiles: step.applicableProfiles,
      protected_action: step.protectedAction,
      expected_failure_code: step.expectedFailureCode,
      evidence_schema: step.evidenceSchema,
      implementation_module: step.implementationModule,
      bound_source_modules: step.boundSourceModules,
      execution_phase: step.executionPhase,
      lifecycle_phase: step.lifecyclePhase,
      implementation_reference: step.implementationReference,
      validator_id: step.validatorId,
      validator_configuration_identity: step.validatorIdentity,
      validator_identity: acceptanceValidatorIdentity(step, hashes),
      required_evidence_fields: step.requiredFields,
      pass_criteria_id: step.passCriteriaId,
      implementation_identity: acceptanceImplementationIdentity(step, hashes),
      timeout_ms: step.timeoutMs,
    })),
  };
}
export type GeneratedAcceptanceContract = ReturnType<typeof generateAcceptanceContract>;

export function acceptanceExecutableRegistryIdentity(contract: ReturnType<typeof generateAcceptanceContract>) {
  return createHash("sha256")
    .update(canonicalJson({ registry_version: contract.registry_version, steps: contract.steps }))
    .digest("hex");
}

export function acceptanceValidatorRegistryIdentity(contract: ReturnType<typeof generateAcceptanceContract>) {
  return createHash("sha256")
    .update(
      canonicalJson({
        validator_registry_version: contract.validator_registry_version,
        validators: contract.steps.map((step) => ({
          requirement_id: step.requirement_id,
          step_id: step.step_id,
          validator_id: step.validator_id,
          validator_identity: step.validator_identity,
          evidence_schema: step.evidence_schema,
          required_evidence_fields: step.required_evidence_fields,
          pass_criteria_id: step.pass_criteria_id,
          applicable_roles: step.applicable_roles,
          applicable_providers: step.applicable_providers,
          applicable_models: step.applicable_models,
          applicable_profiles: step.applicable_profiles,
        })),
      }),
    )
    .digest("hex");
}

export function createAcceptanceRunPlan(contract: ReturnType<typeof generateAcceptanceContract>) {
  const byId = new Map(acceptanceExecutableRegistry.map((step) => [step.stepId, step]));
  const plan = contract.steps.map((row) => {
    const executable = byId.get(row.step_id);
    if (!executable || executable.requirementId !== row.requirement_id)
      throw new Error(`Contract requirement has no executable implementation: ${row.step_id}`);
    return executable;
  });
  if (plan.length !== acceptanceExecutableRegistry.length)
    throw new Error("Registered mandatory step is absent from generated run plan");
  return plan;
}

export async function executeAcceptanceRunPlan(
  contract: ReturnType<typeof generateAcceptanceContract>,
  context: AcceptanceStepContext,
  phase?: AcceptanceExecutionPhase,
) {
  const rows = [];
  const validatorIdentityByStep = Object.fromEntries(
    contract.steps.map((step) => [step.step_id, step.validator_identity]),
  );
  let failedStepId: string | undefined;
  for (const step of createAcceptanceRunPlan(contract).filter(
    (candidate) => !phase || candidate.executionPhase === phase,
  )) {
    const result = failedStepId
      ? {
          result: "not_reached_due_to_fail_stop" as const,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          evidenceSha256: createHash("sha256").update(`fail-stop:${failedStepId}:${step.stepId}`).digest("hex"),
          failStopStepId: failedStepId,
        }
      : await step.implementation({ ...context, validatorIdentityByStep });
    rows.push({
      contract_sha256: context.contractSha256,
      step_id: step.stepId,
      requirement_id: step.requirementId,
      implementation_identity: contract.steps.find((row) => row.step_id === step.stepId)!.implementation_identity,
      acceptance_run_id: context.acceptanceRunId,
      ...result,
    });
    if (result.result === "failed") failedStepId = step.stepId;
  }
  return rows;
}

export function assertAcceptanceEvidenceAccounting(
  contract: ReturnType<typeof generateAcceptanceContract>,
  rows: Array<Record<string, unknown>>,
  options: {
    acceptanceRunId: string;
    contractSha256: string;
    candidateBindings?: AcceptanceCandidateBindings;
    requireSuccess?: boolean;
    phase?: AcceptanceExecutionPhase;
  },
) {
  const expectedSteps = options.phase
    ? contract.steps.filter((step) => step.execution_phase === options.phase)
    : contract.steps;
  if (rows.length !== expectedSteps.length) throw new Error("Acceptance evidence row count does not match contract");
  const ids = rows.map((row) => String(row.step_id));
  if (new Set(ids).size !== ids.length) throw new Error("Acceptance evidence contains duplicate step rows");
  const byStep = new Map(rows.map((row) => [String(row.step_id), row]));
  for (const step of expectedSteps) {
    const row = byStep.get(step.step_id);
    if (!row) throw new Error(`Mandatory acceptance evidence is missing: ${step.step_id}`);
    if (row.requirement_id !== step.requirement_id || row.implementation_identity !== step.implementation_identity)
      throw new Error(`Mandatory acceptance evidence binding changed: ${step.step_id}`);
    if (
      row.validatorId !== step.validator_id ||
      row.validatorIdentity !== step.validator_identity ||
      !/^[a-f0-9]{64}$/.test(String(row.validationResultIdentity ?? ""))
    )
      throw new Error(`Mandatory acceptance validator binding changed: ${step.step_id}`);
    if (options.candidateBindings && row.candidateIdentitySha256 !== candidateIdentity(options.candidateBindings))
      throw new Error(`Mandatory acceptance candidate binding changed: ${step.step_id}`);
    if (row.contract_sha256 !== options.contractSha256 || row.acceptance_run_id !== options.acceptanceRunId)
      throw new Error(`Mandatory acceptance run binding changed: ${step.step_id}`);
    if (!/^[a-f0-9]{64}$/.test(String(row.evidenceSha256 ?? "")))
      throw new Error(`Mandatory acceptance evidence hash is invalid: ${step.step_id}`);
    if (
      !Date.parse(String(row.startedAt ?? "")) ||
      !Date.parse(String(row.completedAt ?? "")) ||
      String(row.completedAt) < String(row.startedAt)
    )
      throw new Error(`Mandatory acceptance timestamps are invalid: ${step.step_id}`);
    if (
      ![
        "passed",
        "failed",
        "deferred_to_authenticated_acceptance",
        "not_reached_due_to_fail_stop",
        "not_applicable_with_contract_reason",
      ].includes(String(row.result))
    )
      throw new Error(`Mandatory acceptance evidence result is invalid: ${step.step_id}`);
    if (row.result === "failed" && !row.failureClassification)
      throw new Error(`Failed acceptance evidence omitted classification: ${step.step_id}`);
    if (row.result === "not_applicable_with_contract_reason")
      throw new Error(`Contract has no conditional applicability for mandatory step: ${step.step_id}`);
    if (
      row.result === "deferred_to_authenticated_acceptance" &&
      !(
        process.env.APP_ENV === "disposable_acceptance" &&
        process.env.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance" &&
        [
          "diagnostic.exact_model_argument",
          "diagnostic.runtime_identity_honesty",
          "diagnostic.process_tree_terminated",
          "diagnostic.secret_redaction",
        ].includes(step.step_id)
      )
    )
      throw new Error(`Acceptance requirement was not authorized for deferral: ${step.step_id}`);
    if (row.result === "not_reached_due_to_fail_stop" && !row.failStopStepId)
      throw new Error(`Fail-stop acceptance evidence omitted causal step: ${step.step_id}`);
    if (
      options.requireSuccess !== false &&
      step.mandatory &&
      row.result !== "passed" &&
      row.result !== "deferred_to_authenticated_acceptance"
    )
      throw new Error(`Mandatory applicable acceptance step did not pass: ${step.step_id}`);
  }
  if (byStep.size !== expectedSteps.length)
    throw new Error("Acceptance evidence contains a non-contract run-plan step");
  return true;
}
