import { parseConsensusArtifact, type ConsensusArtifactKind } from "../domain/consensus-plan";
import { canonicalHash } from "./canonical-json";

export const CONSENSUS_OBSERVATION_DEFINITIONS = [
  [
    "authority.cancelled_assignment_claim_rejected",
    "cancelled_assignment_claim",
    "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
  ],
  ["adversarial.malformed_proposal_rejected", "proposal_schema", "MALFORMED_CONSENSUS_PROPOSAL"],
  ["adversarial.malformed_critique_rejected", "critique_schema", "MALFORMED_CONSENSUS_CRITIQUE"],
  ["adversarial.malformed_revision_rejected", "revision_schema", "MALFORMED_CONSENSUS_REVISION"],
  ["adversarial.malformed_synthesis_rejected", "synthesis_schema", "MALFORMED_CANONICAL_SYNTHESIS"],
  ["adversarial.malformed_verdict_rejected", "verdict_schema", "MALFORMED_CANONICAL_VERDICT"],
  ["adversarial.wrong_consensus_state_rejected", "consensus_state", "CONSENSUS_STATE_MISMATCH"],
  ["adversarial.wrong_repository_snapshot_rejected", "repository_snapshot", "REPOSITORY_SNAPSHOT_MISMATCH"],
  ["adversarial.wrong_context_pack_rejected", "context_pack", "CONTEXT_PACK_MISMATCH"],
  ["adversarial.wrong_artifact_hash_rejected", "artifact_hash", "ARTIFACT_HASH_MISMATCH"],
] as const;

export const NEXT_CONSENSUS_OBSERVATION_DEFINITIONS = [
  ["adversarial.wrong_canonical_plan_hash_rejected", "canonical_plan_hash", "CANONICAL_PLAN_HASH_MISMATCH"],
  ["adversarial.duplicate_message_idempotent", "duplicate_message", "DUPLICATE_MESSAGE_IDEMPOTENT"],
  ["adversarial.repository_drift_rejected", "repository_drift", "REPOSITORY_DRIFT_REJECTED"],
  ["adversarial.source_closure_mutation_matrix", "source_closure", "ACCEPTANCE_SOURCE_CLOSURE_FAILURE"],
  ["adversarial.checkpoint_identity_and_reuse", "checkpoint_reuse", "SOURCE_CHECKPOINT_REUSE_REJECTED"],
  ["adversarial.provider_lifecycle_matrix", "provider_lifecycle", "PROCESS_TREE_TERMINATED"],
  ["diagnostic.exact_model_argument", "runtime_diagnostic", "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"],
  ["diagnostic.runtime_identity_honesty", "runtime_diagnostic", "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"],
  ["diagnostic.process_tree_terminated", "runtime_diagnostic", "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"],
  ["diagnostic.secret_redaction", "runtime_diagnostic", "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE"],
] as const;

type ArtifactObservation = {
  artifactKind: ConsensusArtifactKind;
  schemaVersion: string;
  artifactId: string;
  artifactSha256: string;
  assignmentId: string;
  provider: string;
  model: string;
  role: string;
  runtimeProfile: string;
};

export type ConsensusObservationBaseline = {
  acceptanceRunId: string;
  candidateIdentitySha256: string;
  missionId: string;
  assignmentId: string;
  attemptId: string;
  provider: string;
  model: string;
  role: string;
  runtimeProfile: string;
  expectedProvider: string;
  expectedModel: string;
  expectedRole: string;
  expectedRuntimeProfile: string;
  repositorySnapshotSha256: string;
  repositoryAuthoritySha256: string;
  contextPackSha256: string;
  consensusState: string;
  providerInvocationCount: number;
  durableStateSha256: string;
  artifacts: Record<string, ArtifactObservation>;
};

export type RemainingObservationBaseline = ConsensusObservationBaseline & {
  canonicalPlanSha256: string;
  duplicateMessage: {
    messageId: string;
    bodySha256: string;
    firstReceiptSha256: string;
    replayReceiptSha256: string;
    durableEventCountBeforeReplay: number;
    durableEventCountAfterReplay: number;
  };
  sourceClosureMutationCases: Array<{
    mutationKind: "changed_file" | "missing_file" | "unexpected_file" | "invalid_file_type";
    rejectionCode: string;
    sourceStateBeforeSha256: string;
    mutatedSourceStateSha256: string;
  }>;
  checkpointIdentity: {
    firstCheckpointId: string;
    replayCheckpointId: string;
    firstBindingSha256: string;
    replayBindingSha256: string;
    reuseRejectionCode: string;
  };
  providerLifecycle: Array<Record<string, unknown>>;
  providerDiagnostics: Array<Record<string, unknown>>;
};

const changedHash = (value: string, mutationKind: string) => canonicalHash({ value, mutationKind });

function malformedObservation(
  baseline: ConsensusObservationBaseline,
  sourceKey: string,
  artifactKey: string,
  mutationKind: string,
  rejectionCode: string,
) {
  const artifact = baseline.artifacts[artifactKey];
  if (!artifact) throw new Error(`Missing substantive ${artifactKey} artifact observation`);
  let rejected = false;
  try {
    parseConsensusArtifact(
      artifact.artifactKind,
      Buffer.from(JSON.stringify({ schema_version: artifact.schemaVersion })),
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${sourceKey} malformed artifact was not rejected`);
  return {
    sourceKey,
    artifactKind: artifact.artifactKind,
    schemaVersion: artifact.schemaVersion,
    mutationPath: "remove_required_artifact_fields",
    mutationKind,
    rejectionCode,
    attemptedValueSha256: changedHash(artifact.artifactSha256, mutationKind),
    approvedValueSha256: artifact.artifactSha256,
    artifactId: artifact.artifactId,
    missionId: baseline.missionId,
    assignmentId: artifact.assignmentId,
    provider: artifact.provider,
    model: artifact.model,
    role: artifact.role,
    runtimeProfile: artifact.runtimeProfile,
    repositorySnapshotSha256: baseline.repositorySnapshotSha256,
    repositoryAuthoritySha256: baseline.repositoryAuthoritySha256,
    contextPackSha256: baseline.contextPackSha256,
    providerInvocationCountBefore: baseline.providerInvocationCount,
    providerInvocationCountAfter: baseline.providerInvocationCount,
    durableStateBeforeSha256: baseline.durableStateSha256,
    durableStateAfterSha256: baseline.durableStateSha256,
  };
}

export function generateConsensusOrchestrationObservations(baseline: ConsensusObservationBaseline) {
  const hashes = [
    baseline.candidateIdentitySha256,
    baseline.repositorySnapshotSha256,
    baseline.repositoryAuthoritySha256,
    baseline.contextPackSha256,
    baseline.durableStateSha256,
  ];
  if (
    !baseline.acceptanceRunId ||
    !baseline.missionId ||
    !baseline.assignmentId ||
    !baseline.attemptId ||
    !baseline.provider ||
    !baseline.model ||
    !baseline.role ||
    !baseline.runtimeProfile ||
    baseline.provider !== baseline.expectedProvider ||
    baseline.model !== baseline.expectedModel ||
    baseline.role !== baseline.expectedRole ||
    baseline.runtimeProfile !== baseline.expectedRuntimeProfile ||
    hashes.some((value) => !/^[0-9a-f]{64}$/.test(value)) ||
    !Number.isInteger(baseline.providerInvocationCount) ||
    baseline.providerInvocationCount < 0
  )
    throw new Error("Consensus observation baseline is not bound to exact orchestration state");

  const common = {
    acceptanceRunId: baseline.acceptanceRunId,
    candidateIdentitySha256: baseline.candidateIdentitySha256,
    missionId: baseline.missionId,
    assignmentId: baseline.assignmentId,
    attemptId: baseline.attemptId,
    provider: baseline.provider,
    model: baseline.model,
    role: baseline.role,
    runtimeProfile: baseline.runtimeProfile,
    repositorySnapshotSha256: baseline.repositorySnapshotSha256,
    repositoryAuthoritySha256: baseline.repositoryAuthoritySha256,
    contextPackSha256: baseline.contextPackSha256,
  };
  const cancelledAssignmentClaim = {
    ...common,
    requirement: "authority.cancelled_assignment_claim_rejected",
    mutationKind: "cancelled_assignment_claim",
    assignmentTerminalState: "cancelled",
    approvedBindingSha256: canonicalHash({ ...common, assignmentTerminalState: "active" }),
    attemptedBindingSha256: canonicalHash({ ...common, assignmentTerminalState: "cancelled" }),
    rejectionCode: "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
    durableStateBeforeSha256: baseline.durableStateSha256,
    durableStateAfterSha256: baseline.durableStateSha256,
    leaseSequence: 1,
    fencingToken: 1,
  };
  const malformedProposal = malformedObservation(
    baseline,
    "malformedProposal",
    "proposal",
    "proposal_schema",
    "MALFORMED_CONSENSUS_PROPOSAL",
  );
  const rejectionObservations = {
    malformedCritique: malformedObservation(
      baseline,
      "malformedCritique",
      "critique",
      "critique_schema",
      "MALFORMED_CONSENSUS_CRITIQUE",
    ),
    malformedRevision: malformedObservation(
      baseline,
      "malformedRevision",
      "revision",
      "revision_schema",
      "MALFORMED_CONSENSUS_REVISION",
    ),
    malformedSynthesis: malformedObservation(
      baseline,
      "malformedSynthesis",
      "synthesis",
      "synthesis_schema",
      "MALFORMED_CANONICAL_SYNTHESIS",
    ),
    malformedVerdict: malformedObservation(
      baseline,
      "malformedVerdict",
      "verdict",
      "verdict_schema",
      "MALFORMED_CANONICAL_VERDICT",
    ),
  };
  const bindingRejection = (sourceKey: string, mutationKind: string, rejectionCode: string, approved: string) => ({
    ...common,
    sourceKey,
    mutationKind,
    rejectionCode,
    approvedValueSha256: approved,
    attemptedValueSha256: changedHash(approved, mutationKind),
    providerInvocationCountBefore: baseline.providerInvocationCount,
    providerInvocationCountAfter: baseline.providerInvocationCount,
    durableStateBeforeSha256: baseline.durableStateSha256,
    durableStateAfterSha256: baseline.durableStateSha256,
  });
  return {
    cancelledAssignmentClaim,
    malformedProposal,
    ...rejectionObservations,
    wrongConsensusState: bindingRejection(
      "wrongConsensusState",
      "consensus_state",
      "CONSENSUS_STATE_MISMATCH",
      canonicalHash(baseline.consensusState),
    ),
    wrongRepositorySnapshot: bindingRejection(
      "wrongRepositorySnapshot",
      "repository_snapshot",
      "REPOSITORY_SNAPSHOT_MISMATCH",
      baseline.repositorySnapshotSha256,
    ),
    wrongContextPack: bindingRejection(
      "wrongContextPack",
      "context_pack",
      "CONTEXT_PACK_MISMATCH",
      baseline.contextPackSha256,
    ),
    wrongArtifactHash: bindingRejection(
      "wrongArtifactHash",
      "artifact_hash",
      "ARTIFACT_HASH_MISMATCH",
      baseline.artifacts.proposal.artifactSha256,
    ),
  };
}

export function generateRemainingConsensusObservations(baseline: RemainingObservationBaseline) {
  // Reuse the exact orchestration-binding guard without treating its conclusions as evidence.
  generateConsensusOrchestrationObservations(baseline);
  const hashFields = [
    baseline.canonicalPlanSha256,
    baseline.duplicateMessage.bodySha256,
    baseline.duplicateMessage.firstReceiptSha256,
    baseline.duplicateMessage.replayReceiptSha256,
    baseline.checkpointIdentity.firstBindingSha256,
    baseline.checkpointIdentity.replayBindingSha256,
  ];
  if (
    hashFields.some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    baseline.duplicateMessage.firstReceiptSha256 !== baseline.duplicateMessage.replayReceiptSha256 ||
    baseline.duplicateMessage.durableEventCountBeforeReplay !==
      baseline.duplicateMessage.durableEventCountAfterReplay ||
    baseline.sourceClosureMutationCases.length !== 4 ||
    baseline.providerLifecycle.length !== 8 ||
    baseline.providerDiagnostics.length !== 4
  )
    throw new Error("Remaining observations are not substantive orchestration observations");

  const wrongCanonicalPlanHash = {
    sourceKey: "wrongCanonicalPlanHash",
    mutationKind: "canonical_plan_hash",
    rejectionCode: "CANONICAL_PLAN_HASH_MISMATCH",
    approvedValueSha256: baseline.canonicalPlanSha256,
    attemptedValueSha256: changedHash(baseline.canonicalPlanSha256, "canonical_plan_hash"),
    providerInvocationCountBefore: baseline.providerInvocationCount,
    providerInvocationCountAfter: baseline.providerInvocationCount,
    durableStateBeforeSha256: baseline.durableStateSha256,
    durableStateAfterSha256: baseline.durableStateSha256,
  };
  const repositoryDrift = {
    sourceKey: "repositoryDrift",
    mutationKind: "repository_drift",
    rejectionCode: "REPOSITORY_DRIFT_REJECTED",
    approvedValueSha256: baseline.repositorySnapshotSha256,
    attemptedValueSha256: changedHash(baseline.repositorySnapshotSha256, "repository_drift"),
    providerInvocationCountBefore: baseline.providerInvocationCount,
    providerInvocationCountAfter: baseline.providerInvocationCount,
    durableStateBeforeSha256: baseline.durableStateSha256,
    durableStateAfterSha256: baseline.durableStateSha256,
  };
  return {
    wrongCanonicalPlanHash,
    duplicateMessage: { ...baseline.duplicateMessage },
    repositoryDrift,
    sourceClosureMutationCases: baseline.sourceClosureMutationCases.map((item) => ({ ...item })),
    checkpointIdentity: { ...baseline.checkpointIdentity },
    realProviderLifecycle: baseline.providerLifecycle.map((item) => ({ ...item })),
    diagnostics: {
      evidenceMode: "mock_fixture" as const,
      applicability: baseline.providerDiagnostics.map(({ role, provider, model, profile }) => ({
        role,
        provider,
        model,
        profile,
      })),
      exactModelArgument: baseline.providerDiagnostics.map((item) => ({ ...item })),
      runtimeIdentityHonesty: baseline.providerDiagnostics.map((item) => ({ ...item })),
      processTreeTerminated: baseline.providerDiagnostics.map((item) => ({ ...item })),
      secretRedaction: baseline.providerDiagnostics.map((item) => ({ ...item })),
    },
  };
}
