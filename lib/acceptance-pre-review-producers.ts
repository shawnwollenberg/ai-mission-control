/* eslint-disable @typescript-eslint/no-explicit-any -- governed raw observations are narrowed by explicit producer registrations */
import { canonicalHash } from "./canonical-json";
import type { AcceptanceCandidateBindings } from "./acceptance-requirement-evidence";

type Sources = {
  packet: Record<string, any>;
  registry: Record<string, any>;
  preflight: Record<string, any>;
  repositoryAuthority?: Record<string, any>;
  repositoryRuntime?: Record<string, any>;
  authorityChecks?: Record<string, any>[];
  runtimeProfiles?: Record<string, any>[];
  sourceCheckpoints?: Record<string, any>[];
  workflow?: Record<string, any>;
  adversarial?: Record<string, any>;
  diagnostics?: Record<string, any>;
  recovery?: Record<string, any>;
  isolation?: Record<string, any>;
  replay?: Record<string, any>;
  secrets?: Record<string, any>;
};
type Context = { acceptanceRunId: string; candidateBindings: AcceptanceCandidateBindings; observedAt: string };
export type ProducedEvidence = Record<string, unknown> & {
  producerId: string;
  schemaVersion: string;
  acceptanceRunId: string;
  candidateIdentitySha256: string;
};
type Registration = {
  stepId: string;
  producerId: string;
  schemaId: string;
  validatorId: string;
  produce: (sources: Sources, context: Context) => ProducedEvidence;
};
const base = (producerId: string, schemaVersion: string, context: Context) => ({
  producerId,
  schemaVersion,
  acceptanceRunId: context.acceptanceRunId,
  candidateIdentitySha256: canonicalHash(context.candidateBindings),
});
const path = (value: any, dotted: string) => dotted.split(".").reduce((current, key) => current?.[key], value);
const exactHash = (
  stepId: string,
  actualPath: string,
  expectedKey: keyof AcceptanceCandidateBindings,
): Registration => {
  const producerId = `produce:${stepId}/1`,
    schemaId = `requirement-raw-${stepId.replaceAll(".", "-")}/1`;
  return {
    stepId,
    producerId,
    schemaId,
    validatorId: `validate:${stepId}/1`,
    produce: (sources, context) => ({
      ...base(producerId, schemaId, context),
      actualSha256: path(sources.packet, actualPath),
      expectedSha256: context.candidateBindings[expectedKey],
    }),
  };
};
const exactFacts = (
  stepId: string,
  produceFacts: (sources: Sources, context: Context) => Record<string, unknown>,
): Registration => {
  const producerId = `produce:${stepId}/1`,
    schemaId = `requirement-raw-${stepId.replaceAll(".", "-")}/1`;
  return {
    stepId,
    producerId,
    schemaId,
    validatorId: `validate:${stepId}/1`,
    produce: (sources, context) => ({ ...base(producerId, schemaId, context), ...produceFacts(sources, context) }),
  };
};
const exactFactsV2 = (
  stepId: string,
  produceFacts: (sources: Sources, context: Context) => Record<string, unknown>,
): Registration => {
  const producerId = `produce:${stepId}/2`;
  const schemaId = `requirement-raw-${stepId.replaceAll(".", "-")}/2`;
  return {
    stepId,
    producerId,
    schemaId,
    validatorId: `validate:${stepId}/2`,
    produce: (sources, context) => ({ ...base(producerId, schemaId, context), ...produceFacts(sources, context) }),
  };
};
const exactFactsV3 = (
  stepId: string,
  produceFacts: (sources: Sources, context: Context) => Record<string, unknown>,
): Registration => {
  const producerId = `produce:${stepId}/3`;
  const schemaId = `requirement-raw-${stepId.replaceAll(".", "-")}/3`;
  return {
    stepId,
    producerId,
    schemaId,
    validatorId: `validate:${stepId}/3`,
    produce: (sources, context) => ({ ...base(producerId, schemaId, context), ...produceFacts(sources, context) }),
  };
};
const exactFactsV4 = (
  stepId: string,
  produceFacts: (sources: Sources, context: Context) => Record<string, unknown>,
): Registration => {
  const producerId = `produce:${stepId}/4`;
  const schemaId = `requirement-raw-${stepId.replaceAll(".", "-")}/4`;
  return {
    stepId,
    producerId,
    schemaId,
    validatorId: `validate:${stepId}/4`,
    produce: (sources, context) => ({ ...base(producerId, schemaId, context), ...produceFacts(sources, context) }),
  };
};
const assignment = (stepId: string, role: string, provider: string, model: string) =>
  exactFacts(stepId, (sources) => {
    const actual = sources.preflight.assignments?.find((item: any) => item.role === role) ?? {};
    return {
      role: actual.role,
      expectedRole: role,
      provider: actual.provider,
      expectedProvider: provider,
      model: actual.model,
      expectedModel: model,
      fallback: actual.fallback,
      expectedFallback: "disabled",
      agentId: actual.agentId,
      capabilityAttestationId: actual.capabilityAttestationId,
    };
  });
const repositoryFact = (stepId: string, field: string, expected: boolean) =>
  exactFacts(stepId, (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    authorityHash: sources.preflight.repository?.repositoryAuthorityHash,
    actualValue: sources.preflight.repository?.[field],
    expectedValue: expected,
  }));
const authorityRejection = (stepId: string, mutationKind: string, rejectionCode: string) =>
  exactFacts(stepId, (sources) => {
    const observation = sources.authorityChecks?.find((item) => item.requirement === stepId) ?? {};
    return {
      mutationKind: observation.mutationKind,
      expectedMutationKind: mutationKind,
      assignmentId: observation.assignmentId,
      attemptId: observation.attemptId,
      approvedBindingSha256: observation.approvedBindingSha256,
      attemptedBindingSha256: observation.attemptedBindingSha256,
      rejectionCode: observation.rejectionCode,
      expectedRejectionCode: rejectionCode,
      durableStateBeforeSha256: observation.durableStateBeforeSha256,
      durableStateAfterSha256: observation.durableStateAfterSha256,
      leaseSequence: observation.leaseSequence,
      fencingToken: observation.fencingToken,
      assignmentStateAtSubmission: observation.assignmentStateAtSubmission,
      leaseReceiptId: observation.leaseReceiptId,
      leaseTokenFingerprint: observation.leaseTokenFingerprint,
      leaseExpiresAt: observation.leaseExpiresAt,
      baselineValid: observation.baselineValid,
      mutatedField: observation.mutatedField,
      routeIdentity: observation.routeIdentity,
      durableCountsBefore: observation.durableCountsBefore,
      durableCountsAfter: observation.durableCountsAfter,
    };
  });
const cancelledAssignmentClaim = () =>
  exactFacts("authority.cancelled_assignment_claim_rejected", (sources) => {
    const observation =
      sources.authorityChecks?.find((item) => item.requirement === "authority.cancelled_assignment_claim_rejected") ??
      {};
    return {
      mutationKind: observation.mutationKind,
      expectedMutationKind: "cancelled_assignment_claim",
      assignmentId: observation.assignmentId,
      attemptId: observation.attemptId,
      missionId: observation.missionId,
      agentId: observation.agentId,
      assignmentStateBeforeCancellation: observation.assignmentStateBeforeCancellation,
      assignmentStateAfterCancellation: observation.assignmentStateAfterCancellation,
      assignmentStateAtSubmission: observation.assignmentStateAtSubmission,
      assignmentStateAfterRejection: observation.assignmentStateAfterRejection,
      assignmentRecordStatusBeforeCancellation: observation.assignmentRecordStatusBeforeCancellation,
      assignmentRecordStatusAfterCancellation: observation.assignmentRecordStatusAfterCancellation,
      assignmentRecordStatusAtSubmission: observation.assignmentRecordStatusAtSubmission,
      assignmentRecordStatusAfterRejection: observation.assignmentRecordStatusAfterRejection,
      cancellationCommandIdentitySha256: observation.cancellationCommandIdentitySha256,
      cancellationEventIdentitySha256: observation.cancellationEventIdentitySha256,
      cancellationEvents: observation.cancellationEvents,
      claimCommandIdentitySha256: observation.claimCommandIdentitySha256,
      topLevelCode: observation.topLevelCode,
      expectedTopLevelCode: "validation_failed",
      rejectionCode: observation.rejectionCode,
      expectedRejectionCode: "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
      durableStateBeforeSha256: observation.durableStateBeforeSha256,
      durableStateAfterSha256: observation.durableStateAfterSha256,
      durableCountsBefore: observation.durableCountsBefore,
      durableCountsAfter: observation.durableCountsAfter,
      leaseReceiptIdBefore: observation.leaseReceiptIdBefore,
      leaseReceiptIdAfter: observation.leaseReceiptIdAfter,
      fencingTokenBefore: observation.fencingTokenBefore,
      fencingTokenAfter: observation.fencingTokenAfter,
      providerInvocationCountBefore: observation.providerInvocationCountBefore,
      providerInvocationCountAfter: observation.providerInvocationCountAfter,
      positiveCompanion: observation.positiveCompanion,
    };
  });
const runtimeProfile = (stepId: string, provider: string, profileId: string) =>
  exactFacts(stepId, (sources) => {
    const profile = sources.runtimeProfiles?.find((item) => item.profileId === profileId) ?? {};
    return {
      provider: profile.provider,
      expectedProvider: provider,
      profileId: profile.profileId,
      expectedProfileId: profileId,
      catalogVersion: profile.catalogVersion,
      profileHash: profile.profileHash,
      expectedProfileHash: profile.expectedProfileHash ?? profile.profileHash,
      runtimeBindingHash: profile.runtimeBindingHash,
      expectedRuntimeBindingHash: profile.expectedRuntimeBindingHash ?? profile.runtimeBindingHash,
      providerCliVersion: profile.providerCliVersion,
      executableSha256: profile.invokedExecutableSha256,
      sandboxPolicySha256: profile.sandboxPolicySha256,
    };
  });
const sourceCheckpoint = (stepId: string, checkpoint: string) =>
  exactFacts(stepId, (sources) => {
    const observation = sources.sourceCheckpoints?.find((item) => item.checkpoint === checkpoint) ?? {};
    return {
      checkpoint: observation.checkpoint,
      expectedCheckpoint: checkpoint,
      checkpointId: observation.checkpoint_id,
      sourceAcceptanceRunId: observation.acceptance_run_id,
      actionBinding: observation.action_binding,
      authorityBinding: observation.authority_binding,
      manifestSha256: observation.manifest_sha256,
      manifestCanonicalSha256: observation.manifest_canonical_sha256,
      governedFileCount: observation.governed_file_count,
      verificationOutcome: observation.result,
      missingFiles: observation.missing_files,
      unexpectedFiles: observation.unexpected_files,
      changedFiles: observation.changed_files,
      invalidFileTypes: observation.invalid_file_types,
      bindingHash: observation.binding_hash,
    };
  });
const adversarialRejection = (stepId: string, sourceKey: string, mutationKind: string, rejectionCode: string) =>
  exactFacts(stepId, (sources) => {
    const observation = sources.adversarial?.[sourceKey] ?? {};
    return {
      mutationKind: observation.mutationKind,
      expectedMutationKind: mutationKind,
      rejectionCode: observation.rejectionCode,
      expectedRejectionCode: rejectionCode,
      attemptedValueSha256: observation.attemptedValueSha256,
      approvedValueSha256: observation.approvedValueSha256,
      providerInvocationCountBefore: observation.providerInvocationCountBefore,
      providerInvocationCountAfter: observation.providerInvocationCountAfter,
      durableStateBeforeSha256: observation.durableStateBeforeSha256,
      durableStateAfterSha256: observation.durableStateAfterSha256,
    };
  });
const diagnosticEvidence = (stepId: string, sourceKey: string) =>
  exactFacts(stepId, (sources) => ({
    evidenceMode: sources.diagnostics?.evidenceMode,
    applicability: sources.diagnostics?.applicability,
    observations: sources.diagnostics?.[sourceKey],
  }));

export const preReviewProducerRegistrations: readonly Registration[] = Object.freeze([
  exactHash("packet.artifact", "observed.sha256", "artifactSha256"),
  exactHash("packet.artifact_metadata", "observed.artifactMetadataSha256", "artifactMetadataSha256"),
  exactHash("packet.capability_manifest", "observed.capabilityManifestSha256", "capabilityManifestSha256"),
  exactHash(
    "packet.source_manifest",
    "observed.acceptanceSourceManifestCanonicalSha256",
    "acceptanceSourceManifestSha256",
  ),
  exactHash("packet.acceptance_contract", "observed.acceptanceContractCanonicalSha256", "acceptanceContractSha256"),
  exactFacts("registry.exact_hash", (sources, context) => ({
    actualSha256: sources.packet.registryContentHash,
    expectedSha256: context.candidateBindings.disposableRegistrySha256,
  })),
  exactFacts("registry.validity_window", (sources, context) => ({
    validFrom: sources.registry.issuedAt ?? sources.registry.valid_from,
    expiresAt: sources.registry.expiresAt ?? sources.registry.expires_at,
    observedAt: context.observedAt,
    scope: sources.registry.scope,
    expectedScope:
      sources.registry.authority === "non_authenticated_candidate_validation"
        ? "non_authenticated_candidate_validation"
        : "consensus_real_provider_acceptance",
  })),
  exactFacts("registry.contract_hash", (sources, context) => ({
    actualSha256: sources.packet.approvedPacket?.acceptanceContractCanonicalSha256,
    expectedSha256: context.candidateBindings.acceptanceContractSha256,
  })),
  exactFacts("agent.codex_authenticated", (sources, context) => ({
    ...agentFacts(sources, "codex"),
    expectedArtifactSha256: context.candidateBindings.artifactSha256,
    expectedRegistrySha256: context.candidateBindings.disposableRegistrySha256,
  })),
  exactFacts("agent.claude_code_authenticated", (sources, context) => ({
    ...agentFacts(sources, "claude_code"),
    expectedArtifactSha256: context.candidateBindings.artifactSha256,
    expectedRegistrySha256: context.candidateBindings.disposableRegistrySha256,
  })),
  exactFacts("agent.capability_attestation_exact", (sources) => ({
    agents: (sources.preflight.agents ?? []).map((agent: any) => ({
      agentId: agent.agentId,
      capabilityAttestationId: agent.capabilityAttestationId,
      capabilityAttestationHash: agent.capabilityAttestationHash,
    })),
  })),
  exactFacts("repository.authenticated_registration", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    authenticatedRegistrations: sources.preflight.repository?.authenticatedRegistrations,
    expectedRegistrations: 2,
  })),
  exactFacts("repository.same_identity", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    identityVersion: sources.preflight.repository?.identityVersion,
    fingerprint: sources.preflight.repository?.fingerprint,
    assignmentRepositoryIds: (sources.preflight.assignments ?? []).map(
      (item: any) => item.repositoryId ?? sources.preflight.repositoryId,
    ),
  })),
  exactFacts("repository.same_snapshot", (sources, context) => ({
    snapshotArtifactId: sources.preflight.repository?.snapshotArtifactId,
    actualSnapshotSha256: sources.preflight.repository?.snapshotHash,
    locallyRecomputedSha256: sources.preflight.repository?.snapshotHash,
    expectedSnapshotSha256: context.candidateBindings.repositorySnapshotSha256,
  })),
  exactFacts("project_brain.initialized_context", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    contextBound: sources.preflight.repository?.projectBrainContextBound,
    contextArtifactId: sources.preflight.repository?.snapshotArtifactId,
  })),
  exactFacts("project_brain.governed_context_pack", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    contextBound: sources.preflight.repository?.projectBrainContextBound,
    contextHash: sources.preflight.repository?.stateHash,
    snapshotHash: sources.preflight.repository?.snapshotHash,
  })),
  assignment("models.planner_a_claude_fable_5", "planner_a", "claude_code", "claude-fable-5"),
  assignment("models.planner_b_gpt_5_6_sol", "planner_b", "codex", "gpt-5.6-sol"),
  assignment("models.synthesizer_claude_fable_5", "synthesizer", "claude_code", "claude-fable-5"),
  assignment("models.executor_gpt_5_6_luna", "executor", "codex", "gpt-5.6-luna"),
  exactFacts("models.implementation_reviewer_disabled", (sources) => ({
    actualMode: sources.preflight.implementationReviewer,
    expectedMode: "disabled",
    reviewerAssignments: (sources.preflight.assignments ?? [])
      .filter((item: any) => item.role === "implementation_reviewer")
      .map((item: any) => ({ role: item.role, provider: item.provider, model: item.model })),
    expectedAssignmentCount: 0,
  })),
  exactFacts("models.fallback_disabled", (sources) => ({
    noFallback: sources.preflight.noFallback,
    assignments: (sources.preflight.assignments ?? []).map((item: any) => ({
      role: item.role,
      provider: item.provider,
      model: item.model,
      fallback: item.fallback,
    })),
    expectedAssignments: [
      { role: "planner_a", provider: "claude_code", model: "claude-fable-5", fallback: "disabled" },
      { role: "planner_b", provider: "codex", model: "gpt-5.6-sol", fallback: "disabled" },
      { role: "synthesizer", provider: "claude_code", model: "claude-fable-5", fallback: "disabled" },
      { role: "executor", provider: "codex", model: "gpt-5.6-luna", fallback: "disabled" },
    ],
    expectedAssignmentCount: 4,
    expectedFallback: "disabled",
  })),
  exactFacts("repository.canonical_path", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    registeredPath: sources.repositoryRuntime?.registeredPath,
    canonicalPath: sources.repositoryRuntime?.canonicalPath,
    pathIdentitySha256: sources.repositoryRuntime?.pathIdentitySha256,
  })),
  exactFacts("repository.isolated_executor_worktree", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    sourcePath: sources.repositoryRuntime?.canonicalPath,
    worktreePath: sources.repositoryRuntime?.executorWorktreePath,
    repositoryPermission: sources.repositoryRuntime?.executorRepositoryPermission,
    expectedRepositoryPermission: "isolated_worktree_write",
    worktreeGitCommonDir: sources.repositoryRuntime?.executorWorktreeGitCommonDir,
    sourceGitCommonDir: sources.repositoryRuntime?.sourceGitCommonDir,
  })),
  exactFacts("repository.source_unchanged", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    headBefore: sources.repositoryRuntime?.sourceHeadBefore,
    headAfter: sources.repositoryRuntime?.sourceHeadAfter,
    trackedStateBeforeSha256: sources.repositoryRuntime?.sourceTrackedStateBeforeSha256,
    trackedStateAfterSha256: sources.repositoryRuntime?.sourceTrackedStateAfterSha256,
  })),
  exactFacts("repository.planning_push_disabled", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    planningAssignments: (sources.preflight.assignments ?? [])
      .filter((item: any) => item.role !== "executor")
      .map((item: any) => ({
        role: item.role,
        repositoryPermission: item.repositoryPermission,
        pushAllowed: item.pushAllowed,
      })),
    expectedRoles: ["planner_a", "planner_b", "synthesizer"],
    expectedRepositoryPermission: "read",
    expectedPushAllowed: false,
  })),
  repositoryFact("repository.mission_agent_local_commit_allowed", "missionAgentLocalCommitAllowed", true),
  repositoryFact("repository.provider_direct_commit_denied", "providerDirectCommitAllowed", false),
  repositoryFact("repository.push_denied", "pushAllowed", false),
  repositoryFact("repository.pull_request_denied", "pullRequestAllowed", false),
  repositoryFact("repository.publication_denied", "publicationAllowed", false),
  repositoryFact("repository.deployment_denied", "deploymentAllowed", false),
  repositoryFact("repository.infrastructure_denied", "infrastructureMutationAllowed", false),
  exactFacts("repository.generic_write_does_not_imply_push", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    genericWriteAllowed: sources.preflight.repository?.genericWriteAllowed,
    genericCommitAllowed: sources.preflight.repository?.genericCommitAllowed,
    isolatedWorktreeWriteAllowed: sources.preflight.repository?.isolatedWorktreeWriteAllowed,
    pushAllowed: sources.preflight.repository?.pushAllowed,
  })),
  exactFacts("repository.authority_replay_idempotent", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    commandId: sources.repositoryAuthority?.receipt?.command_id,
    firstAuthorityHash: sources.repositoryRuntime?.authorityReplay?.firstAuthorityHash,
    replayedAuthorityHash: sources.repositoryRuntime?.authorityReplay?.replayedAuthorityHash,
    receiptCountBeforeReplay: sources.repositoryRuntime?.authorityReplay?.receiptCountBeforeReplay,
    receiptCountAfterReplay: sources.repositoryRuntime?.authorityReplay?.receiptCountAfterReplay,
  })),
  exactFacts("repository.authority_downgrade_rejected", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    approvedAuthorityHash: sources.preflight.repository?.repositoryAuthorityHash,
    proposedAuthorityHash: sources.repositoryRuntime?.authorityDowngrade?.proposedAuthorityHash,
    approvedImplementationAgentIds:
      sources.repositoryAuthority?.projection?.repository_authority?.implementationAgentIds,
    proposedImplementationAgentIds: sources.repositoryRuntime?.authorityDowngrade?.proposedImplementationAgentIds,
    matchingApprovalReceiptCount: sources.repositoryRuntime?.authorityDowngrade?.matchingApprovalReceiptCount,
  })),
  exactFacts("repository.authority_expansion_requires_approval", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    approvedAuthorityHash: sources.preflight.repository?.repositoryAuthorityHash,
    proposedAuthorityHash: sources.repositoryRuntime?.authorityExpansion?.proposedAuthorityHash,
    approvedImplementationAgentIds:
      sources.repositoryAuthority?.projection?.repository_authority?.implementationAgentIds,
    proposedImplementationAgentIds: sources.repositoryRuntime?.authorityExpansion?.proposedImplementationAgentIds,
    matchingApprovalReceiptCount: sources.repositoryRuntime?.authorityExpansion?.matchingApprovalReceiptCount,
  })),
  exactFacts("repository.child_authority_not_broadened", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    parentAuthorityHash: sources.preflight.repository?.repositoryAuthorityHash,
    childAuthorityHash: sources.repositoryRuntime?.childAuthorityHash,
    parentImplementationAgentIds: sources.repositoryAuthority?.projection?.repository_authority?.implementationAgentIds,
    childImplementationAgentIds: sources.repositoryRuntime?.childImplementationAgentIds,
  })),
  exactFacts("repository.push_enabled_preflight_fails", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    mutatedField: sources.repositoryRuntime?.pushEnabledProbe?.mutatedField,
    mutatedValue: sources.repositoryRuntime?.pushEnabledProbe?.mutatedValue,
    rejectionCode: sources.repositoryRuntime?.pushEnabledProbe?.rejectionCode,
    expectedRejectionCode: "REPOSITORY_PROHIBITED_AUTHORITY",
  })),
  exactFacts("repository.push_disabled_preflight_passes", (sources) => ({
    repositoryId: sources.preflight.repositoryId,
    pushAllowed: sources.preflight.repository?.pushAllowed,
    authorityHash: sources.preflight.repository?.repositoryAuthorityHash,
    authenticatedAuthorityReceipts: sources.preflight.repository?.authenticatedAuthorityReceipts,
    expectedPushAllowed: false,
  })),
  authorityRejection(
    "authority.changed_executable_rejected",
    "executable_identity",
    "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED",
  ),
  authorityRejection(
    "authority.changed_runtime_profile_rejected",
    "runtime_profile",
    "ASSIGNMENT_RUNTIME_PROFILE_CHANGED",
  ),
  authorityRejection(
    "authority.changed_authentication_binding_rejected",
    "authentication_binding",
    "ASSIGNMENT_AUTHENTICATION_BINDING_CHANGED",
  ),
  authorityRejection(
    "authority.changed_repository_authority_rejected",
    "repository_authority",
    "ASSIGNMENT_REPOSITORY_AUTHORITY_CHANGED",
  ),
  authorityRejection(
    "authority.expired_capability_attestation_rejected",
    "capability_attestation_expiry",
    "CAPABILITY_ATTESTATION_EXPIRED",
  ),
  authorityRejection("authority.stale_lease_rejected", "lease_sequence", "ASSIGNMENT_LEASE_STALE"),
  authorityRejection("authority.stale_fencing_token_rejected", "fencing_token", "ASSIGNMENT_FENCING_TOKEN_STALE"),
  authorityRejection("authority.lease_loss_rejects_output", "lease_loss_output", "ASSIGNMENT_LEASE_LOST"),
  authorityRejection(
    "authority.delayed_provider_output_rejected",
    "delayed_provider_output",
    "DELAYED_PROVIDER_OUTPUT_REJECTED",
  ),
  authorityRejection("authority.conflicting_receipt_rejected", "conflicting_receipt", "CONFLICTING_RECEIPT_REJECTED"),
  cancelledAssignmentClaim(),
  runtimeProfile("runtime.claude_implementation_macos_v2", "claude_code", "claude-implementation-macos-v2"),
  runtimeProfile("runtime.claude_planning_macos_v2", "claude_code", "claude-planning-macos-v2"),
  runtimeProfile("runtime.codex_implementation_macos_v2", "codex", "codex-implementation-macos-v2"),
  runtimeProfile("runtime.codex_planning_macos_v2", "codex", "codex-planning-macos-v2"),
  sourceCheckpoint("source.before_mission_creation", "before_mission_creation"),
  sourceCheckpoint("source.before_human_approval", "before_human_approval"),
  sourceCheckpoint("source.before_child_creation", "before_child_creation"),
  sourceCheckpoint("source.before_executor_claim", "before_executor_claim"),
  exactFacts("workflow.preflight", (sources) => ({
    classification: sources.preflight.classification,
    expectedClassification: "READY",
    runtimeMode: sources.preflight.server?.runtimeMode,
    expectedRuntimeMode: "disposable_acceptance",
    registryContentHash: sources.preflight.server?.registryContentHash,
    expectedRegistryContentHash: sources.workflow?.disposableRegistrySha256,
    repositoryId: sources.preflight.repositoryId,
    expectedRepositoryId: sources.workflow?.repositoryId,
    agentIds: (sources.preflight.agents ?? []).map((agent: any) => agent.agentId).sort(),
    assignmentRoles: (sources.preflight.assignments ?? []).map((assignment: any) => assignment.role).sort(),
    expectedAssignmentRoles: ["executor", "planner_a", "planner_b", "synthesizer"],
    noFallback: sources.preflight.noFallback,
    productionResourcesAllowed: sources.preflight.server?.productionResourcesAllowed,
  })),
  exactFacts("workflow.mission_creation", (sources) => ({
    missionId: sources.workflow?.missionId,
    repositoryId: sources.workflow?.repositoryId,
    repositorySnapshotSha256: sources.workflow?.repositorySnapshotSha256,
    contextPackSha256: sources.workflow?.contextPackSha256,
    lifecycleState: sources.workflow?.missionLifecycleState,
    expectedLifecycleState: "awaiting_human_approval",
  })),
  exactFacts("workflow.proposal_rounds", (sources) => ({
    missionId: sources.workflow?.missionId,
    proposals: sources.workflow?.proposals,
    expectedProposalCount: 2,
  })),
  exactFacts("workflow.canonical_synthesis", (sources) => ({
    missionId: sources.workflow?.missionId,
    canonicalPlanArtifactId: sources.workflow?.canonicalPlanArtifactId,
    canonicalPlanSha256: sources.workflow?.canonicalPlanSha256,
    synthesisAssignmentId: sources.workflow?.synthesisAssignmentId,
  })),
  exactFacts("workflow.human_approval", (sources) => ({
    missionId: sources.workflow?.missionId,
    approvalId: sources.workflow?.approvalId,
    approvedPlanSha256: sources.workflow?.approvedPlanSha256,
    durableApprovalCount: sources.workflow?.durableApprovalCount,
    actorId: sources.workflow?.approvalActorId,
  })),
  exactFacts("workflow.child_creation", (sources) => ({
    parentMissionId: sources.workflow?.missionId,
    childMissionId: sources.workflow?.childMissionId,
    approvedPlanSha256: sources.workflow?.approvedPlanSha256,
    childApprovedPlanSha256: sources.workflow?.childApprovedPlanSha256,
    childCreationCount: sources.workflow?.childCreationCount,
  })),
  exactFacts("workflow.executor_claim", (sources) => ({
    childMissionId: sources.workflow?.childMissionId,
    executionId: sources.workflow?.executionId,
    assignmentId: sources.workflow?.assignmentId,
    agentId: sources.workflow?.executorAgentId,
    provider: sources.workflow?.executorProvider,
    model: sources.workflow?.executorModel,
    leaseSequence: sources.workflow?.leaseSequence,
    fencingToken: sources.workflow?.fencingToken,
  })),
  exactFacts("workflow.child_success", (sources) => ({
    childMissionId: sources.workflow?.childMissionId,
    lifecycleState: sources.workflow?.childLifecycleState,
    expectedLifecycleState: "succeeded",
    commitId: sources.workflow?.commitId,
    validationReceiptSha256: sources.workflow?.validationReceiptSha256,
  })),
  exactFacts("workflow.durable_evidence", (sources) => ({
    childMissionId: sources.workflow?.childMissionId,
    commitId: sources.workflow?.commitId,
    patchSha256: sources.workflow?.patchSha256,
    validationReceiptSha256: sources.workflow?.validationReceiptSha256,
    evidenceArtifactId: sources.workflow?.implementationEvidenceArtifactId,
  })),
  exactFacts("workflow.independent_proposals_same_snapshot", (sources) => ({
    missionId: sources.workflow?.missionId,
    expectedSnapshotSha256: sources.workflow?.repositorySnapshotSha256,
    proposals: sources.workflow?.proposals,
  })),
  exactFacts("workflow.critiques_same_context", (sources) => ({
    missionId: sources.workflow?.missionId,
    expectedContextPackSha256: sources.workflow?.contextPackSha256,
    critiques: sources.workflow?.critiques,
    expectedCritiqueCount: 2,
  })),
  exactFacts("workflow.revisions_same_plan_identity", (sources) => ({
    missionId: sources.workflow?.missionId,
    expectedPlanIdentitySha256: sources.workflow?.canonicalPlanSha256,
    revisions: sources.workflow?.revisions,
    expectedRevisionCount: 2,
  })),
  exactFacts("workflow.canonical_verdict_exact_hash", (sources) => ({
    missionId: sources.workflow?.missionId,
    canonicalPlanSha256: sources.workflow?.canonicalPlanSha256,
    verdicts: sources.workflow?.verdicts,
    expectedVerdictCount: 2,
  })),
  exactFacts("workflow.single_human_approval", (sources) => ({
    missionId: sources.workflow?.missionId,
    approvalId: sources.workflow?.approvalId,
    durableApprovalCount: sources.workflow?.durableApprovalCount,
    childCreationCount: sources.workflow?.childCreationCount,
  })),
  exactFacts("workflow.child_authority_inheritance", (sources) => ({
    parentMissionId: sources.workflow?.missionId,
    childMissionId: sources.workflow?.childMissionId,
    parentRepositoryAuthoritySha256: sources.workflow?.parentRepositoryAuthoritySha256,
    childRepositoryAuthoritySha256: sources.workflow?.childRepositoryAuthoritySha256,
  })),
  exactFacts("workflow.executor_exact_assignment", (sources) => ({
    assignmentId: sources.workflow?.assignmentId,
    assignedAgentId: sources.workflow?.executorAgentId,
    claimedAgentId: sources.workflow?.claimedAgentId,
    assignedProvider: sources.workflow?.executorProvider,
    claimedProvider: sources.workflow?.claimedProvider,
    assignedModel: sources.workflow?.executorModel,
    claimedModel: sources.workflow?.claimedModel,
  })),
  exactFacts("workflow.durable_success_receipt", (sources) => ({
    childMissionId: sources.workflow?.childMissionId,
    assignmentId: sources.workflow?.assignmentId,
    commitId: sources.workflow?.commitId,
    validationReceiptSha256: sources.workflow?.validationReceiptSha256,
    receiptArtifactId: sources.workflow?.implementationEvidenceArtifactId,
  })),
  exactFacts("workflow.project_brain_learning_candidate_only", (sources) => ({
    missionId: sources.workflow?.missionId,
    learningArtifactId: sources.workflow?.learningArtifactId,
    disposition: sources.workflow?.learningDisposition,
    expectedDisposition: "proposed",
    curatedKnowledgeWriteCount: sources.workflow?.curatedKnowledgeWriteCount,
  })),
  exactFacts("adversarial.credential_free_artifact_preflight", (sources, context) => ({
    artifactSha256: sources.adversarial?.credentialFreeArtifactPreflight?.artifactSha256,
    expectedArtifactSha256: context.candidateBindings.artifactSha256,
    processExitCode: sources.adversarial?.credentialFreeArtifactPreflight?.exitCode,
    stdoutSha256: sources.adversarial?.credentialFreeArtifactPreflight?.stdoutSha256,
    credentialReferenceCount: sources.adversarial?.credentialFreeArtifactPreflight?.credentialReferenceCount,
  })),
  exactFacts("adversarial.changed_model_rejected", (sources) => ({
    assignmentRole: sources.adversarial?.changedModelAssignment?.assignmentRole,
    originalProvider: sources.adversarial?.changedModelAssignment?.originalProvider,
    originalModel: sources.adversarial?.changedModelAssignment?.originalModel,
    attemptedProvider: sources.adversarial?.changedModelAssignment?.attemptedProvider,
    attemptedModel: sources.adversarial?.changedModelAssignment?.attemptedModel,
    rejectionCode: sources.adversarial?.changedModelAssignment?.rejectionCode,
    rejectedBeforeProviderInvocation: sources.adversarial?.changedModelAssignment?.rejectedBeforeProviderInvocation,
    fallbackOccurred: sources.adversarial?.changedModelAssignment?.fallbackOccurred,
    durableStateBeforeSha256: sources.adversarial?.changedModelAssignment?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.adversarial?.changedModelAssignment?.durableStateAfterSha256,
  })),
  exactFacts("adversarial.malformed_proposal_rejected", (sources) => ({
    artifactKind: sources.adversarial?.malformedProposal?.artifactKind,
    proposalSchemaVersion: sources.adversarial?.malformedProposal?.schemaVersion,
    mutationPath: sources.adversarial?.malformedProposal?.mutationPath,
    rejectionCode: sources.adversarial?.malformedProposal?.rejectionCode,
    providerInvocationCountBefore: sources.adversarial?.malformedProposal?.providerInvocationCountBefore,
    providerInvocationCountAfter: sources.adversarial?.malformedProposal?.providerInvocationCountAfter,
    durableStateBeforeSha256: sources.adversarial?.malformedProposal?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.adversarial?.malformedProposal?.durableStateAfterSha256,
  })),
  adversarialRejection(
    "adversarial.malformed_critique_rejected",
    "malformedCritique",
    "critique_schema",
    "MALFORMED_CONSENSUS_CRITIQUE",
  ),
  adversarialRejection(
    "adversarial.malformed_revision_rejected",
    "malformedRevision",
    "revision_schema",
    "MALFORMED_CONSENSUS_REVISION",
  ),
  adversarialRejection(
    "adversarial.malformed_synthesis_rejected",
    "malformedSynthesis",
    "synthesis_schema",
    "MALFORMED_CANONICAL_SYNTHESIS",
  ),
  adversarialRejection(
    "adversarial.malformed_verdict_rejected",
    "malformedVerdict",
    "verdict_schema",
    "MALFORMED_CANONICAL_VERDICT",
  ),
  adversarialRejection(
    "adversarial.wrong_consensus_state_rejected",
    "wrongConsensusState",
    "consensus_state",
    "CONSENSUS_STATE_MISMATCH",
  ),
  adversarialRejection(
    "adversarial.wrong_repository_snapshot_rejected",
    "wrongRepositorySnapshot",
    "repository_snapshot",
    "REPOSITORY_SNAPSHOT_MISMATCH",
  ),
  adversarialRejection(
    "adversarial.wrong_context_pack_rejected",
    "wrongContextPack",
    "context_pack",
    "CONTEXT_PACK_MISMATCH",
  ),
  adversarialRejection(
    "adversarial.wrong_artifact_hash_rejected",
    "wrongArtifactHash",
    "artifact_hash",
    "ARTIFACT_HASH_MISMATCH",
  ),
  exactFactsV2("adversarial.wrong_canonical_plan_hash_rejected", (sources) => ({
    observation: sources.adversarial?.wrongCanonicalPlanHash,
    approvedValueSha256: sources.adversarial?.wrongCanonicalPlanHash?.approvedValueSha256,
    attemptedValueSha256: sources.adversarial?.wrongCanonicalPlanHash?.attemptedValueSha256,
    rejectionCode: sources.adversarial?.wrongCanonicalPlanHash?.actualRejectionCode,
    expectedRejectionCode: "CANONICAL_PLAN_HASH_MISMATCH",
    durableStateBeforeSha256: sources.adversarial?.wrongCanonicalPlanHash?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.adversarial?.wrongCanonicalPlanHash?.durableStateAfterSha256,
  })),
  exactFacts("adversarial.duplicate_message_idempotent", (sources) => ({
    messageId: sources.adversarial?.duplicateMessage?.messageId,
    bodySha256: sources.adversarial?.duplicateMessage?.bodySha256,
    firstReceiptSha256: sources.adversarial?.duplicateMessage?.firstReceiptSha256,
    replayReceiptSha256: sources.adversarial?.duplicateMessage?.replayReceiptSha256,
    durableEventCountBeforeReplay: sources.adversarial?.duplicateMessage?.durableEventCountBeforeReplay,
    durableEventCountAfterReplay: sources.adversarial?.duplicateMessage?.durableEventCountAfterReplay,
  })),
  exactFactsV2("adversarial.repository_drift_rejected", (sources) => ({
    observation: sources.adversarial?.repositoryDrift,
    approvedValueSha256: sources.adversarial?.repositoryDrift?.approvedValueSha256,
    attemptedValueSha256: sources.adversarial?.repositoryDrift?.attemptedValueSha256,
    rejectionCode: sources.adversarial?.repositoryDrift?.actualRejectionCode,
    expectedRejectionCode: "REPOSITORY_DRIFT_REJECTED",
    durableStateBeforeSha256: sources.adversarial?.repositoryDrift?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.adversarial?.repositoryDrift?.durableStateAfterSha256,
  })),
  exactFactsV2("adversarial.source_closure_mutation_matrix", (sources) => ({
    observation: sources.adversarial?.sourceClosureMutation,
    cases: sources.adversarial?.sourceClosureMutation?.cases,
    expectedMutationKinds: [
      "changed_file",
      "added_file",
      "deleted_file",
      "symlink_substitution",
      "file_type_substitution",
    ],
  })),
  exactFactsV2("adversarial.checkpoint_identity_and_reuse", (sources) => ({
    observation: sources.adversarial?.checkpointMisuse,
    cases: sources.adversarial?.checkpointMisuse?.cases,
    expectedMisuseKinds: ["wrong_run", "wrong_candidate", "wrong_phase", "wrong_action", "reuse", "stale_identity"],
  })),
  exactFacts("adversarial.provider_lifecycle_matrix", (sources) => ({
    observations: (sources.adversarial?.realProviderLifecycle ?? []).map((item: any) => ({
      provider: item.provider,
      profileId: item.profileId,
      operationClass: item.operationClass,
      probe: item.probe,
      requestedModel: item.requestedModel,
      exitCode: item.exitCode,
      terminationSignal: item.terminationSignal,
      timedOut: item.timedOut,
      cancellationRequested: item.cancellationRequested,
      processTreeTerminationAttempted: item.processTreeTerminationAttempted,
      processGroupAliveAfterTermination: item.processGroupAliveAfterTermination,
    })),
    expectedObservationCount: 8,
  })),
  diagnosticEvidence("diagnostic.exact_model_argument", "exactModelArgument"),
  diagnosticEvidence("diagnostic.runtime_identity_honesty", "runtimeIdentityHonesty"),
  diagnosticEvidence("diagnostic.process_tree_terminated", "processTreeTerminated"),
  diagnosticEvidence("diagnostic.secret_redaction", "secretRedaction"),
  exactFactsV4("recovery.provider_restart", (sources) => ({
    observation: sources.recovery?.providerRestart,
    assignmentId: sources.recovery?.providerRestart?.assignmentId,
    assignmentAttemptBefore: sources.recovery?.providerRestart?.assignmentAttemptBefore,
    assignmentAttemptAfter: sources.recovery?.providerRestart?.assignmentAttemptAfter,
    firstProviderAttemptId: sources.recovery?.providerRestart?.firstProviderAttemptId,
    restartedProviderAttemptId: sources.recovery?.providerRestart?.restartedProviderAttemptId,
    leaseIdBefore: sources.recovery?.providerRestart?.leaseIdBefore,
    leaseIdAfter: sources.recovery?.providerRestart?.leaseIdAfter,
    leaseFingerprintBefore: sources.recovery?.providerRestart?.leaseFingerprintBefore,
    leaseFingerprintAfter: sources.recovery?.providerRestart?.leaseFingerprintAfter,
    fencingTokenBefore: sources.recovery?.providerRestart?.fencingTokenBefore,
    fencingTokenAfter: sources.recovery?.providerRestart?.fencingTokenAfter,
    durableStateBeforeSha256: sources.recovery?.providerRestart?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.recovery?.providerRestart?.durableStateAfterSha256,
  })),
  exactFactsV3("recovery.mission_control_restart", (sources) => ({
    observation: sources.recovery?.missionControlRestart,
    acceptanceRunIdBefore: sources.recovery?.missionControlRestart?.acceptanceRunIdBefore,
    acceptanceRunIdAfter: sources.recovery?.missionControlRestart?.acceptanceRunIdAfter,
    canonicalEventSetSha256Before: sources.recovery?.missionControlRestart?.canonicalEventSetSha256Before,
    canonicalEventSetSha256After: sources.recovery?.missionControlRestart?.canonicalEventSetSha256After,
    projectionSha256Before: sources.recovery?.missionControlRestart?.projectionSha256Before,
    projectionSha256After: sources.recovery?.missionControlRestart?.projectionSha256After,
  })),
  exactFactsV2("recovery.lease_loss", (sources) => ({
    observation: sources.recovery?.leaseLoss,
    assignmentId: sources.recovery?.leaseLoss?.assignmentId,
    attemptId: sources.recovery?.leaseLoss?.attemptId,
    leaseSequence: sources.recovery?.leaseLoss?.leaseSequence,
    fencingToken: sources.recovery?.leaseLoss?.fencingToken,
    outputReceiptSha256: sources.recovery?.leaseLoss?.outputReceiptSha256,
    rejectionCode: sources.recovery?.leaseLoss?.rejectionCode,
    expectedRejectionCode: "ASSIGNMENT_LEASE_LOST",
    durableStateBeforeSha256: sources.recovery?.leaseLoss?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.recovery?.leaseLoss?.durableStateAfterSha256,
  })),
  exactFactsV2("recovery.delayed_output", (sources) => ({
    observation: sources.recovery?.delayedOutput,
    assignmentId: sources.recovery?.delayedOutput?.assignmentId,
    attemptId: sources.recovery?.delayedOutput?.attemptId,
    completedAttemptId: sources.recovery?.delayedOutput?.completedAttemptId,
    outputReceiptSha256: sources.recovery?.delayedOutput?.outputReceiptSha256,
    rejectionCode: sources.recovery?.delayedOutput?.rejectionCode,
    expectedRejectionCode: "DELAYED_PROVIDER_OUTPUT_REJECTED",
    durableStateBeforeSha256: sources.recovery?.delayedOutput?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.recovery?.delayedOutput?.durableStateAfterSha256,
  })),
  exactFactsV2("recovery.conflicting_receipt", (sources) => ({
    observation: sources.recovery?.conflictingReceipt,
    assignmentId: sources.recovery?.conflictingReceipt?.assignmentId,
    acceptedReceiptSha256: sources.recovery?.conflictingReceipt?.acceptedReceiptSha256,
    conflictingReceiptSha256: sources.recovery?.conflictingReceipt?.conflictingReceiptSha256,
    rejectionCode: sources.recovery?.conflictingReceipt?.rejectionCode,
    expectedRejectionCode: "CONFLICTING_RECEIPT_REJECTED",
    durableStateBeforeSha256: sources.recovery?.conflictingReceipt?.durableStateBeforeSha256,
    durableStateAfterSha256: sources.recovery?.conflictingReceipt?.durableStateAfterSha256,
  })),
  exactFactsV2("isolation.production_resources_rejected", (sources) => ({
    observation: sources.isolation?.productionResourceRejection,
    runtimeMode: sources.isolation?.productionResourceRejection?.runtimeMode,
    expectedRuntimeMode: "disposable_acceptance",
    productionResourcesAllowed: sources.isolation?.productionResourceRejection?.productionAuthority,
    productionResourceProbeCount: sources.isolation?.productionResourceRejection ? 1 : 0,
    rejectedProbeCount:
      sources.isolation?.productionResourceRejection?.actualRejectionCode === "PRODUCTION_RESOURCE_FORBIDDEN" ? 1 : 0,
  })),
  exactFactsV2("isolation.disposable_database_only", (sources) => ({
    observation: sources.isolation?.disposableDatabaseIsolation,
    databaseIdentitySha256: sources.isolation?.disposableDatabaseIsolation?.actualDatabaseIdentitySha256,
    disposableDatabaseIdentitySha256: sources.isolation?.disposableDatabaseIsolation?.expectedDatabaseIdentitySha256,
    productionDatabaseIdentitySha256: sources.isolation?.disposableDatabaseIsolation?.forbiddenDatabaseIdentitySha256,
    databaseScope: sources.isolation?.disposableDatabaseIsolation?.databaseScope,
    expectedDatabaseScope: "disposable",
  })),
  exactFacts("isolation.provider_writable_roots_bounded", (sources) => ({
    observations: sources.isolation?.filesystemWriteObservations,
    acceptanceRunId: sources.isolation?.filesystemWriteAcceptanceRunId,
    candidateArtifactSha256: sources.isolation?.filesystemWriteCandidateArtifactSha256,
    observedWritableRoots: sources.isolation?.observedWritableRoots,
    approvedWritableRoots: sources.isolation?.approvedWritableRoots,
    deniedWriteProbeCount: sources.isolation?.deniedWriteProbeCount,
    escapedWriteCount: sources.isolation?.escapedWriteCount,
  })),
  exactFacts("isolation.repository_mutation_isolated", (sources) => ({
    sourceRepositoryStateBeforeSha256: sources.isolation?.sourceRepositoryStateBeforeSha256,
    sourceRepositoryStateAfterSha256: sources.isolation?.sourceRepositoryStateAfterSha256,
    executorWorktreeStateBeforeSha256: sources.isolation?.executorWorktreeStateBeforeSha256,
    executorWorktreeStateAfterSha256: sources.isolation?.executorWorktreeStateAfterSha256,
    mutationPath: sources.isolation?.mutationPath,
    approvedWorktreePath: sources.isolation?.approvedWorktreePath,
  })),
  exactFacts("replay.projections_deleted", (sources) => ({
    workspaceId: sources.replay?.workspaceId,
    liveProjectionSha256: sources.replay?.liveProjectionSha256,
    deletionReceiptSha256: sources.replay?.deletionReceiptSha256,
    projectionRowsBeforeDelete: sources.replay?.projectionRowsBeforeDelete,
    projectionRowsAfterDelete: sources.replay?.projectionRowsAfterDelete,
  })),
  exactFacts("replay.projections_rebuilt", (sources) => ({
    workspaceId: sources.replay?.workspaceId,
    canonicalEventSetSha256: sources.replay?.canonicalEventSetSha256,
    rebuildReceiptSha256: sources.replay?.rebuildReceiptSha256,
    projectionRowsAfterDelete: sources.replay?.projectionRowsAfterDelete,
    projectionRowsAfterRebuild: sources.replay?.projectionRowsAfterRebuild,
  })),
  exactFacts("replay.live_equals_replay", (sources) => ({
    workspaceId: sources.replay?.workspaceId,
    liveProjectionSha256: sources.replay?.liveProjectionSha256,
    replayedProjectionSha256: sources.replay?.replayedProjectionSha256,
    comparisonReceiptSha256: sources.replay?.comparisonReceiptSha256,
  })),
  exactFacts("secrets.exact_credential_scan", (sources) => ({
    scanArtifactSha256: sources.secrets?.scanArtifactSha256,
    scannedByteCount: sources.secrets?.scannedByteCount,
    exactCredentialMatches: sources.secrets?.exactCredentialMatches,
  })),
  exactFacts("secrets.credential_pattern_scan", (sources) => ({
    scanArtifactSha256: sources.secrets?.scanArtifactSha256,
    scannedByteCount: sources.secrets?.scannedByteCount,
    credentialPatternMatches: sources.secrets?.credentialPatternMatches,
  })),
  exactFacts("secrets.lease_token_pattern_scan", (sources) => ({
    scanArtifactSha256: sources.secrets?.scanArtifactSha256,
    scannedByteCount: sources.secrets?.scannedByteCount,
    rawLeaseTokenPatternMatches: sources.secrets?.rawLeaseTokenPatternMatches,
  })),
  exactFacts("secrets.forbidden_lease_token_key_scan", (sources) => ({
    scanArtifactSha256: sources.secrets?.scanArtifactSha256,
    scannedByteCount: sources.secrets?.scannedByteCount,
    forbiddenLeaseTokenKeys: sources.secrets?.forbiddenLeaseTokenKeys,
  })),
]);
function agentFacts(sources: Sources, provider: string) {
  const agent = sources.preflight.agents?.find((item: any) => item.provider === provider) ?? {};
  return {
    provider: agent.provider,
    expectedProvider: provider,
    agentId: agent.agentId,
    artifactSha256: agent.artifactSha256,
    registrySha256: agent.registryHash,
    authenticatedCredentialEvents: agent.authenticatedCredentialEvents,
    authenticatedHeartbeatCurrent: agent.authenticatedHeartbeatCurrent,
    capabilityAttestationId: agent.capabilityAttestationId,
    capabilityAttestationHash: agent.capabilityAttestationHash,
  };
}
export const preReviewProducerByStep = new Map(preReviewProducerRegistrations.map((item) => [item.stepId, item]));
export function producePreReviewEvidence(stepId: string, sources: Sources, context: Context) {
  const registration = preReviewProducerByStep.get(stepId);
  if (!registration) throw new Error(`Explicit pre-review producer is unmapped: ${stepId}`);
  return registration.produce(sources, context);
}
export function validateProducedPreReviewEvidence(
  stepId: string,
  details: unknown,
  context: { acceptanceRunId: string; candidateBindings: AcceptanceCandidateBindings },
) {
  const registration = preReviewProducerByStep.get(stepId),
    value = details as Record<string, any>;
  const reasons: string[] = [];
  const hash = (candidate: unknown) => /^[a-f0-9]{64}$/.test(String(candidate));
  const id = (candidate: unknown) => /^[0-9a-f-]{36}$/i.test(String(candidate));
  const time = (candidate: unknown) => Number.isFinite(Date.parse(String(candidate)));
  const observation = value?.observation as Record<string, any> | undefined;
  if (!registration) return ["REQUIREMENT_SPECIFIC_SEMANTIC_VALIDATOR_UNMAPPED"];
  if (!value || value.producerId !== registration.producerId || value.schemaVersion !== registration.schemaId)
    reasons.push("PRODUCER_SCHEMA_BINDING_INVALID");
  if (
    value?.acceptanceRunId !== context.acceptanceRunId ||
    value?.candidateIdentitySha256 !== canonicalHash(context.candidateBindings)
  )
    reasons.push("PRODUCER_RUN_CANDIDATE_BINDING_INVALID");
  const exactHashSteps = [
    "packet.artifact",
    "packet.artifact_metadata",
    "packet.capability_manifest",
    "packet.source_manifest",
    "packet.acceptance_contract",
    "registry.exact_hash",
    "registry.contract_hash",
  ];
  if (
    exactHashSteps.includes(stepId) &&
    (value.actualSha256 !== value.expectedSha256 || !/^[a-f0-9]{64}$/.test(String(value.actualSha256)))
  )
    reasons.push("EXACT_HASH_MISMATCH");
  if (
    stepId === "registry.validity_window" &&
    !(
      Date.parse(value.validFrom) <= Date.parse(value.observedAt) &&
      Date.parse(value.observedAt) < Date.parse(value.expiresAt) &&
      value.scope === value.expectedScope
    )
  )
    reasons.push("REGISTRY_WINDOW_INVALID");
  if (
    stepId.startsWith("agent.") &&
    stepId !== "agent.capability_attestation_exact" &&
    !(
      value.provider === value.expectedProvider &&
      value.artifactSha256 === value.expectedArtifactSha256 &&
      value.registrySha256 === value.expectedRegistrySha256 &&
      value.authenticatedCredentialEvents > 0 &&
      value.authenticatedHeartbeatCurrent === true &&
      value.agentId &&
      value.capabilityAttestationId &&
      /^[a-f0-9]{64}$/.test(String(value.capabilityAttestationHash))
    )
  )
    reasons.push("AGENT_AUTHENTICATION_BINDING_INVALID");
  if (
    stepId === "agent.capability_attestation_exact" &&
    !(
      Array.isArray(value.agents) &&
      value.agents.length === 2 &&
      value.agents.every(
        (agent: any) =>
          agent.agentId &&
          agent.capabilityAttestationId &&
          /^[a-f0-9]{64}$/.test(String(agent.capabilityAttestationHash)),
      )
    )
  )
    reasons.push("CAPABILITY_ATTESTATION_INVALID");
  if (
    stepId === "repository.authenticated_registration" &&
    !(value.repositoryId && value.authenticatedRegistrations === value.expectedRegistrations)
  )
    reasons.push("REPOSITORY_REGISTRATION_INVALID");
  if (
    stepId === "repository.same_identity" &&
    !(
      value.repositoryId &&
      value.identityVersion &&
      value.fingerprint &&
      value.assignmentRepositoryIds?.every((id: string) => id === value.repositoryId)
    )
  )
    reasons.push("REPOSITORY_IDENTITY_MISMATCH");
  if (
    stepId === "repository.same_snapshot" &&
    !(
      value.snapshotArtifactId &&
      value.actualSnapshotSha256 === value.locallyRecomputedSha256 &&
      value.actualSnapshotSha256 === value.expectedSnapshotSha256
    )
  )
    reasons.push("REPOSITORY_SNAPSHOT_MISMATCH");
  if (
    stepId.startsWith("project_brain.") &&
    !(
      value.repositoryId &&
      value.contextBound === true &&
      (value.contextArtifactId || (value.contextHash && value.snapshotHash))
    )
  )
    reasons.push("PROJECT_BRAIN_CONTEXT_INVALID");
  if (
    stepId.startsWith("models.") &&
    !["models.implementation_reviewer_disabled", "models.fallback_disabled"].includes(stepId) &&
    !(
      value.role === value.expectedRole &&
      value.provider === value.expectedProvider &&
      value.model === value.expectedModel &&
      value.fallback === value.expectedFallback &&
      value.agentId &&
      value.capabilityAttestationId
    )
  )
    reasons.push("MODEL_ASSIGNMENT_MISMATCH");
  if (
    stepId === "models.implementation_reviewer_disabled" &&
    !(
      value.actualMode === value.expectedMode &&
      Array.isArray(value.reviewerAssignments) &&
      value.reviewerAssignments.length === value.expectedAssignmentCount
    )
  )
    reasons.push("IMPLEMENTATION_REVIEWER_NOT_DISABLED");
  if (
    stepId === "models.fallback_disabled" &&
    !(
      value.noFallback === true &&
      Array.isArray(value.assignments) &&
      value.assignments.length === value.expectedAssignmentCount &&
      value.assignments.every(
        (item: any) => item.role && item.provider && item.model && item.fallback === value.expectedFallback,
      ) &&
      canonicalHash(value.assignments) === canonicalHash(value.expectedAssignments)
    )
  )
    reasons.push("MODEL_FALLBACK_NOT_DISABLED");
  if (
    stepId === "repository.canonical_path" &&
    !(
      value.repositoryId &&
      value.registeredPath &&
      value.registeredPath === value.canonicalPath &&
      String(value.canonicalPath).startsWith("/") &&
      /^[a-f0-9]{64}$/.test(String(value.pathIdentitySha256))
    )
  )
    reasons.push("REPOSITORY_CANONICAL_PATH_INVALID");
  if (
    stepId === "repository.isolated_executor_worktree" &&
    !(
      value.repositoryId &&
      value.worktreePath &&
      value.sourcePath &&
      value.worktreePath !== value.sourcePath &&
      value.repositoryPermission === value.expectedRepositoryPermission &&
      value.worktreeGitCommonDir &&
      value.worktreeGitCommonDir === value.sourceGitCommonDir
    )
  )
    reasons.push("EXECUTOR_WORKTREE_ISOLATION_INVALID");
  if (
    stepId === "repository.source_unchanged" &&
    !(
      value.repositoryId &&
      value.headBefore &&
      value.headBefore === value.headAfter &&
      value.trackedStateBeforeSha256 &&
      value.trackedStateBeforeSha256 === value.trackedStateAfterSha256
    )
  )
    reasons.push("SOURCE_REPOSITORY_CHANGED");
  if (
    stepId === "repository.planning_push_disabled" &&
    !(
      value.repositoryId &&
      Array.isArray(value.planningAssignments) &&
      canonicalHash(value.planningAssignments.map((item: any) => item.role).sort()) ===
        canonicalHash([...value.expectedRoles].sort()) &&
      value.planningAssignments.every(
        (item: any) =>
          item.repositoryPermission === value.expectedRepositoryPermission &&
          item.pushAllowed === value.expectedPushAllowed,
      )
    )
  )
    reasons.push("PLANNING_PUSH_AUTHORITY_INVALID");
  if (
    [
      "repository.mission_agent_local_commit_allowed",
      "repository.provider_direct_commit_denied",
      "repository.push_denied",
      "repository.pull_request_denied",
      "repository.publication_denied",
      "repository.deployment_denied",
      "repository.infrastructure_denied",
    ].includes(stepId) &&
    !(
      value.repositoryId &&
      /^[a-f0-9]{64}$/.test(String(value.authorityHash)) &&
      value.actualValue === value.expectedValue
    )
  )
    reasons.push("REPOSITORY_AUTHORITY_FACT_MISMATCH");
  if (
    stepId === "repository.generic_write_does_not_imply_push" &&
    !(
      value.repositoryId &&
      value.genericWriteAllowed === false &&
      value.genericCommitAllowed === false &&
      value.isolatedWorktreeWriteAllowed === true &&
      value.pushAllowed === false
    )
  )
    reasons.push("GENERIC_WRITE_AUTHORITY_INVALID");
  if (
    stepId === "repository.authority_replay_idempotent" &&
    !(
      value.repositoryId &&
      value.commandId &&
      value.firstAuthorityHash === value.replayedAuthorityHash &&
      /^[a-f0-9]{64}$/.test(String(value.firstAuthorityHash)) &&
      value.receiptCountBeforeReplay === 1 &&
      value.receiptCountAfterReplay === 1
    )
  )
    reasons.push("AUTHORITY_REPLAY_NOT_IDEMPOTENT");
  if (
    ["repository.authority_downgrade_rejected", "repository.authority_expansion_requires_approval"].includes(stepId) &&
    !(
      value.repositoryId &&
      /^[a-f0-9]{64}$/.test(String(value.approvedAuthorityHash)) &&
      /^[a-f0-9]{64}$/.test(String(value.proposedAuthorityHash)) &&
      value.approvedAuthorityHash !== value.proposedAuthorityHash &&
      Array.isArray(value.approvedImplementationAgentIds) &&
      value.approvedImplementationAgentIds.length > 0 &&
      Array.isArray(value.proposedImplementationAgentIds) &&
      value.proposedImplementationAgentIds.length > 0 &&
      canonicalHash(value.approvedImplementationAgentIds) !== canonicalHash(value.proposedImplementationAgentIds) &&
      value.matchingApprovalReceiptCount === 0
    )
  )
    reasons.push("AUTHORITY_CHANGE_NOT_REJECTED");
  if (
    stepId === "repository.child_authority_not_broadened" &&
    !(
      value.repositoryId &&
      value.parentAuthorityHash === value.childAuthorityHash &&
      /^[a-f0-9]{64}$/.test(String(value.parentAuthorityHash)) &&
      Array.isArray(value.parentImplementationAgentIds) &&
      Array.isArray(value.childImplementationAgentIds) &&
      canonicalHash(value.parentImplementationAgentIds) === canonicalHash(value.childImplementationAgentIds)
    )
  )
    reasons.push("CHILD_AUTHORITY_BROADENED");
  if (
    stepId === "repository.push_enabled_preflight_fails" &&
    !(
      value.repositoryId &&
      value.mutatedField === "pushAllowed" &&
      value.mutatedValue === true &&
      value.rejectionCode === value.expectedRejectionCode
    )
  )
    reasons.push("PUSH_ENABLED_PREFLIGHT_NOT_REJECTED");
  if (
    stepId === "repository.push_disabled_preflight_passes" &&
    !(
      value.repositoryId &&
      value.pushAllowed === value.expectedPushAllowed &&
      /^[a-f0-9]{64}$/.test(String(value.authorityHash)) &&
      value.authenticatedAuthorityReceipts >= 1
    )
  )
    reasons.push("PUSH_DISABLED_PREFLIGHT_INVALID");
  if (
    stepId === "authority.cancelled_assignment_claim_rejected" &&
    !(
      value.mutationKind === value.expectedMutationKind &&
      value.topLevelCode === value.expectedTopLevelCode &&
      value.rejectionCode === value.expectedRejectionCode &&
      /^[0-9a-f-]{36}$/i.test(String(value.assignmentId)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.attemptId)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.agentId)) &&
      value.assignmentStateBeforeCancellation === "available" &&
      value.assignmentStateAfterCancellation === "cancelled" &&
      value.assignmentStateAtSubmission === "cancelled" &&
      value.assignmentStateAfterRejection === "cancelled" &&
      value.assignmentRecordStatusBeforeCancellation === "available" &&
      value.assignmentRecordStatusAfterCancellation === "completed" &&
      value.assignmentRecordStatusAtSubmission === "completed" &&
      value.assignmentRecordStatusAfterRejection === "completed" &&
      [
        value.cancellationCommandIdentitySha256,
        value.cancellationEventIdentitySha256,
        value.claimCommandIdentitySha256,
      ].every((item) => /^[a-f0-9]{64}$/.test(String(item))) &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256 &&
      canonicalHash(value.durableCountsBefore) === canonicalHash(value.durableCountsAfter) &&
      value.durableCountsBefore?.assignment_status === "completed" &&
      value.durableCountsBefore?.execution_status === "cancelled" &&
      Number(value.durableCountsBefore?.validation_receipt_count) === 0 &&
      Number(value.durableCountsBefore?.artifact_count) === 0 &&
      Number(value.durableCountsBefore?.provider_diagnostic_count) === 0 &&
      value.durableCountsBefore?.lease_owner === null &&
      value.durableCountsBefore?.lease_expires_at === null &&
      value.durableCountsBefore?.lease_token_hash === null &&
      value.durableCountsBefore?.lease_token_fingerprint === null &&
      value.durableCountsBefore?.claimed_at === null &&
      value.leaseReceiptIdBefore === null &&
      value.leaseReceiptIdAfter === null &&
      Number(value.fencingTokenBefore) === 0 &&
      Number(value.fencingTokenAfter) === 0 &&
      value.providerInvocationCountBefore === value.providerInvocationCountAfter &&
      value.positiveCompanion?.claimable === true &&
      value.positiveCompanion?.assignmentStateAtSubmission === "available" &&
      /^[0-9a-f-]{36}$/i.test(String(value.positiveCompanion?.leaseReceiptId)) &&
      Number(value.positiveCompanion?.fencingToken) === 1 &&
      Array.isArray(value.cancellationEvents) &&
      value.cancellationEvents.length === 2 &&
      value.cancellationEvents[0]?.event_type === "execution.cancellation_requested" &&
      value.cancellationEvents[1]?.event_type === "execution.cancelled" &&
      value.cancellationEvents.every(
        (event: Record<string, unknown>) =>
          event.aggregate_id === value.attemptId && /^[0-9a-f-]{36}$/i.test(String(event.event_id)),
      ) &&
      Number(value.cancellationEvents[1]?.aggregate_version) > Number(value.cancellationEvents[0]?.aggregate_version) &&
      /^[0-9a-f-]{36}$/i.test(String(value.positiveCompanion?.assignmentId))
    )
  )
    reasons.push("CANCELLED_ASSIGNMENT_CLAIM_EVIDENCE_INVALID");
  if (
    stepId.startsWith("authority.") &&
    stepId !== "authority.cancelled_assignment_claim_rejected" &&
    !(
      value.mutationKind === value.expectedMutationKind &&
      value.rejectionCode === value.expectedRejectionCode &&
      /^[0-9a-f-]{36}$/i.test(String(value.assignmentId)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.attemptId)) &&
      /^[a-f0-9]{64}$/.test(String(value.approvedBindingSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.attemptedBindingSha256)) &&
      value.approvedBindingSha256 !== value.attemptedBindingSha256 &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256 &&
      Number.isSafeInteger(value.leaseSequence) &&
      value.leaseSequence > 0 &&
      Number.isSafeInteger(value.fencingToken) &&
      value.fencingToken > 0 &&
      (![
        "executable_identity",
        "runtime_profile",
        "authentication_binding",
        "repository_authority",
        "capability_attestation_expiry",
        "lease_sequence",
        "fencing_token",
      ].includes(String(value.mutationKind)) ||
        (value.assignmentStateAtSubmission === "acknowledged" &&
          /^[0-9a-f-]{36}$/i.test(String(value.leaseReceiptId)) &&
          /^[a-f0-9]{64}$/.test(String(value.leaseTokenFingerprint)) &&
          Number.isFinite(Date.parse(String(value.leaseExpiresAt))) &&
          value.baselineValid === true &&
          typeof value.mutatedField === "string" &&
          value.routeIdentity === "agent-protocol.messages.POST/active-execution-fence/1" &&
          canonicalHash(value.durableCountsBefore) === canonicalHash(value.durableCountsAfter) &&
          !JSON.stringify(value).includes("mc_lease_")))
    )
  )
    reasons.push("AUTHORITY_REJECTION_EVIDENCE_INVALID");
  if (
    stepId.startsWith("runtime.") &&
    !(
      value.provider === value.expectedProvider &&
      value.profileId === value.expectedProfileId &&
      value.profileHash === value.expectedProfileHash &&
      value.runtimeBindingHash === value.expectedRuntimeBindingHash &&
      typeof value.catalogVersion === "string" &&
      value.catalogVersion.length > 0 &&
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value.providerCliVersion)) &&
      [value.profileHash, value.runtimeBindingHash, value.executableSha256, value.sandboxPolicySha256].every((hash) =>
        /^[a-f0-9]{64}$/.test(String(hash)),
      )
    )
  )
    reasons.push("RUNTIME_PROFILE_EVIDENCE_INVALID");
  if (
    stepId.startsWith("source.") &&
    !(
      value.checkpoint === value.expectedCheckpoint &&
      value.sourceAcceptanceRunId === context.acceptanceRunId &&
      /^[0-9a-f-]{36}$/i.test(String(value.checkpointId)) &&
      value.actionBinding &&
      Object.keys(value.actionBinding).length > 0 &&
      value.authorityBinding &&
      Object.keys(value.authorityBinding).length > 0 &&
      [value.manifestSha256, value.manifestCanonicalSha256, value.bindingHash].every((hash) =>
        /^[a-f0-9]{64}$/.test(String(hash)),
      ) &&
      Number.isSafeInteger(value.governedFileCount) &&
      value.governedFileCount > 0 &&
      value.verificationOutcome === "pass" &&
      [value.missingFiles, value.unexpectedFiles, value.changedFiles, value.invalidFileTypes].every(
        (items) => Array.isArray(items) && items.length === 0,
      )
    )
  )
    reasons.push("SOURCE_CHECKPOINT_EVIDENCE_INVALID");
  if (
    stepId === "workflow.preflight" &&
    !(
      value.classification === value.expectedClassification &&
      value.runtimeMode === value.expectedRuntimeMode &&
      /^[a-f0-9]{64}$/.test(String(value.registryContentHash)) &&
      value.registryContentHash === value.expectedRegistryContentHash &&
      value.repositoryId &&
      value.repositoryId === value.expectedRepositoryId &&
      Array.isArray(value.agentIds) &&
      value.agentIds.length === 2 &&
      new Set(value.agentIds).size === 2 &&
      canonicalHash(value.assignmentRoles) === canonicalHash(value.expectedAssignmentRoles) &&
      value.noFallback === true &&
      value.productionResourcesAllowed === false
    )
  )
    reasons.push("WORKFLOW_PREFLIGHT_EVIDENCE_INVALID");
  if (
    stepId === "workflow.mission_creation" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      value.repositoryId &&
      /^[a-f0-9]{64}$/.test(String(value.repositorySnapshotSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.contextPackSha256)) &&
      value.lifecycleState === value.expectedLifecycleState
    )
  )
    reasons.push("MISSION_CREATION_EVIDENCE_INVALID");
  if (
    stepId === "workflow.proposal_rounds" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      Array.isArray(value.proposals) &&
      value.proposals.length === value.expectedProposalCount &&
      new Set(value.proposals.map((item: any) => item.assignmentId)).size === value.expectedProposalCount &&
      value.proposals.every(
        (item: any) => item.artifactId && item.assignmentId && /^[a-f0-9]{64}$/.test(String(item.artifactSha256)),
      )
    )
  )
    reasons.push("PROPOSAL_ROUND_EVIDENCE_INVALID");
  if (
    stepId === "workflow.canonical_synthesis" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      value.canonicalPlanArtifactId &&
      /^[a-f0-9]{64}$/.test(String(value.canonicalPlanSha256)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.synthesisAssignmentId))
    )
  )
    reasons.push("CANONICAL_SYNTHESIS_EVIDENCE_INVALID");
  if (
    stepId === "workflow.human_approval" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.approvalId)) &&
      /^[a-f0-9]{64}$/.test(String(value.approvedPlanSha256)) &&
      value.durableApprovalCount === 1 &&
      value.actorId
    )
  )
    reasons.push("HUMAN_APPROVAL_EVIDENCE_INVALID");
  if (
    stepId === "workflow.child_creation" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.parentMissionId)) &&
      /^[0-9a-f-]{36}$/i.test(String(value.childMissionId)) &&
      value.parentMissionId !== value.childMissionId &&
      value.approvedPlanSha256 === value.childApprovedPlanSha256 &&
      /^[a-f0-9]{64}$/.test(String(value.approvedPlanSha256)) &&
      value.childCreationCount === 1
    )
  )
    reasons.push("CHILD_CREATION_EVIDENCE_INVALID");
  if (
    stepId === "workflow.executor_claim" &&
    !(
      [value.childMissionId, value.executionId, value.assignmentId, value.agentId].every((id) =>
        /^[0-9a-f-]{36}$/i.test(String(id)),
      ) &&
      value.provider &&
      value.model &&
      Number.isSafeInteger(value.leaseSequence) &&
      value.leaseSequence > 0 &&
      Number.isSafeInteger(value.fencingToken) &&
      value.fencingToken > 0
    )
  )
    reasons.push("EXECUTOR_CLAIM_EVIDENCE_INVALID");
  if (
    stepId === "workflow.child_success" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.childMissionId)) &&
      value.lifecycleState === value.expectedLifecycleState &&
      /^[a-f0-9]{40,64}$/.test(String(value.commitId)) &&
      /^[a-f0-9]{64}$/.test(String(value.validationReceiptSha256))
    )
  )
    reasons.push("CHILD_SUCCESS_EVIDENCE_INVALID");
  if (
    stepId === "workflow.durable_evidence" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.childMissionId)) &&
      /^[a-f0-9]{40,64}$/.test(String(value.commitId)) &&
      /^[a-f0-9]{64}$/.test(String(value.patchSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.validationReceiptSha256)) &&
      value.evidenceArtifactId
    )
  )
    reasons.push("DURABLE_IMPLEMENTATION_EVIDENCE_INVALID");
  if (
    stepId === "workflow.independent_proposals_same_snapshot" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      /^[a-f0-9]{64}$/.test(String(value.expectedSnapshotSha256)) &&
      Array.isArray(value.proposals) &&
      value.proposals.length === 2 &&
      new Set(value.proposals.map((item: any) => item.assignmentId)).size === 2 &&
      value.proposals.every((item: any) => item.repositorySnapshotSha256 === value.expectedSnapshotSha256)
    )
  )
    reasons.push("PROPOSAL_SNAPSHOT_BINDING_INVALID");
  if (
    stepId === "workflow.critiques_same_context" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      /^[a-f0-9]{64}$/.test(String(value.expectedContextPackSha256)) &&
      Array.isArray(value.critiques) &&
      value.critiques.length === value.expectedCritiqueCount &&
      new Set(value.critiques.map((item: any) => item.assignmentId)).size === value.expectedCritiqueCount &&
      value.critiques.every((item: any) => item.contextPackSha256 === value.expectedContextPackSha256)
    )
  )
    reasons.push("CRITIQUE_CONTEXT_BINDING_INVALID");
  if (
    stepId === "workflow.revisions_same_plan_identity" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      /^[a-f0-9]{64}$/.test(String(value.expectedPlanIdentitySha256)) &&
      Array.isArray(value.revisions) &&
      value.revisions.length === value.expectedRevisionCount &&
      new Set(value.revisions.map((item: any) => item.assignmentId)).size === value.expectedRevisionCount &&
      value.revisions.every((item: any) => item.planIdentitySha256 === value.expectedPlanIdentitySha256)
    )
  )
    reasons.push("REVISION_PLAN_BINDING_INVALID");
  if (
    stepId === "workflow.canonical_verdict_exact_hash" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.missionId)) &&
      /^[a-f0-9]{64}$/.test(String(value.canonicalPlanSha256)) &&
      Array.isArray(value.verdicts) &&
      value.verdicts.length === value.expectedVerdictCount &&
      value.verdicts.every(
        (item: any) =>
          ["approve", "approve_with_non_blocking_notes"].includes(item.decision) &&
          item.canonicalPlanSha256 === value.canonicalPlanSha256,
      )
    )
  )
    reasons.push("CANONICAL_VERDICT_BINDING_INVALID");
  if (
    stepId === "workflow.single_human_approval" &&
    !(value.missionId && value.approvalId && value.durableApprovalCount === 1 && value.childCreationCount === 1)
  )
    reasons.push("SINGLE_HUMAN_APPROVAL_INVALID");
  if (
    stepId === "workflow.child_authority_inheritance" &&
    !(
      value.parentMissionId &&
      value.childMissionId &&
      value.parentMissionId !== value.childMissionId &&
      /^[a-f0-9]{64}$/.test(String(value.parentRepositoryAuthoritySha256)) &&
      value.parentRepositoryAuthoritySha256 === value.childRepositoryAuthoritySha256
    )
  )
    reasons.push("CHILD_AUTHORITY_INHERITANCE_INVALID");
  if (
    stepId === "workflow.executor_exact_assignment" &&
    !(
      value.assignmentId &&
      value.assignedAgentId === value.claimedAgentId &&
      value.assignedProvider === value.claimedProvider &&
      value.assignedModel === value.claimedModel &&
      value.assignedAgentId &&
      value.assignedProvider &&
      value.assignedModel
    )
  )
    reasons.push("EXECUTOR_ASSIGNMENT_BINDING_INVALID");
  if (
    stepId === "workflow.durable_success_receipt" &&
    !(
      value.childMissionId &&
      value.assignmentId &&
      /^[a-f0-9]{40,64}$/.test(String(value.commitId)) &&
      /^[a-f0-9]{64}$/.test(String(value.validationReceiptSha256)) &&
      value.receiptArtifactId
    )
  )
    reasons.push("DURABLE_SUCCESS_RECEIPT_INVALID");
  if (
    stepId === "workflow.project_brain_learning_candidate_only" &&
    !(
      value.missionId &&
      value.learningArtifactId &&
      value.disposition === value.expectedDisposition &&
      value.curatedKnowledgeWriteCount === 0
    )
  )
    reasons.push("PROJECT_BRAIN_LEARNING_DISPOSITION_INVALID");
  if (
    stepId === "adversarial.credential_free_artifact_preflight" &&
    !(
      value.artifactSha256 === value.expectedArtifactSha256 &&
      /^[a-f0-9]{64}$/.test(String(value.artifactSha256)) &&
      value.processExitCode === 0 &&
      /^[a-f0-9]{64}$/.test(String(value.stdoutSha256)) &&
      value.credentialReferenceCount === 0
    )
  )
    reasons.push("CREDENTIAL_FREE_ARTIFACT_PREFLIGHT_INVALID");
  if (
    stepId === "adversarial.changed_model_rejected" &&
    !(
      value.assignmentRole &&
      value.originalProvider === value.attemptedProvider &&
      value.originalModel !== value.attemptedModel &&
      value.rejectionCode === "disposable_model_assignment_mismatch" &&
      value.rejectedBeforeProviderInvocation === true &&
      value.fallbackOccurred === false &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("CHANGED_MODEL_REJECTION_INVALID");
  if (
    stepId === "adversarial.malformed_proposal_rejected" &&
    !(
      value.artifactKind === "consensus_proposal" &&
      value.proposalSchemaVersion === "consensus-plan-proposal/1" &&
      value.mutationPath &&
      value.rejectionCode === "MALFORMED_CONSENSUS_PROPOSAL" &&
      value.providerInvocationCountBefore === value.providerInvocationCountAfter &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("MALFORMED_PROPOSAL_REJECTION_INVALID");
  const explicitAdversarialRejections = [
    "adversarial.malformed_critique_rejected",
    "adversarial.malformed_revision_rejected",
    "adversarial.malformed_synthesis_rejected",
    "adversarial.malformed_verdict_rejected",
    "adversarial.wrong_consensus_state_rejected",
    "adversarial.wrong_repository_snapshot_rejected",
    "adversarial.wrong_context_pack_rejected",
    "adversarial.wrong_artifact_hash_rejected",
  ];
  if (
    explicitAdversarialRejections.includes(stepId) &&
    !(
      value.mutationKind === value.expectedMutationKind &&
      value.rejectionCode === value.expectedRejectionCode &&
      /^[a-f0-9]{64}$/.test(String(value.attemptedValueSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.approvedValueSha256)) &&
      value.attemptedValueSha256 !== value.approvedValueSha256 &&
      value.providerInvocationCountBefore === value.providerInvocationCountAfter &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("ADVERSARIAL_REJECTION_EVIDENCE_INVALID");
  if (
    stepId === "adversarial.wrong_canonical_plan_hash_rejected" &&
    !(
      observation &&
      observation.mutationKind === "canonical_plan_hash" &&
      observation.protectedOperation &&
      observation.commandIdentity &&
      observation.actualTopLevelErrorCode === "validation_failed" &&
      observation.actualRejectionCode === "CANONICAL_PLAN_HASH_MISMATCH" &&
      observation.providerInvocationCountBefore === observation.providerInvocationCountAfter &&
      observation.verdictCountBefore === observation.verdictCountAfter &&
      observation.approvalCountBefore === observation.approvalCountAfter &&
      observation.childMissionCountBefore === observation.childMissionCountAfter &&
      value.rejectionCode === value.expectedRejectionCode &&
      hash(value.approvedValueSha256) &&
      hash(value.attemptedValueSha256) &&
      value.approvedValueSha256 !== value.attemptedValueSha256 &&
      hash(value.durableStateBeforeSha256) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("WRONG_CANONICAL_PLAN_HASH_OBSERVATION_INVALID");
  if (
    stepId === "adversarial.repository_drift_rejected" &&
    !(
      observation &&
      observation.mutationKind === "repository_drift" &&
      observation.repositoryId &&
      observation.mutationPath &&
      observation.protectedOperation &&
      observation.actualTopLevelErrorCode === "validation_failed" &&
      observation.actualRejectionCode === "REPOSITORY_DRIFT_REJECTED" &&
      observation.executionCountBefore === observation.executionCountAfter &&
      observation.childMissionCountBefore === observation.childMissionCountAfter &&
      observation.artifactCountBefore === observation.artifactCountAfter &&
      value.rejectionCode === value.expectedRejectionCode &&
      hash(value.approvedValueSha256) &&
      hash(value.attemptedValueSha256) &&
      value.approvedValueSha256 !== value.attemptedValueSha256 &&
      hash(value.durableStateBeforeSha256) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("REPOSITORY_DRIFT_OBSERVATION_INVALID");
  if (
    stepId === "adversarial.duplicate_message_idempotent" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.messageId)) &&
      /^[a-f0-9]{64}$/.test(String(value.bodySha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.firstReceiptSha256)) &&
      value.firstReceiptSha256 === value.replayReceiptSha256 &&
      value.durableEventCountBeforeReplay === value.durableEventCountAfterReplay
    )
  )
    reasons.push("DUPLICATE_MESSAGE_IDEMPOTENCY_INVALID");
  if (
    stepId === "adversarial.source_closure_mutation_matrix" &&
    !(
      Array.isArray(value.cases) &&
      value.cases.length === value.expectedMutationKinds.length &&
      observation?.sourceManifestSha256 &&
      canonicalHash(value.cases.map((item: any) => item.mutationKind).sort()) ===
        canonicalHash([...value.expectedMutationKinds].sort()) &&
      value.cases.every(
        (item: any) =>
          item.actualRejectionCode === "ACCEPTANCE_SOURCE_CLOSURE_FAILURE" &&
          hash(item.sourceStateBeforeSha256) &&
          hash(item.mutatedSourceStateSha256) &&
          item.sourceStateBeforeSha256 !== item.mutatedSourceStateSha256 &&
          item.protectedActionInvocations === 0 &&
          item.evidence?.result === "fail",
      )
    )
  )
    reasons.push("SOURCE_CLOSURE_MUTATION_MATRIX_INVALID");
  if (
    stepId === "adversarial.checkpoint_identity_and_reuse" &&
    !(
      observation &&
      Array.isArray(value.cases) &&
      value.cases.length === value.expectedMisuseKinds.length &&
      canonicalHash(value.cases.map((item: any) => item.misuseKind).sort()) ===
        canonicalHash([...value.expectedMisuseKinds].sort()) &&
      value.cases.every(
        (item: any) =>
          id(item.checkpointId) &&
          hash(item.bindingSha256) &&
          item.actualRejectionCode === "SOURCE_CHECKPOINT_REUSE_REJECTED" &&
          item.protectedActionInvocations === 0 &&
          hash(item.durableStateBeforeSha256) &&
          item.durableStateBeforeSha256 === item.durableStateAfterSha256,
      )
    )
  )
    reasons.push("SOURCE_CHECKPOINT_IDENTITY_INVALID");
  if (
    stepId === "adversarial.provider_lifecycle_matrix" &&
    !(
      Array.isArray(value.observations) &&
      value.observations.length === value.expectedObservationCount &&
      value.observations.every(
        (item: any) =>
          item.provider &&
          item.profileId &&
          item.operationClass &&
          ["timeout", "cancellation"].includes(item.probe) &&
          item.requestedModel &&
          item.processTreeTerminationAttempted === true &&
          item.processGroupAliveAfterTermination === false &&
          (item.probe === "timeout" ? item.timedOut === true : item.cancellationRequested === true),
      )
    )
  )
    reasons.push("PROVIDER_LIFECYCLE_MATRIX_INVALID");
  const diagnosticSteps = [
    "diagnostic.exact_model_argument",
    "diagnostic.runtime_identity_honesty",
    "diagnostic.process_tree_terminated",
    "diagnostic.secret_redaction",
  ];
  if (diagnosticSteps.includes(stepId)) {
    const expectedApplicability = [
      { role: "planner_a", provider: "claude_code", model: "claude-fable-5", profile: "claude-planning-macos-v2" },
      { role: "planner_b", provider: "codex", model: "gpt-5.6-sol", profile: "codex-planning-macos-v2" },
      { role: "synthesizer", provider: "claude_code", model: "claude-fable-5", profile: "claude-planning-macos-v2" },
      { role: "executor", provider: "codex", model: "gpt-5.6-luna", profile: "codex-implementation-macos-v2" },
    ];
    const applicabilityValid =
      Array.isArray(value.applicability) && canonicalHash(value.applicability) === canonicalHash(expectedApplicability);
    const observationsValid =
      Array.isArray(value.observations) &&
      value.observations.length === 4 &&
      value.observations.every((item: any, index: number) => {
        const expected = expectedApplicability[index];
        if (!(
          item.role === expected.role &&
          item.provider === expected.provider &&
          item.model === expected.model &&
          item.profile === expected.profile
        ))
          return false;
        if (value.evidenceMode === "mock_fixture") {
          if (stepId === "diagnostic.exact_model_argument")
            return item.modelArgument === expected.model && item.modelArgumentAccepted === true;
          if (stepId === "diagnostic.runtime_identity_honesty")
            return item.declaredRuntimeIdentity === "unverifiable" && item.independentlyVerifiable === false;
          if (stepId === "diagnostic.process_tree_terminated")
            return item.processTreeTerminationAttempted === true && item.processGroupAliveAfterTermination === false;
          return (
            item.exactCredentialMatches === 0 && item.credentialPatternMatches === 0 && item.redactionApplied === true
          );
        }
        const authenticatedRuntimeBindingValid =
          item.runtimeSource === "provider_runtime_diagnostic" &&
          [item.observationArtifactId, item.provenanceMessageId, item.assignmentId, item.executionId].every((id) =>
            /^[0-9a-f-]{36}$/i.test(String(id)),
          ) &&
          [item.observationSha256, item.runtimeProfileHash].every((hash) => /^[a-f0-9]{64}$/.test(String(hash))) &&
          typeof item.providerAttemptId === "string" &&
          item.providerAttemptId.length > 0;
        if (!authenticatedRuntimeBindingValid) return false;
        if (stepId === "diagnostic.exact_model_argument")
          return item.requestedModelArgument === expected.model && item.providerExitCode === 0;
        if (stepId === "diagnostic.runtime_identity_honesty")
          return item.declaredRuntimeIdentity === "unverifiable" && item.independentlyVerifiable === false;
        if (stepId === "diagnostic.process_tree_terminated") return item.processTreeTerminationVerified === true;
        return item.localSecretScan === "passed_exact_and_pattern" && item.serverSecretScan === "passed";
      });
    if (
      !applicabilityValid ||
      !observationsValid ||
      !["mock_fixture", "authenticated_runtime"].includes(value.evidenceMode)
    )
      reasons.push("DIAGNOSTIC_EVIDENCE_INVALID");
    if (value.evidenceMode === "mock_fixture") reasons.push("DEFERRED_TO_AUTHENTICATED_ACCEPTANCE");
  }
  if (
    stepId === "recovery.provider_restart" &&
    !(
      observation &&
      observation.originalProcessResourceId &&
      observation.replacementProcessResourceId &&
      observation.originalProcessResourceId !== observation.replacementProcessResourceId &&
      Number.isSafeInteger(observation.originalPid) &&
      Number.isSafeInteger(observation.replacementPid) &&
      observation.originalPid !== observation.replacementPid &&
      Number.isSafeInteger(observation.originalPgid) &&
      Number.isSafeInteger(observation.replacementPgid) &&
      hash(observation.originalProcessIdentitySha256) &&
      hash(observation.replacementProcessIdentitySha256) &&
      observation.originalProcessIdentitySha256 !== observation.replacementProcessIdentitySha256 &&
      observation.provider &&
      observation.model &&
      observation.runtimeProfile &&
      observation.terminationObserved === true &&
      observation.resumedOperationIdentity &&
      observation.resumedResultIdentity &&
      observation.staleOutputRejected === true &&
      observation.originalProcessStopped === true &&
      observation.authoritativeStateCoherent === true &&
      Array.isArray(observation.cleanupResourceIds) &&
      observation.cleanupResourceIds.includes(observation.originalProcessResourceId) &&
      observation.cleanupResourceIds.includes(observation.replacementProcessResourceId) &&
      /^[0-9a-f-]{36}$/i.test(String(value.assignmentId)) &&
      observation.assignmentId === value.assignmentId &&
      Number.isSafeInteger(value.assignmentAttemptBefore) &&
      value.assignmentAttemptBefore > 0 &&
      value.assignmentAttemptAfter === value.assignmentAttemptBefore &&
      typeof value.firstProviderAttemptId === "string" &&
      typeof value.restartedProviderAttemptId === "string" &&
      value.firstProviderAttemptId === `${value.assignmentAttemptBefore}-1` &&
      value.restartedProviderAttemptId === `${value.assignmentAttemptAfter}-2` &&
      id(value.leaseIdBefore) &&
      value.leaseIdAfter === value.leaseIdBefore &&
      hash(value.leaseFingerprintBefore) &&
      value.leaseFingerprintAfter === value.leaseFingerprintBefore &&
      Number.isSafeInteger(value.fencingTokenBefore) &&
      value.fencingTokenBefore > 0 &&
      value.fencingTokenAfter === value.fencingTokenBefore &&
      observation.providerProcessReceivedLeaseCredential === false &&
      observation.providerProcessReceivedFencingBinding === true &&
      ((Number.isSafeInteger(observation.originalExitCode) && observation.originalExitCode !== 0) ||
        (observation.originalExitCode === null &&
          typeof observation.originalTerminationSignal === "string" &&
          observation.originalTerminationSignal.length > 0)) &&
      observation.replacementExitCode === 0 &&
      hash(observation.originalStdoutSha256) &&
      hash(observation.replacementStdoutSha256) &&
      observation.selectedProviderAttemptId === value.restartedProviderAttemptId &&
      observation.resultArtifactProviderAttemptId === value.restartedProviderAttemptId &&
      observation.originalResultArtifactCount === 0 &&
      observation.replacementResultArtifactCount === 1 &&
      observation.authoritativeResultCountBefore === 0 &&
      observation.authoritativeResultCountAfter === 1 &&
      observation.duplicateAuthoritativeResultCount === 0 &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateAfterSha256)) &&
      value.durableStateBeforeSha256 !== value.durableStateAfterSha256
    )
  )
    reasons.push("PROVIDER_RESTART_RECOVERY_INVALID");
  if (
    stepId === "recovery.mission_control_restart" &&
    !(
      observation &&
      observation.serverResourceId &&
      observation.restartedServerResourceId &&
      observation.serverResourceId !== observation.restartedServerResourceId &&
      Number.isSafeInteger(observation.originalPid) &&
      Number.isSafeInteger(observation.restartedPid) &&
      observation.originalPid !== observation.restartedPid &&
      hash(observation.originalProcessIdentitySha256) &&
      hash(observation.restartedProcessIdentitySha256) &&
      hash(observation.executableIdentitySha256) &&
      hash(observation.restartedExecutableIdentitySha256) &&
      observation.executableIdentitySha256 === observation.restartedExecutableIdentitySha256 &&
      observation.originalListenerStopped === true &&
      observation.originalProcessTerminated === true &&
      observation.listenerResourceId &&
      observation.restartedListenerResourceId &&
      observation.listenerResourceId !== observation.restartedListenerResourceId &&
      time(observation.shutdownInitiatedAt) &&
      time(observation.shutdownCompletedAt) &&
      hash(observation.shutdownRequestIdentity) &&
      hash(observation.shutdownEvidenceIdentity) &&
      observation.readinessObserved === true &&
      observation.revalidation?.candidate === true &&
      observation.revalidation?.source === true &&
      observation.revalidation?.contract === true &&
      observation.revalidation?.registry === true &&
      observation.nextOperationResult?.applied === true &&
      observation.missionCountBefore === observation.missionCountAfter &&
      observation.artifactCountBefore === observation.artifactCountAfter &&
      observation.assignmentCountBefore === observation.assignmentCountAfter &&
      observation.eventContinuity === true &&
      Array.isArray(observation.cleanupResourceIds) &&
      [
        observation.serverResourceId,
        observation.restartedServerResourceId,
        observation.listenerResourceId,
        observation.restartedListenerResourceId,
      ].every((resourceId) => observation.cleanupResourceIds.includes(resourceId)) &&
      id(observation.missionId) &&
      value.acceptanceRunIdBefore === context.acceptanceRunId &&
      value.acceptanceRunIdAfter === context.acceptanceRunId &&
      /^[a-f0-9]{64}$/.test(String(value.canonicalEventSetSha256Before)) &&
      value.canonicalEventSetSha256Before === value.canonicalEventSetSha256After &&
      /^[a-f0-9]{64}$/.test(String(value.projectionSha256Before)) &&
      value.projectionSha256Before === value.projectionSha256After
    )
  )
    reasons.push("MISSION_CONTROL_RESTART_RECOVERY_INVALID");
  if (
    stepId === "recovery.lease_loss" &&
    !(
      observation &&
      observation.activeLeaseFingerprint &&
      observation.activeFencingIdentity &&
      observation.leaseLossEventIdentity &&
      observation.postLossSubmissionIdentity &&
      observation.actualRejectionCode === "ASSIGNMENT_LEASE_LOST" &&
      [value.assignmentId, value.attemptId].every((id) => /^[0-9a-f-]{36}$/i.test(String(id))) &&
      Number.isSafeInteger(value.leaseSequence) &&
      value.leaseSequence > 0 &&
      Number.isSafeInteger(value.fencingToken) &&
      value.fencingToken > 0 &&
      /^[a-f0-9]{64}$/.test(String(value.outputReceiptSha256)) &&
      value.rejectionCode === value.expectedRejectionCode &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("LEASE_LOSS_RECOVERY_INVALID");
  if (
    stepId === "recovery.delayed_output" &&
    !(
      observation &&
      observation.provider &&
      observation.model &&
      observation.runtimeProfile &&
      observation.authorizedLifecycleState &&
      observation.staleTransitionIdentity &&
      observation.delayedSubmissionIdentity &&
      time(observation.delayedSubmissionAt) &&
      observation.leaseFingerprintAtSubmission &&
      observation.fencingIdentityAtSubmission &&
      observation.actualRejectionCode === "DELAYED_PROVIDER_OUTPUT_REJECTED" &&
      observation.staleContentAuthoritative === false &&
      [value.assignmentId, value.attemptId, value.completedAttemptId].every((id) =>
        /^[0-9a-f-]{36}$/i.test(String(id)),
      ) &&
      value.attemptId !== value.completedAttemptId &&
      /^[a-f0-9]{64}$/.test(String(value.outputReceiptSha256)) &&
      value.rejectionCode === value.expectedRejectionCode &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("DELAYED_OUTPUT_RECOVERY_INVALID");
  if (
    stepId === "recovery.conflicting_receipt" &&
    !(
      observation &&
      hash(observation.originalReceiptSha256) &&
      hash(observation.conflictingReceiptSha256) &&
      observation.originalReceiptSha256 !== observation.conflictingReceiptSha256 &&
      observation.immutableBindings &&
      Array.isArray(observation.conflictingFields) &&
      observation.conflictingFields.length > 0 &&
      observation.submissionResult === "rejected" &&
      observation.actualRejectionCode === "CONFLICTING_RECEIPT_REJECTED" &&
      observation.authoritativeReceiptSha256After === observation.originalReceiptSha256 &&
      /^[0-9a-f-]{36}$/i.test(String(value.assignmentId)) &&
      /^[a-f0-9]{64}$/.test(String(value.acceptedReceiptSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.conflictingReceiptSha256)) &&
      value.acceptedReceiptSha256 !== value.conflictingReceiptSha256 &&
      value.rejectionCode === value.expectedRejectionCode &&
      /^[a-f0-9]{64}$/.test(String(value.durableStateBeforeSha256)) &&
      value.durableStateBeforeSha256 === value.durableStateAfterSha256
    )
  )
    reasons.push("CONFLICTING_RECEIPT_RECOVERY_INVALID");
  if (
    stepId === "isolation.production_resources_rejected" &&
    !(
      observation &&
      observation.requestedClassification === "production" &&
      observation.localTargetRepresentation &&
      observation.preflightOperationIdentity &&
      observation.policyDecision === "rejected" &&
      observation.actualRejectionCode === "PRODUCTION_RESOURCE_FORBIDDEN" &&
      observation.actualTopLevelErrorCode === "validation_failed" &&
      hash(observation.evaluationIdentity) &&
      observation.authorityPolicyVersion === "resource-authority-policy/1" &&
      observation.databaseConnectionAttemptsBefore === observation.databaseConnectionAttemptsAfter &&
      observation.dnsResolutionAttemptsBefore === observation.dnsResolutionAttemptsAfter &&
      observation.socketConnectionAttemptsBefore === observation.socketConnectionAttemptsAfter &&
      observation.providerInvocationCountBefore === observation.providerInvocationCountAfter &&
      observation.remoteHttpAttemptsBefore === observation.remoteHttpAttemptsAfter &&
      hash(observation.durableStateBeforeSha256) &&
      observation.durableStateBeforeSha256 === observation.durableStateAfterSha256 &&
      observation.productionEndpointContacted === false &&
      observation.terminalState === "rejected_before_access" &&
      value.runtimeMode === value.expectedRuntimeMode &&
      value.productionResourcesAllowed === false &&
      Number.isSafeInteger(value.productionResourceProbeCount) &&
      value.productionResourceProbeCount > 0 &&
      value.rejectedProbeCount === value.productionResourceProbeCount
    )
  )
    reasons.push("PRODUCTION_RESOURCE_ISOLATION_INVALID");
  if (
    stepId === "isolation.disposable_database_only" &&
    !(
      observation &&
      observation.runtimeMode === "disposable_acceptance" &&
      observation.productionAuthority === false &&
      observation.databaseResourceInventoryId &&
      hash(observation.connectionConfigurationIdentity) &&
      observation.acceptedDisposableTargetResult === "accepted" &&
      observation.forbiddenTargetResult === "rejected_before_connection" &&
      observation.actualRejectionCode === "PRODUCTION_RESOURCE_FORBIDDEN" &&
      observation.connectionAttemptsBeforeForbidden === observation.connectionAttemptsAfterForbidden &&
      observation.productionEndpointContacted === false &&
      value.databaseScope === value.expectedDatabaseScope &&
      /^[a-f0-9]{64}$/.test(String(value.databaseIdentitySha256)) &&
      value.databaseIdentitySha256 === value.disposableDatabaseIdentitySha256 &&
      /^[a-f0-9]{64}$/.test(String(value.productionDatabaseIdentitySha256)) &&
      value.databaseIdentitySha256 !== value.productionDatabaseIdentitySha256
    )
  )
    reasons.push("DISPOSABLE_DATABASE_ISOLATION_INVALID");
  if (
    stepId === "isolation.provider_writable_roots_bounded" &&
    !(
      Array.isArray(value.observedWritableRoots) &&
      value.observedWritableRoots.length > 0 &&
      Array.isArray(value.approvedWritableRoots) &&
      canonicalHash([...value.observedWritableRoots].sort()) ===
        canonicalHash([...value.approvedWritableRoots].sort()) &&
      Number.isSafeInteger(value.deniedWriteProbeCount) &&
      value.deniedWriteProbeCount > 0 &&
      value.escapedWriteCount === 0 &&
      Array.isArray(value.observations) &&
      value.observations.length === value.deniedWriteProbeCount &&
      value.observations.every(
        (item: any) =>
          item?.schemaVersion === "filesystem-write-observation/1" &&
          item?.authority?.schemaVersion === "filesystem-write-authority/1" &&
          item?.authority?.acceptanceRunId === value.acceptanceRunId &&
          item?.authority?.candidateArtifactSha256 === value.candidateArtifactSha256 &&
          item?.authoritySha256 === item?.authority?.authoritySha256 &&
          item?.allowedWrite?.allowed === true &&
          item?.allowedWrite?.existsAfter === true &&
          item?.deniedWrite?.allowed === false &&
          item?.deniedWrite?.reasonCode === "FILESYSTEM_WRITE_FORBIDDEN" &&
          item?.deniedWrite?.existedBefore === item?.deniedWrite?.existsAfter &&
          item?.deniedWrite?.targetSha256Before === item?.deniedWrite?.targetSha256After &&
          item?.descendantWrite?.attempted === true &&
          item?.descendantWrite?.allowed === false &&
          item?.descendantWrite?.targetExistsAfter === false,
      )
    )
  )
    reasons.push("PROVIDER_WRITABLE_ROOT_ISOLATION_INVALID");
  if (
    stepId === "isolation.repository_mutation_isolated" &&
    !(
      /^[a-f0-9]{64}$/.test(String(value.sourceRepositoryStateBeforeSha256)) &&
      value.sourceRepositoryStateBeforeSha256 === value.sourceRepositoryStateAfterSha256 &&
      /^[a-f0-9]{64}$/.test(String(value.executorWorktreeStateBeforeSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.executorWorktreeStateAfterSha256)) &&
      value.executorWorktreeStateBeforeSha256 !== value.executorWorktreeStateAfterSha256 &&
      value.mutationPath &&
      value.approvedWorktreePath &&
      String(value.mutationPath).startsWith(`${value.approvedWorktreePath}/`)
    )
  )
    reasons.push("REPOSITORY_MUTATION_ISOLATION_INVALID");
  if (
    stepId === "replay.projections_deleted" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.workspaceId)) &&
      /^[a-f0-9]{64}$/.test(String(value.liveProjectionSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.deletionReceiptSha256)) &&
      Number.isSafeInteger(value.projectionRowsBeforeDelete) &&
      value.projectionRowsBeforeDelete > 0 &&
      value.projectionRowsAfterDelete === 0
    )
  )
    reasons.push("PROJECTION_DELETION_EVIDENCE_INVALID");
  if (
    stepId === "replay.projections_rebuilt" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.workspaceId)) &&
      /^[a-f0-9]{64}$/.test(String(value.canonicalEventSetSha256)) &&
      /^[a-f0-9]{64}$/.test(String(value.rebuildReceiptSha256)) &&
      value.projectionRowsAfterDelete === 0 &&
      Number.isSafeInteger(value.projectionRowsAfterRebuild) &&
      value.projectionRowsAfterRebuild > 0
    )
  )
    reasons.push("PROJECTION_REBUILD_EVIDENCE_INVALID");
  if (
    stepId === "replay.live_equals_replay" &&
    !(
      /^[0-9a-f-]{36}$/i.test(String(value.workspaceId)) &&
      /^[a-f0-9]{64}$/.test(String(value.liveProjectionSha256)) &&
      value.liveProjectionSha256 === value.replayedProjectionSha256 &&
      /^[a-f0-9]{64}$/.test(String(value.comparisonReceiptSha256))
    )
  )
    reasons.push("PROJECTION_REPLAY_COMPARISON_INVALID");
  if (
    stepId.startsWith("secrets.") &&
    !(
      /^[a-f0-9]{64}$/.test(String(value.scanArtifactSha256)) &&
      Number.isSafeInteger(value.scannedByteCount) &&
      value.scannedByteCount > 0
    )
  )
    reasons.push("SECRET_SCAN_ARTIFACT_INVALID");
  const secretResultField: Record<string, string> = {
    "secrets.exact_credential_scan": "exactCredentialMatches",
    "secrets.credential_pattern_scan": "credentialPatternMatches",
    "secrets.lease_token_pattern_scan": "rawLeaseTokenPatternMatches",
    "secrets.forbidden_lease_token_key_scan": "forbiddenLeaseTokenKeys",
  };
  if (secretResultField[stepId] && value[secretResultField[stepId]] !== 0) reasons.push("SECRET_SCAN_MATCH_DETECTED");
  return reasons;
}
