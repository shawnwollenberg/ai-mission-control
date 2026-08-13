import { appendEvents, loadAggregateEvents, type ActorType, type NewDomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { ConcurrencyConflictError, NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
import { canonicalHash } from "@/lib/canonical-json";
import {
  assertDisposableLocalImplementationAuthority,
  assertDisposableRepositoryAuthorityProjection,
  repositoryAuthorityBindingHash,
} from "@/domain/repository-authority";
import { disposableApprovedAssignment, missionControlRuntimeMode, runtimeTrustEvidence } from "@/lib/runtime-trust";
import { handleCreateMission, handleMissionTransition, type CommandActor } from "@/application/mission-commands";
import { handleCreateTask, handleTaskTransition } from "@/application/task-commands";
import { handleExecutionCancellation, handleRequestRemoteExecution } from "@/application/execution-commands";
import { evaluateAgentEligibility } from "@/application/agent-eligibility";
import { applyApprovalProjection } from "@/application/approval-commands";
import { applyConsensusPlanProjection } from "@/application/consensus-plan-projector";
import { storeExecutionArtifact } from "@/execution/artifact-store";
import {
  assertConsensusTransition,
  assertConsensusArtifactSecretSafe,
  assertProjectBrainContextPack,
  canonicalConsensusObjectionId,
  consensusArtifactKinds,
  parseConsensusArtifact,
  type ConsensusArtifactKind,
  type ConsensusOperation,
  type ConsensusParticipantRole,
  type ConsensusStatus,
  type ParsedConsensusArtifact,
} from "@/domain/consensus-plan";
import type { AgentOperation, ModelCapabilityRole } from "@/domain/agent-provider";
import type { PoolClient } from "pg";

type ConsensusActor = { workspaceId: string; id: string; type: ActorType };
type ParticipantInput = { agentId: string; modelId: string };
type BoundParticipant = ParticipantInput & {
  assignmentId: string;
  role: ConsensusParticipantRole;
  providerId: string;
  capabilityAttestationId: string;
  capabilityAttestationHash: string;
  requiredOperations: AgentOperation[];
  permissionProfileHash: string;
  runtimeModelIdentity: "verified" | "reported" | "unverifiable";
  providerRuntimeRequirementsId: string;
  providerRuntimeRequirementsHash: string;
  assignmentVersion: 1;
};
type ConsensusProjection = {
  mission_id: string;
  aggregate_version: number;
  status: ConsensusStatus;
  consensus_attempt: number;
  repository_id: string;
  base_branch: string;
  repository_base_commit: string;
  repository_snapshot: string;
  repository_authority_hash: string;
  project_brain_context_artifact_id: string | null;
  context_pack_hash: string | null;
  planning_schema_version: string;
  synthesizer_assignment_id: string;
  preferred_executor_agent_id: string | null;
  preferred_executor_model_id: string | null;
  execution_budget: {
    maximumDurationSeconds: number;
    maximumAttempts: number;
    maximumCostAmount: number | null;
    costCurrency: string;
  };
  require_implementation_review: boolean;
  maximum_turns: number;
  maximum_duration_seconds: number;
  maximum_cost_amount: string | null;
  cost_currency: string;
  maximum_artifact_bytes: number;
  maximum_command_count: number;
  maximum_retry_count: number;
  deadline_at: Date;
  canonical_plan_artifact_id: string | null;
  canonical_plan_hash: string | null;
  human_approval_id: string | null;
  implementation_mission_id: string | null;
  learning_candidate_artifact_id: string | null;
  consensus_decision: "reached" | "not_reached" | null;
  stale_at: Date | null;
};

const operationCapabilities: Record<ConsensusOperation, string[]> = {
  prepare_context: ["repository.read", "project_brain.context", "artifact.create"],
  proposal: ["repository.read", "plan.generate", "artifact.create"],
  critique: ["repository.read", "plan.critique", "artifact.create"],
  revision: ["repository.read", "plan.revise", "artifact.create"],
  canonicalize: ["repository.read", "plan.generate", "artifact.create"],
  verdict: ["repository.read", "plan.review", "artifact.create"],
};
const providerOperations: Record<ConsensusOperation, AgentOperation> = {
  prepare_context: "prepare_project_brain_context",
  proposal: "generate_structured_plan",
  critique: "critique_plan",
  revision: "revise_plan",
  canonicalize: "generate_structured_plan",
  verdict: "review_canonical_plan",
};
const artifactForOperation: Record<ConsensusOperation, ConsensusArtifactKind> = {
  prepare_context: "project_brain_context_pack",
  proposal: "consensus_proposal",
  critique: "consensus_critique",
  revision: "consensus_revision",
  canonicalize: "canonical_implementation_plan",
  verdict: "canonical_plan_verdict",
};
const allowedStatus: Record<ConsensusOperation, ConsensusStatus> = {
  prepare_context: "ready",
  proposal: "capturing_independent_proposals",
  critique: "critique_round",
  revision: "revision_round",
  canonicalize: "canonicalization",
  verdict: "awaiting_final_verdicts",
};

const consensusChildExecutionBudget = Object.freeze({
  maximumDurationSeconds: 3600,
  maximumAttempts: 2,
  maximumCostAmount: null,
  costCurrency: "USD",
});

function governedValidationCommands(value: unknown, ownerApproved: unknown): string[] {
  if (!Array.isArray(value) || !Array.isArray(ownerApproved)) return [];
  const approved = new Set(
    ownerApproved
      .filter(
        (entry): entry is string[] =>
          Array.isArray(entry) &&
          entry.length > 0 &&
          entry.every((token) => typeof token === "string" && token.length > 0),
      )
      .map((command) => command.join(" ")),
  );
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => approved.has(entry))
    .slice(0, 10);
}

async function projection(workspaceId: string, missionId: string) {
  const row = (
    await getDatabasePool().query<ConsensusProjection>(
      "SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, missionId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Consensus mission");
  return row;
}

async function assertCurrentRepositoryAuthority(
  workspaceId: string,
  repositoryId: string,
  expectedHash: string,
  database: Pick<PoolClient, "query"> = getDatabasePool(),
  lock = false,
) {
  const row = (
    await database.query<{
      repository_authority: unknown;
      repository_authority_hash: string | null;
      authority_command_id: string | null;
      authority_receipts: number;
      read_allowed: boolean;
      write_allowed: boolean;
      commit_allowed: boolean;
      isolated_worktree_write_allowed: boolean;
      mission_agent_local_commit_allowed: boolean;
      provider_direct_commit_allowed: boolean;
      push_allowed: boolean;
      pull_request_allowed: boolean;
      merge_allowed: boolean;
      publication_allowed: boolean;
      deployment_allowed: boolean;
      infrastructure_mutation_allowed: boolean;
    }>(
      `SELECT r.repository_authority,r.repository_authority_hash,r.read_allowed,r.write_allowed,r.commit_allowed,
         r.isolated_worktree_write_allowed,r.mission_agent_local_commit_allowed,r.provider_direct_commit_allowed,
         r.push_allowed,r.pull_request_allowed,r.merge_allowed,r.publication_allowed,r.deployment_allowed,
         r.infrastructure_mutation_allowed,
         (SELECT count(*)::int FROM repository_authority_receipts receipt
           WHERE receipt.workspace_id=r.workspace_id AND receipt.repository_id=r.repository_id
             AND receipt.authority_hash=r.repository_authority_hash) authority_receipts,
         (SELECT receipt.command_id::text FROM repository_authority_receipts receipt
           WHERE receipt.workspace_id=r.workspace_id AND receipt.repository_id=r.repository_id
             AND receipt.authority_hash=r.repository_authority_hash
           ORDER BY receipt.created_at DESC LIMIT 1) authority_command_id
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2 AND r.disabled_at IS NULL
       ${lock ? "FOR UPDATE OF r" : ""}`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  if (!row || row.repository_authority_hash !== expectedHash)
    throw new ValidationFailedError("Repository authority binding changed");
  assertDisposableRepositoryAuthorityProjection({
    authority: row.repository_authority,
    authorityHash: row.repository_authority_hash,
    authorityCommandId: row.authority_command_id,
    authorityReceiptCount: row.authority_receipts,
    readAllowed: row.read_allowed,
    writeAllowed: row.write_allowed,
    commitAllowed: row.commit_allowed,
    isolatedWorktreeWriteAllowed: row.isolated_worktree_write_allowed,
    missionAgentLocalCommitAllowed: row.mission_agent_local_commit_allowed,
    providerDirectCommitAllowed: row.provider_direct_commit_allowed,
    pushAllowed: row.push_allowed,
    pullRequestAllowed: row.pull_request_allowed,
    mergeAllowed: row.merge_allowed,
    publicationAllowed: row.publication_allowed,
    deploymentAllowed: row.deployment_allowed,
    infrastructureMutationAllowed: row.infrastructure_mutation_allowed,
  });
  return row;
}

async function appendConsensus(input: {
  actor: ConsensusActor;
  commandId: string;
  missionId: string;
  commandType: string;
  events: NewDomainEvent[];
  beforeAppend?: (client: PoolClient) => Promise<void>;
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await loadAggregateEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "consensus_plan",
      aggregateId: input.missionId,
    });
    try {
      return await appendEvents({
        workspaceId: input.actor.workspaceId,
        aggregateType: "consensus_plan",
        aggregateId: input.missionId,
        missionId: input.missionId,
        expectedVersion: existing.length,
        commandId: input.commandId,
        commandType: input.commandType,
        correlationId: input.missionId,
        causationId: existing.at(-1)?.eventId,
        actor: { type: input.actor.type, id: input.actor.id },
        events: input.events,
        beforeAppend: input.beforeAppend,
        applyProjections: (client, events) => applyConsensusPlanProjection(client, events),
      });
    } catch (error) {
      if (!(error instanceof ConcurrencyConflictError) || attempt === 2) throw error;
    }
  }
  throw new ConcurrencyConflictError({ missionId: input.missionId });
}

async function transitionConsensus(input: {
  actor: ConsensusActor;
  commandId: string;
  missionId: string;
  target: ConsensusStatus;
  reason?: string;
  consensusDecision?: "reached" | "not_reached";
}) {
  const current = await projection(input.actor.workspaceId, input.missionId);
  if (current.status === input.target) return current;
  assertConsensusTransition(current.status, input.target);
  await appendConsensus({
    actor: input.actor,
    commandId: input.commandId,
    missionId: input.missionId,
    commandType: `Consensus:${current.status}->${input.target}`,
    events: [
      {
        eventType: "consensus.status_changed",
        eventSchemaVersion: 1,
        payload: {
          status: input.target,
          reason: input.reason ?? null,
          consensusDecision: input.consensusDecision ?? null,
        },
      },
    ],
  });
  const terminalMissionStatus = ["consensus_not_reached", "rejected", "failed"].includes(input.target)
    ? "failed"
    : input.target === "cancelled"
      ? "cancelled"
      : undefined;
  if (terminalMissionStatus) {
    await handleMissionTransition({
      actor: { workspaceId: input.actor.workspaceId, userId: input.actor.id, role: "owner" },
      commandId: stableUuid(`${input.missionId}:mission:${terminalMissionStatus}:${input.target}`),
      missionId: input.missionId,
      target: terminalMissionStatus,
    });
  }
  return projection(input.actor.workspaceId, input.missionId);
}

export async function cancelConsensusForAcceptanceSourceClosure(input: { actor: CommandActor; missionId: string }) {
  return transitionConsensus({
    actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
    commandId: stableUuid(`${input.missionId}:acceptance-source-closure:cancel`),
    missionId: input.missionId,
    target: "cancelled",
    reason: "acceptance_source_closure_failure",
  });
}

async function validateParticipantBinding(input: {
  workspaceId: string;
  repositoryId: string;
  participant: ParticipantInput;
  assignmentId: string;
  role: ConsensusParticipantRole;
  modelRole: ModelCapabilityRole;
  missionRole: "planner" | "reviewer" | "executor";
  operations: AgentOperation[];
  requiredCapabilities: string[];
  repositoryPermission: "read" | "isolated_worktree_write";
  requireProjectBrainContext?: boolean;
  requireRepositoryMutation?: boolean;
}) {
  if (missionControlRuntimeMode() === "disposable_acceptance") {
    const approvedRole =
      input.role === "planner_a" ||
      input.role === "planner_b" ||
      input.role === "synthesizer" ||
      input.role === "executor"
        ? input.role
        : undefined;
    const approved = approvedRole ? disposableApprovedAssignment(approvedRole) : undefined;
    const attemptedProvider = (
      await getDatabasePool().query<{ provider_id: string }>(
        "SELECT provider_id FROM agents WHERE workspace_id=$1 AND agent_id=$2",
        [input.workspaceId, input.participant.agentId],
      )
    ).rows[0]?.provider_id;
    if (!approved || approved.provider !== attemptedProvider || approved.model !== input.participant.modelId) {
      const trust = runtimeTrustEvidence();
      throw new ValidationFailedError("Disposable acceptance assignment does not match the exact approved model", {
        eligibilityCode: "disposable_model_assignment_mismatch",
        assignmentRole: input.role,
        originalProvider: approved?.provider ?? null,
        originalModel: approved?.model ?? null,
        attemptedProvider: attemptedProvider ?? null,
        attemptedModel: input.participant.modelId,
        approvalBinding: {
          registryPathHash: trust.registryPathHash,
          registryContentHash: trust.registryContentHash,
          registryScope: trust.registryScope,
        },
        lifecycleState: "not_created",
        fallbackAllowed: false,
      });
    }
  }
  const eligibility = await evaluateAgentEligibility({
    workspaceId: input.workspaceId,
    agentId: input.participant.agentId,
    domain: "software_delivery",
    requiredCapabilities: input.requiredCapabilities,
    requiredResources: [
      { resourceType: "repository", resourceId: input.repositoryId, permission: input.repositoryPermission },
    ],
    protocolVersion: "1.0",
    requiredMissionRole: input.missionRole,
    requiredOperations: input.operations,
    requiredModel: input.participant.modelId,
    requiredModelRole: input.modelRole,
    requireStructuredOutput: true,
    requireProjectBrainContext: input.requireProjectBrainContext,
    requireRepositoryMutation: input.requireRepositoryMutation,
    requireVerifiedMissionAgentArtifact: true,
  });
  if (
    !eligibility.eligible ||
    !eligibility.providerId ||
    !eligibility.modelCapability ||
    !eligibility.capabilityAttestationId ||
    !eligibility.capabilityAttestationHash ||
    !eligibility.providerRuntimeProfile
  )
    throw new ValidationFailedError(`${input.role} agent/model assignment is not eligible`, {
      eligibilityCode: "agent_model_assignment_ineligible",
      assignmentRole: input.role,
      agentId: input.participant.agentId,
      modelId: input.participant.modelId,
      reasons: eligibility.reasons,
    });
  return {
    ...input.participant,
    assignmentId: input.assignmentId,
    role: input.role,
    providerId: eligibility.providerId,
    capabilityAttestationId: eligibility.capabilityAttestationId,
    capabilityAttestationHash: eligibility.capabilityAttestationHash,
    requiredOperations: [...input.operations].sort(),
    permissionProfileHash: canonicalHash({
      repositoryId: input.repositoryId,
      permission: input.repositoryPermission,
      role: input.role,
      agentId: input.participant.agentId,
      providerId: eligibility.providerId,
      modelId: input.participant.modelId,
      capabilityAttestationHash: eligibility.capabilityAttestationHash,
      operations: [...input.operations].sort(),
      requiredCapabilities: [...input.requiredCapabilities].sort(),
      runtimeProfile: eligibility.providerRuntimeProfile,
    }),
    runtimeModelIdentity: eligibility.modelCapability.runtimeModelIdentity,
    providerRuntimeRequirementsId: eligibility.providerRuntimeProfile.profileId,
    providerRuntimeRequirementsHash: eligibility.providerRuntimeProfile.runtimeBindingHash,
    assignmentVersion: 1 as const,
  } satisfies BoundParticipant;
}

export async function createConsensusPlanMission(input: {
  actor: CommandActor;
  commandId: string;
  repositoryId: string;
  baseBranch?: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  plannerA: ParticipantInput;
  plannerB: ParticipantInput;
  synthesizer: ParticipantInput;
  preferredExecutorAgentId?: string;
  preferredExecutorModelId?: string;
  implementationReviewer?: ParticipantInput;
  requireImplementationReview?: boolean;
  maximumCostAmount?: number;
  costCurrency?: string;
  maximumDurationSeconds?: number;
  maximumArtifactBytes?: number;
  maximumCommandCount?: number;
  maximumRetryCount?: number;
}) {
  if (input.plannerA.agentId === input.plannerB.agentId)
    throw new ValidationFailedError("Consensus planning requires two independently registered agents");
  if (!input.objective.trim() || input.objective.length > 10_000)
    throw new ValidationFailedError("Consensus objective is required and must be bounded");
  if (!input.acceptanceCriteria.length || input.acceptanceCriteria.length > 50)
    throw new ValidationFailedError("Consensus planning requires bounded acceptance criteria");
  if (input.requireImplementationReview)
    throw new ValidationFailedError(
      "Automatic implementation review remains disabled in Mission Agent 0.8.0; reviewer selection is recorded for a future governed phase",
    );
  const repository = (
    await getDatabasePool().query<{
      repository_id: string;
      name: string;
      default_branch: string;
      observed_commit: string | null;
      repository_fingerprint: string | null;
      allowed_agent_ids: string[];
      read_allowed: boolean;
      write_allowed: boolean;
      commit_allowed: boolean;
      isolated_worktree_write_allowed: boolean;
      mission_agent_local_commit_allowed: boolean;
      provider_direct_commit_allowed: boolean;
      push_allowed: boolean;
      pull_request_allowed: boolean;
      merge_allowed: boolean;
      publication_allowed: boolean;
      deployment_allowed: boolean;
      infrastructure_mutation_allowed: boolean;
      repository_authority: unknown;
      repository_authority_hash: string | null;
      repository_authority_command_id: string | null;
      repository_state: {
        schemaVersion?: string;
        baseBranch?: string;
        baseCommit?: string;
        headCommit?: string;
        cleanWorktree?: boolean;
        trackedStatusEmpty?: boolean;
        trackedContentMatchesIndex?: boolean;
        untrackedCount?: number;
        relevantIgnoredCount?: number;
        snapshotHash?: string;
      } | null;
      repository_snapshot_hash: string | null;
      repository_snapshot_artifact_id: string | null;
      snapshot_artifact_checksum: string | null;
      snapshot_artifact_manifest: Record<string, unknown> | null;
    }>(
      `SELECT r.repository_id,r.name,r.default_branch,r.observed_commit,r.repository_fingerprint,r.allowed_agent_ids,
        r.read_allowed,r.write_allowed,r.commit_allowed,r.isolated_worktree_write_allowed,
        r.mission_agent_local_commit_allowed,r.provider_direct_commit_allowed,r.push_allowed,r.pull_request_allowed,
        r.merge_allowed,
        r.publication_allowed,r.deployment_allowed,r.infrastructure_mutation_allowed,
        r.repository_authority,r.repository_authority_hash,
        (SELECT receipt.command_id::text FROM repository_authority_receipts receipt
          WHERE receipt.workspace_id=r.workspace_id AND receipt.repository_id=r.repository_id
            AND receipt.authority_hash=r.repository_authority_hash
          ORDER BY receipt.created_at DESC LIMIT 1) repository_authority_command_id,
        r.repository_state,r.repository_snapshot_hash,r.repository_snapshot_artifact_id,
        snapshot.checksum_sha256 snapshot_artifact_checksum,snapshot.manifest snapshot_artifact_manifest
       FROM repositories r
       LEFT JOIN repository_snapshot_artifacts snapshot
         ON snapshot.workspace_id=r.workspace_id AND snapshot.snapshot_artifact_id=r.repository_snapshot_artifact_id
       WHERE r.workspace_id=$1 AND r.repository_id=$2 AND r.disabled_at IS NULL`,
      [input.actor.workspaceId, input.repositoryId],
    )
  ).rows[0];
  if (!repository) throw new NotFoundError("Repository");
  if (!repository.observed_commit || !/^[0-9a-f]{40,64}$/.test(repository.observed_commit))
    throw new ValidationFailedError("Repository requires an exact observed commit before consensus planning");
  if (
    !repository.repository_state ||
    repository.repository_state.schemaVersion !== "complete_repository_state/3" ||
    repository.repository_state.baseBranch !== repository.default_branch ||
    repository.repository_state.baseCommit !== repository.observed_commit ||
    repository.repository_state.headCommit !== repository.observed_commit ||
    repository.repository_state.cleanWorktree !== true ||
    repository.repository_state.snapshotHash !== repository.repository_snapshot_hash ||
    !repository.repository_snapshot_artifact_id ||
    repository.snapshot_artifact_checksum !== repository.repository_snapshot_hash ||
    canonicalHash(repository.snapshot_artifact_manifest) !== canonicalHash(repository.repository_state) ||
    repository.repository_state.trackedStatusEmpty !== true ||
    repository.repository_state.trackedContentMatchesIndex !== true ||
    repository.repository_state.untrackedCount !== 0 ||
    repository.repository_state.relevantIgnoredCount !== 0
  )
    throw new ValidationFailedError(
      "Disposable consensus acceptance requires a clean, complete content-addressed repository snapshot",
    );
  const baseBranch = input.baseBranch?.trim() || repository.default_branch;
  if (baseBranch !== repository.default_branch)
    throw new ValidationFailedError("Consensus base branch must match the registered repository branch");
  if (!repository.read_allowed)
    throw new ValidationFailedError("Consensus planning requires repository inspection authority");
  const repositoryAuthority = assertDisposableLocalImplementationAuthority(repository.repository_authority);
  if (
    !repository.repository_authority_hash ||
    !repository.repository_authority_command_id ||
    repositoryAuthorityBindingHash(repositoryAuthority, repository.repository_authority_command_id) !==
      repository.repository_authority_hash ||
    repository.write_allowed ||
    repository.commit_allowed ||
    !repository.isolated_worktree_write_allowed ||
    !repository.mission_agent_local_commit_allowed ||
    repository.provider_direct_commit_allowed ||
    repository.push_allowed ||
    repository.pull_request_allowed ||
    repository.merge_allowed ||
    repository.publication_allowed ||
    repository.deployment_allowed ||
    repository.infrastructure_mutation_allowed
  )
    throw new ValidationFailedError("Repository authority is not safe for disposable consensus execution");
  const repositorySnapshot = repository.repository_snapshot_hash;
  if (!input.preferredExecutorAgentId || !input.preferredExecutorModelId)
    throw new ValidationFailedError("A preferred implementation executor and model are required before planning");
  if (!repository.allowed_agent_ids.includes(input.preferredExecutorAgentId))
    throw new ValidationFailedError("Preferred executor is not allowed for this repository");
  if (!repositoryAuthority.implementationAgentIds.includes(input.preferredExecutorAgentId))
    throw new ValidationFailedError("Preferred executor lacks isolated-worktree implementation authority");
  const missionId = stableUuid(`consensus-plan:${input.commandId}`);
  const plannerAId = stableUuid(`${missionId}:planner_a`);
  const plannerBId = stableUuid(`${missionId}:planner_b`);
  const synthesizerId = stableUuid(`${missionId}:synthesizer`);
  const executorId = stableUuid(`${missionId}:executor`);
  const reviewerId = stableUuid(`${missionId}:implementation_reviewer`);
  const plannerOperations: AgentOperation[] = [
    "generate_structured_plan",
    "critique_plan",
    "revise_plan",
    "review_canonical_plan",
  ];
  const [plannerA, plannerB, synthesizer, executor] = await Promise.all([
    validateParticipantBinding({
      workspaceId: input.actor.workspaceId,
      repositoryId: input.repositoryId,
      participant: input.plannerA,
      assignmentId: plannerAId,
      role: "planner_a",
      modelRole: "planner",
      missionRole: "planner",
      operations: plannerOperations,
      requiredCapabilities: [
        "repository.read",
        "plan.generate",
        "plan.critique",
        "plan.revise",
        "plan.review",
        "artifact.create",
      ],
      repositoryPermission: "read",
      requireProjectBrainContext: true,
    }),
    validateParticipantBinding({
      workspaceId: input.actor.workspaceId,
      repositoryId: input.repositoryId,
      participant: input.plannerB,
      assignmentId: plannerBId,
      role: "planner_b",
      modelRole: "planner",
      missionRole: "planner",
      operations: plannerOperations,
      requiredCapabilities: [
        "repository.read",
        "plan.generate",
        "plan.critique",
        "plan.revise",
        "plan.review",
        "artifact.create",
      ],
      repositoryPermission: "read",
      requireProjectBrainContext: true,
    }),
    validateParticipantBinding({
      workspaceId: input.actor.workspaceId,
      repositoryId: input.repositoryId,
      participant: input.synthesizer,
      assignmentId: synthesizerId,
      role: "synthesizer",
      modelRole: "synthesizer",
      missionRole: "planner",
      operations: ["prepare_project_brain_context", "generate_structured_plan"],
      requiredCapabilities: ["repository.read", "project_brain.context", "plan.generate", "artifact.create"],
      repositoryPermission: "read",
      requireProjectBrainContext: true,
    }),
    validateParticipantBinding({
      workspaceId: input.actor.workspaceId,
      repositoryId: input.repositoryId,
      participant: { agentId: input.preferredExecutorAgentId, modelId: input.preferredExecutorModelId },
      assignmentId: executorId,
      role: "executor",
      modelRole: "executor",
      missionRole: "executor",
      operations: ["implement_change"],
      requiredCapabilities: [
        "repository.read",
        "repository.isolated_worktree_write",
        "code.implement",
        "test.run",
        "git.commit_local",
      ],
      repositoryPermission: "isolated_worktree_write",
      requireRepositoryMutation: true,
    }),
  ]);
  const reviewer = input.implementationReviewer
    ? await validateParticipantBinding({
        workspaceId: input.actor.workspaceId,
        repositoryId: input.repositoryId,
        participant: input.implementationReviewer,
        assignmentId: reviewerId,
        role: "implementation_reviewer",
        modelRole: "implementation_reviewer",
        missionRole: "reviewer",
        operations: ["review_implementation"],
        requiredCapabilities: ["repository.read", "code.review", "artifact.create"],
        repositoryPermission: "read",
      })
    : undefined;
  if (input.requireImplementationReview && !reviewer)
    throw new ValidationFailedError("Independent implementation review requires a selected reviewer agent and model");
  if (input.requireImplementationReview && reviewer?.agentId === executor.agentId)
    throw new ValidationFailedError("Independent implementation reviewer must not be the executor agent");
  const maximumDurationSeconds = Math.min(Math.max(input.maximumDurationSeconds ?? 3600, 60), 86_400);
  const deadlineAt = new Date(Date.now() + maximumDurationSeconds * 1000).toISOString();
  await handleCreateMission({
    actor: input.actor,
    commandId: stableUuid(`${missionId}:create-mission`),
    missionId,
    mission: {
      name: `Consensus plan · ${repository.name}`,
      objective: input.objective,
      description: "Two independently registered planners produce and review one immutable implementation plan.",
      domain: "software_delivery",
      priority: "normal",
      riskLevel: "moderate",
      successCriteria: input.acceptanceCriteria,
      constraints: [
        ...(input.constraints ?? []),
        "Planning is read-only",
        "Exactly two independent planners",
        "Human approval required before a separate implementation mission",
      ],
      budgetLimits: {
        ...(input.maximumCostAmount === undefined ? {} : { maximumCostAmount: input.maximumCostAmount }),
        maximumDurationSeconds,
      },
      deadline: deadlineAt,
      missionType: "consensus_plan",
      repositoryId: input.repositoryId,
      baseBranch,
      baseCommit: repository.observed_commit,
      repositorySnapshot,
      resolvedInputs: {
        plannerAId,
        plannerBId,
        synthesizerAssignmentId: synthesizerId,
        executorAssignmentId: executorId,
        implementationReviewerAssignmentId: reviewer?.assignmentId ?? null,
        planningSchemaVersion: "consensus-plan/1",
      },
    },
  });
  await appendConsensus({
    actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
    commandId: stableUuid(`${input.commandId}:consensus`),
    missionId,
    commandType: "CreateConsensusPlan",
    events: [
      {
        eventType: "consensus.created",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: input.repositoryId,
          baseBranch,
          repositoryBaseCommit: repository.observed_commit,
          repositorySnapshot,
          repositoryAuthorityHash: repository.repository_authority_hash,
          planningSchemaVersion: "consensus-plan/1",
          synthesizerAssignmentId: synthesizerId,
          preferredExecutorAgentId: input.preferredExecutorAgentId ?? null,
          preferredExecutorModelId: input.preferredExecutorModelId ?? null,
          executionBudget: consensusChildExecutionBudget,
          requireImplementationReview: false,
          maximumTurns: 10,
          maximumDurationSeconds,
          maximumCostAmount: input.maximumCostAmount ?? null,
          costCurrency: input.costCurrency ?? "USD",
          maximumArtifactBytes: Math.min(Math.max(input.maximumArtifactBytes ?? 131_072, 1024), 131_072),
          maximumCommandCount: Math.min(Math.max(input.maximumCommandCount ?? 100, 1), 1000),
          maximumRetryCount: Math.min(Math.max(input.maximumRetryCount ?? 2, 0), 10),
          deadlineAt,
          participants: [plannerA, plannerB, synthesizer, executor, ...(reviewer ? [reviewer] : [])],
        },
      },
    ],
  });
  const system = { workspaceId: input.actor.workspaceId, id: "consensus-coordinator", type: "system" as const };
  await transitionConsensus({
    actor: system,
    commandId: stableUuid(`${missionId}:ready`),
    missionId,
    target: "ready",
  });
  await handleMissionTransition({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:planned`),
    missionId,
    target: "planned",
  });
  await dispatchConsensusTurn({
    actor: system,
    missionId,
    role: "synthesizer",
    operation: "prepare_context",
    round: 1,
    sourceArtifactIds: [],
  });
  await handleMissionTransition({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:running`),
    missionId,
    target: "running",
  });
  return { missionId, repositorySnapshot, repositoryBaseCommit: repository.observed_commit };
}

async function participantForRole(workspaceId: string, missionId: string, role: ConsensusParticipantRole) {
  const row = (
    await getDatabasePool().query<{
      participant_assignment_id: string;
      agent_id: string;
      role: ConsensusParticipantRole;
      provider_id: string;
      model_id: string;
      capability_attestation_id: string;
      capability_attestation_hash: string;
      required_operations: AgentOperation[];
      permission_profile_hash: string;
      runtime_model_identity: string;
    }>(`SELECT * FROM consensus_participant_assignments WHERE workspace_id=$1 AND mission_id=$2 AND role=$3`, [
      workspaceId,
      missionId,
      role,
    ])
  ).rows[0];
  if (!row) throw new NotFoundError("Consensus participant");
  return row;
}

async function dispatchConsensusTurn(input: {
  actor: ConsensusActor;
  missionId: string;
  role: "planner_a" | "planner_b" | "synthesizer";
  operation: ConsensusOperation;
  round: number;
  sourceArtifactIds: string[];
}) {
  const state = await projection(input.actor.workspaceId, input.missionId);
  if (state.status !== allowedStatus[input.operation])
    throw new ValidationFailedError(`Consensus operation ${input.operation} is not available in ${state.status}`);
  const taskId = stableUuid(`${input.missionId}:${input.role}:${input.operation}:${input.round}:task`);
  const executionId = stableUuid(`${input.missionId}:${input.role}:${input.operation}:${input.round}:execution`);
  const turnId = stableUuid(`${input.missionId}:${input.role}:${input.operation}:${input.round}:turn`);
  const existingTurn = await getDatabasePool().query(
    "SELECT 1 FROM consensus_turns WHERE workspace_id=$1 AND turn_id=$2",
    [input.actor.workspaceId, turnId],
  );
  if (existingTurn.rowCount) return { turnId, taskId, executionId };
  const recoveringExecution = await getDatabasePool().query(
    "SELECT 1 FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
    [input.actor.workspaceId, executionId],
  );
  const stopForLimit = async (reason: string) => {
    await transitionConsensus({
      actor: input.actor,
      commandId: stableUuid(`${input.missionId}:limit:${reason}`),
      missionId: input.missionId,
      target: state.status === "ready" ? "failed" : "consensus_not_reached",
      reason,
      consensusDecision: state.status === "ready" ? undefined : "not_reached",
    });
    return undefined;
  };
  if (!recoveringExecution.rowCount && new Date(state.deadline_at).getTime() <= Date.now())
    return stopForLimit("Consensus planning duration limit reached before another turn");
  const turnCount = await getDatabasePool().query<{ count: number }>(
    "SELECT count(*)::int count FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2",
    [input.actor.workspaceId, input.missionId],
  );
  if (!recoveringExecution.rowCount && turnCount.rows[0].count >= state.maximum_turns)
    return stopForLimit("Consensus planning turn limit reached before another turn");
  if (!recoveringExecution.rowCount && state.maximum_cost_amount !== null) {
    const cost = (
      await getDatabasePool().query<{ known: string; unknown: number }>(
        `SELECT COALESCE(sum(cost_amount) FILTER(WHERE currency=$3),0)::text known,
         count(*) FILTER(WHERE cost_confidence='unknown')::int unknown
         FROM usage_records WHERE workspace_id=$1 AND mission_id=$2`,
        [input.actor.workspaceId, input.missionId, state.cost_currency],
      )
    ).rows[0];
    if (Number(cost.known) >= Number(state.maximum_cost_amount) || cost.unknown > 0)
      return stopForLimit(
        cost.unknown > 0
          ? "Consensus cost is unknown; another turn cannot safely start within the configured budget"
          : "Consensus planning cost limit reached before another turn",
      );
  }
  const participant = await participantForRole(input.actor.workspaceId, input.missionId, input.role);
  const eligibility = recoveringExecution.rowCount
    ? undefined
    : await evaluateAgentEligibility({
        workspaceId: input.actor.workspaceId,
        agentId: participant.agent_id,
        domain: "software_delivery",
        requiredCapabilities: operationCapabilities[input.operation],
        requiredResources: [{ resourceType: "repository", resourceId: state.repository_id, permission: "read" }],
        protocolVersion: "1.0",
        requiredMissionRole: input.operation === "verdict" ? "reviewer" : "planner",
        requiredOperation: providerOperations[input.operation],
        requiredModel: participant.model_id,
        requiredModelRole: input.role === "synthesizer" ? "synthesizer" : "planner",
        requireStructuredOutput: true,
        requireProjectBrainContext: true,
        requireVerifiedMissionAgentArtifact: true,
      });
  if (
    eligibility &&
    (!eligibility.eligible ||
      eligibility.providerId !== participant.provider_id ||
      eligibility.capabilityAttestationId !== participant.capability_attestation_id ||
      eligibility.capabilityAttestationHash !== participant.capability_attestation_hash)
  )
    return stopForLimit(
      `Consensus participant ${input.role} became ineligible before ${input.operation}: ${eligibility.reasons.join("; ")}`,
    );
  const instructions = {
    prepare_context: "Generate one deterministic Project Brain context pack for the exact repository snapshot.",
    proposal:
      "Produce an independent structured implementation proposal without access to the other planner's proposal.",
    critique: "Critique the exact opposite planner proposal using the versioned structured critique schema.",
    revision: "Revise your proposal once in response to the exact critique of your proposal.",
    canonicalize:
      "Synthesize the complete immutable planning package into one canonical implementation plan. The validation_plan MUST include at least one exact command supplied by Mission Control under the repository owner's existing validation authority. Propose it only; do not execute it or claim execution authority.",
    verdict: "Independently review the exact immutable canonical plan and issue a hash-bound verdict.",
  }[input.operation];
  await handleCreateTask({
    actor: input.actor,
    commandId: stableUuid(`${turnId}:task`),
    taskId,
    task: {
      missionId: input.missionId,
      name: `${input.role.replace("_", " ")} · ${input.operation.replace("_", " ")}`,
      instructions,
      expectedOutput: artifactForOperation[input.operation],
      priority: "normal",
      riskLevel: "low",
      requiredCapabilities: operationCapabilities[input.operation],
      requiredResources: [{ resourceType: "repository", resourceId: state.repository_id, permission: "read" }],
      maximumAttempts: state.maximum_retry_count + 1,
      timeoutSeconds: Math.min(state.maximum_duration_seconds, 3600),
      approvalPolicy: {
        missionType: "consensus_plan",
        consensusOperation: input.operation,
        participantAssignmentId: participant.participant_assignment_id,
        participantRole: input.role,
        planningRound: input.round,
        sourceArtifactIds: input.sourceArtifactIds,
      },
      verificationRequirements:
        input.operation === "canonicalize"
          ? ((
              await getDatabasePool().query<{ validation_commands: string[][] }>(
                `SELECT validation_commands FROM repositories
                 WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
                [input.actor.workspaceId, state.repository_id],
              )
            ).rows[0]?.validation_commands.map((command) => command.join(" ")) ?? [])
          : [],
    },
  });
  if (!recoveringExecution.rowCount) {
    await handleTaskTransition({
      actor: input.actor,
      commandId: stableUuid(`${turnId}:ready`),
      taskId,
      target: "ready",
    });
    try {
      await handleRequestRemoteExecution({
        actor: input.actor,
        commandId: stableUuid(`${turnId}:execution`),
        executionId,
        taskId,
        agentId: participant.agent_id,
        timeoutSeconds: Math.min(state.maximum_duration_seconds, 3600),
      });
    } catch (error) {
      await handleTaskTransition({
        actor: input.actor,
        commandId: stableUuid(`${turnId}:dispatch-cancelled`),
        taskId,
        target: "cancelled",
        details: { reason: "consensus_participant_became_ineligible" },
      });
      return stopForLimit(
        `Consensus participant ${input.role} could not start ${input.operation}: ${error instanceof Error ? error.message : "dispatch rejected"}`,
      );
    }
  }
  await appendConsensus({
    actor: input.actor,
    commandId: stableUuid(`${turnId}:record`),
    missionId: input.missionId,
    commandType: "RequestConsensusTurn",
    events: [
      {
        eventType: "consensus.turn_requested",
        eventSchemaVersion: 1,
        payload: {
          turnId,
          participantAssignmentId: participant.participant_assignment_id,
          role: input.role,
          operation: input.operation,
          round: input.round,
          taskId,
          executionId,
          sourceArtifactIds: input.sourceArtifactIds,
        },
      },
    ],
  });
  return { turnId, taskId, executionId };
}

export async function recordConsensusArtifact(input: {
  actor: ConsensusActor;
  messageId: string;
  missionId: string;
  taskId: string;
  executionId: string;
  artifactId: string;
  artifactKind: string;
  artifactChecksum: string;
  body: Buffer;
  /** Deterministic concurrency-test seam; production callers never provide it. */
  afterValidation?: () => Promise<void>;
}) {
  if (!consensusArtifactKinds.includes(input.artifactKind as ConsensusArtifactKind)) return undefined;
  const state = await projection(input.actor.workspaceId, input.missionId);
  const turn = (
    await getDatabasePool().query<{
      turn_id: string;
      operation: ConsensusOperation;
      round: number;
      participant_assignment_id: string;
      source_artifact_ids: string[];
      task_id: string;
      execution_id: string;
    }>(`SELECT * FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND task_id=$3 AND execution_id=$4`, [
      input.actor.workspaceId,
      input.missionId,
      input.taskId,
      input.executionId,
    ])
  ).rows[0];
  if (!turn) throw new ValidationFailedError("Artifact is not bound to an active consensus turn");
  if (state.status !== allowedStatus[turn.operation])
    throw new ValidationFailedError("Consensus artifact is stale for the active mission phase");
  const expectedKind = artifactForOperation[turn.operation];
  if (input.artifactKind !== expectedKind)
    throw new ValidationFailedError(`Consensus turn requires artifact kind ${expectedKind}`);
  let parsed: ParsedConsensusArtifact | undefined;
  let contextPackHash = state.context_pack_hash;
  let schemaVersion = state.planning_schema_version;
  let canonicalPlanHash: string | undefined;
  let resolvedObjections:
    Array<{ objectionId: string; rawProviderObjectionId: string; sourceCritiqueArtifactId: string }> | undefined;
  if (expectedKind === "project_brain_context_pack") {
    if (!input.body.length || input.body.length > state.maximum_artifact_bytes)
      throw new ValidationFailedError("Project Brain context pack is empty or oversized");
    assertProjectBrainContextPack(input.body, state.repository_base_commit);
    contextPackHash = input.artifactChecksum;
    schemaVersion = "project-brain-context-pack/2.5.0";
  } else {
    parsed = parseConsensusArtifact(expectedKind, input.body);
    schemaVersion = parsed.schemaVersion;
    const payload = parsed.normalized;
    if (
      payload.mission_id !== input.missionId ||
      (expectedKind !== "canonical_implementation_plan" && payload.assignment_id !== turn.participant_assignment_id)
    )
      throw new ValidationFailedError("Consensus artifact mission or assignment binding does not match");
    if (
      expectedKind !== "canonical_plan_verdict" &&
      (payload.repository_snapshot !== state.repository_snapshot ||
        payload.context_pack_hash !== state.context_pack_hash)
    )
      throw new ValidationFailedError("Consensus artifact snapshot or context binding does not match");
    if (parsed.reviewedArtifactId && !turn.source_artifact_ids.includes(parsed.reviewedArtifactId))
      throw new ValidationFailedError("Consensus artifact reviews an artifact outside its released source package");
    if (expectedKind === "consensus_revision") {
      if (
        !parsed.revisesProposalArtifactId ||
        !turn.source_artifact_ids.includes(parsed.revisesProposalArtifactId) ||
        turn.source_artifact_ids.length !== 2
      )
        throw new ValidationFailedError("Revision must bind the exact released proposal and critique");
      const revisionSources = await getDatabasePool().query<{
        artifact_id: string;
        artifact_kind: string;
        participant_assignment_id: string;
        reviewed_artifact_id: string | null;
        round: number;
        normalized_payload: Record<string, unknown> | null;
      }>(
        `SELECT artifact_id,artifact_kind,participant_assignment_id,reviewed_artifact_id,round,normalized_payload
         FROM consensus_artifacts WHERE workspace_id=$1 AND mission_id=$2 AND artifact_id=ANY($3::uuid[])`,
        [input.actor.workspaceId, input.missionId, turn.source_artifact_ids],
      );
      const proposal = revisionSources.rows.find(
        (source) =>
          source.artifact_id === parsed!.revisesProposalArtifactId && source.artifact_kind === "consensus_proposal",
      );
      const critique = revisionSources.rows.find(
        (source) => source.artifact_id === parsed!.reviewedArtifactId && source.artifact_kind === "consensus_critique",
      );
      if (
        !proposal ||
        !critique ||
        proposal.participant_assignment_id !== turn.participant_assignment_id ||
        critique.reviewed_artifact_id !== proposal.artifact_id ||
        critique.participant_assignment_id === turn.participant_assignment_id
      )
        throw new ValidationFailedError("Revision provenance does not match its planner proposal and cross-critique");
      const requestedRawIds = parsed.normalized.resolved_objection_ids;
      if (!Array.isArray(requestedRawIds) || requestedRawIds.some((id) => typeof id !== "string"))
        throw new ValidationFailedError("Revision objection resolution IDs are invalid");
      if (new Set(requestedRawIds).size !== requestedRawIds.length)
        throw new ValidationFailedError("Revision objection resolution IDs must be unique");
      const rawCritiqueObjections = Array.isArray(critique.normalized_payload?.blocking_objections)
        ? critique.normalized_payload.blocking_objections
        : [];
      const availableRawIds = new Set(
        rawCritiqueObjections.map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? String((entry as Record<string, unknown>).id ?? "")
            : "",
        ),
      );
      if (requestedRawIds.some((id) => !availableRawIds.has(id)))
        throw new ValidationFailedError("Revision references an unknown provider objection ID for its exact critique");
      resolvedObjections = requestedRawIds.map((rawProviderObjectionId) => ({
        objectionId: canonicalConsensusObjectionId({
          missionId: input.missionId,
          consensusAttempt: state.consensus_attempt,
          sourceArtifactId: critique.artifact_id,
          participantAssignmentId: critique.participant_assignment_id,
          round: critique.round,
          rawProviderObjectionId,
        }),
        rawProviderObjectionId,
        sourceCritiqueArtifactId: critique.artifact_id,
      }));
    }
    if (expectedKind === "canonical_implementation_plan") {
      const expectedSources = [...turn.source_artifact_ids].sort();
      const actualSources = [...(parsed.sourceArtifactIds ?? [])].sort();
      if (JSON.stringify(expectedSources) !== JSON.stringify(actualSources))
        throw new ValidationFailedError("Canonical plan source artifacts do not match the immutable synthesis package");
      canonicalPlanHash = parsed.canonicalPlanHash;
    }
    if (expectedKind === "canonical_plan_verdict") {
      assertCanonicalPlanVerdictAuthority(
        {
          reviewedArtifactId: parsed.reviewedArtifactId,
          canonicalPlanHash: parsed.canonicalPlanHash,
        },
        {
          reviewedArtifactId: state.canonical_plan_artifact_id,
          canonicalPlanHash: state.canonical_plan_hash,
        },
      );
      canonicalPlanHash = parsed.canonicalPlanHash;
    }
  }
  const events: NewDomainEvent[] = [
    {
      eventType: "consensus.artifact_recorded",
      eventSchemaVersion: 1,
      payload: {
        artifactId: input.artifactId,
        artifactKind: expectedKind,
        turnId: turn.turn_id,
        participantAssignmentId: turn.participant_assignment_id,
        round: turn.round,
        schemaVersion,
        repositorySnapshot: state.repository_snapshot,
        contextPackHash,
        reviewedArtifactId: parsed?.reviewedArtifactId ?? null,
        revisesProposalArtifactId: parsed?.revisesProposalArtifactId ?? null,
        priorRevisionArtifactId: null,
        canonicalPlanHash: canonicalPlanHash ?? null,
        verdict: parsed?.verdict ?? null,
        consensusAttempt: state.consensus_attempt,
        blockingObjectionCount: parsed?.blockingObjections.length ?? 0,
        blockingObjections:
          parsed?.blockingObjections.map((objection) => ({
            objectionId: canonicalConsensusObjectionId({
              missionId: input.missionId,
              consensusAttempt: state.consensus_attempt,
              sourceArtifactId: input.artifactId,
              participantAssignmentId: turn.participant_assignment_id,
              round: turn.round,
              rawProviderObjectionId: objection.id,
            }),
            rawProviderObjectionId: objection.id,
            category: objection.category,
            description: objection.description,
            requiredChange: objection.requiredChange,
          })) ?? [],
        normalizedPayload: parsed?.normalized ?? null,
        artifactChecksum: input.artifactChecksum,
      },
    },
  ];
  if (expectedKind === "consensus_revision") {
    if (resolvedObjections?.length)
      events.push({
        eventType: "consensus.objections_resolved",
        eventSchemaVersion: 1,
        payload: {
          objectionIds: resolvedObjections.map((objection) => objection.objectionId),
          rawProviderObjectionIds: resolvedObjections.map((objection) => objection.rawProviderObjectionId),
          sourceCritiqueArtifactId: resolvedObjections[0].sourceCritiqueArtifactId,
          resolvedByArtifactId: input.artifactId,
        },
      });
  }
  await input.afterValidation?.();
  await appendConsensus({
    actor: input.actor,
    commandId: stableUuid(`consensus-artifact:${input.messageId}`),
    missionId: input.missionId,
    commandType: "RecordConsensusArtifact",
    events,
    beforeAppend: async (client) => {
      const current = (
        await client.query<{ status: ConsensusStatus }>(
          `SELECT status FROM consensus_plan_projections
           WHERE workspace_id=$1 AND mission_id=$2 FOR UPDATE`,
          [input.actor.workspaceId, input.missionId],
        )
      ).rows[0];
      const assignment = (
        await client.query<{ output_fenced_at: Date | null }>(
          `SELECT output_fenced_at FROM pull_assignments
           WHERE workspace_id=$1 AND execution_id=$2 FOR UPDATE`,
          [input.actor.workspaceId, input.executionId],
        )
      ).rows[0];
      if (!current || current.status !== allowedStatus[turn.operation] || !assignment || assignment.output_fenced_at)
        throw new ValidationFailedError("Consensus artifact was fenced before its canonical append");
      const duplicate = await client.query(
        `SELECT 1 FROM consensus_artifacts
         WHERE workspace_id=$1 AND turn_id=$2 AND artifact_kind=$3`,
        [input.actor.workspaceId, turn.turn_id, expectedKind],
      );
      if (duplicate.rowCount) throw new ValidationFailedError("Consensus turn already has its required artifact");
    },
  });
  return { artifactId: input.artifactId, artifactKind: expectedKind, canonicalPlanHash };
}

export function assertCanonicalPlanVerdictAuthority(
  attempted: { reviewedArtifactId: string | undefined; canonicalPlanHash: string | undefined },
  authoritative: { reviewedArtifactId: string | null; canonicalPlanHash: string | null },
) {
  if (
    attempted.reviewedArtifactId !== authoritative.reviewedArtifactId ||
    attempted.canonicalPlanHash !== authoritative.canonicalPlanHash
  )
    throw new ValidationFailedError("Verdict does not bind the active canonical plan and hash", {
      reason_code: "CANONICAL_PLAN_HASH_MISMATCH",
    });
}

async function artifactsForOperation(workspaceId: string, missionId: string, operation: ConsensusOperation) {
  return (
    await getDatabasePool().query<{
      artifact_id: string;
      participant_assignment_id: string;
      reviewed_artifact_id: string | null;
      canonical_plan_hash: string | null;
      verdict: string | null;
      blocking_objection_count: number;
    }>(
      `SELECT a.artifact_id,a.participant_assignment_id,a.reviewed_artifact_id,a.canonical_plan_hash,a.verdict,a.blocking_objection_count
       FROM consensus_artifacts a JOIN consensus_turns t ON t.workspace_id=a.workspace_id AND t.turn_id=a.turn_id
       JOIN artifacts stored ON stored.workspace_id=a.workspace_id AND stored.artifact_id=a.artifact_id
         AND stored.deleted_at IS NULL AND stored.checksum_sha256=a.artifact_checksum
       WHERE a.workspace_id=$1 AND a.mission_id=$2 AND t.operation=$3 ORDER BY a.created_at`,
      [workspaceId, missionId, operation],
    )
  ).rows;
}

export async function advanceConsensusAfterTask(
  workspaceId: string,
  missionId: string,
  taskId: string,
  eventType = "task.completed",
) {
  const turn = (
    await getDatabasePool().query<{ operation: ConsensusOperation; status: string }>(
      "SELECT operation,status FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND task_id=$3",
      [workspaceId, missionId, taskId],
    )
  ).rows[0];
  if (!turn) return;
  const actor = { workspaceId, id: "consensus-coordinator", type: "system" as const };
  if (eventType !== "task.completed") {
    const current = await projection(workspaceId, missionId);
    if (["failed", "cancelled", "rejected", "consensus_not_reached"].includes(current.status)) return;
    const turns = (
      await getDatabasePool().query<{
        task_id: string;
        execution_id: string;
        participant_assignment_id: string;
        execution_status: string;
      }>(
        `SELECT t.task_id,t.execution_id,t.participant_assignment_id,e.status execution_status
         FROM consensus_turns t
         JOIN execution_projections e ON e.workspace_id=t.workspace_id AND e.execution_id=t.execution_id
         WHERE t.workspace_id=$1 AND t.mission_id=$2 AND t.operation=$3`,
        [workspaceId, missionId, turn.operation],
      )
    ).rows;
    const reason = `Required planner turn ended as ${eventType}`;
    assertConsensusTransition(current.status, "failed");
    await appendConsensus({
      actor,
      commandId: stableUuid(`${missionId}:${taskId}:turn-failed`),
      missionId,
      commandType: "FailConsensusTurn",
      events: [
        {
          eventType: "consensus.turn_failed",
          eventSchemaVersion: 1,
          payload: { taskId, operation: turn.operation, reason: eventType },
        },
        ...turns.map((candidate) => ({
          eventType: "consensus.assignment_output_fenced",
          eventSchemaVersion: 1,
          payload: {
            taskId: candidate.task_id,
            executionId: candidate.execution_id,
            participantAssignmentId: candidate.participant_assignment_id,
            triggeringTaskId: taskId,
            reason: "initial_planner_terminal_failure",
          },
        })),
        {
          eventType: "consensus.status_changed",
          eventSchemaVersion: 1,
          payload: { status: "failed", reason, consensusDecision: null },
        },
      ],
      beforeAppend: async (client) => {
        const executionIds = turns.map((candidate) => candidate.execution_id);
        if (!executionIds.length) return;
        await client.query(
          `UPDATE pull_assignments SET output_fenced_at=COALESCE(output_fenced_at,now()),
             output_fence_reason=COALESCE(output_fence_reason,'initial_planner_terminal_failure'),updated_at=now()
           WHERE workspace_id=$1 AND execution_id=ANY($2::uuid[])`,
          [workspaceId, executionIds],
        );
        await client.query(
          `UPDATE execution_projections SET cancellation_requested_at=COALESCE(cancellation_requested_at,now())
           WHERE workspace_id=$1 AND execution_id=ANY($2::uuid[])
             AND status NOT IN('succeeded','failed','timed_out','cancelled')`,
          [workspaceId, executionIds],
        );
      },
    });
    await handleMissionTransition({
      actor: { workspaceId, userId: actor.id, role: "owner" },
      commandId: stableUuid(`${missionId}:mission:failed:planner-fail-fast`),
      missionId,
      target: "failed",
    });
    await Promise.all(
      turns
        .filter(
          (candidate) =>
            candidate.task_id !== taskId &&
            !["succeeded", "failed", "timed_out", "cancelled"].includes(candidate.execution_status),
        )
        .map((candidate) =>
          handleExecutionCancellation({
            actor,
            commandId: stableUuid(`${missionId}:${candidate.execution_id}:planner-fail-fast-cancel`),
            executionId: candidate.execution_id,
          }),
        ),
    );
    return;
  }
  if (turn.status !== "completed") {
    const expectedArtifact = await getDatabasePool().query(
      `SELECT 1 FROM consensus_artifacts a JOIN consensus_turns t ON t.workspace_id=a.workspace_id AND t.turn_id=a.turn_id
       WHERE a.workspace_id=$1 AND a.mission_id=$2 AND t.task_id=$3 AND a.artifact_kind=$4`,
      [workspaceId, missionId, taskId, artifactForOperation[turn.operation]],
    );
    if (!expectedArtifact.rowCount)
      throw new ValidationFailedError("Consensus turn completed without its required artifact");
    await appendConsensus({
      actor,
      commandId: stableUuid(`${missionId}:${taskId}:turn-complete`),
      missionId,
      commandType: "CompleteConsensusTurn",
      events: [
        {
          eventType: "consensus.turn_completed",
          eventSchemaVersion: 1,
          payload: { taskId, operation: turn.operation },
        },
      ],
    });
  }
  const phaseTurns = await getDatabasePool().query<{ total: number; complete: number }>(
    `SELECT count(*)::int total,count(*) FILTER(WHERE status='completed')::int complete
     FROM consensus_turns WHERE workspace_id=$1 AND mission_id=$2 AND operation=$3`,
    [workspaceId, missionId, turn.operation],
  );
  if (phaseTurns.rows[0].total !== phaseTurns.rows[0].complete) return;
  const participants = await Promise.all([
    participantForRole(workspaceId, missionId, "planner_a"),
    participantForRole(workspaceId, missionId, "planner_b"),
  ]);
  if (turn.operation === "prepare_context") {
    const context = await artifactsForOperation(workspaceId, missionId, "prepare_context");
    if (context.length !== 1) throw new ValidationFailedError("Consensus requires exactly one context pack");
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:capture-proposals`),
      missionId,
      target: "capturing_independent_proposals",
    });
    for (const role of ["planner_a", "planner_b"] as const) {
      if (
        !(await dispatchConsensusTurn({
          actor,
          missionId,
          role,
          operation: "proposal",
          round: 1,
          sourceArtifactIds: [],
        }))
      )
        return;
    }
    return;
  }
  if (turn.operation === "proposal") {
    const proposals = await artifactsForOperation(workspaceId, missionId, "proposal");
    if (proposals.length !== 2) throw new ValidationFailedError("Consensus requires exactly two proposals");
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:proposals-complete`),
      missionId,
      target: "proposals_complete",
    });
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:critique-round`),
      missionId,
      target: "critique_round",
    });
    for (const participant of participants) {
      const opposite = proposals.find(
        (proposal) => proposal.participant_assignment_id !== participant.participant_assignment_id,
      )!;
      if (
        !(await dispatchConsensusTurn({
          actor,
          missionId,
          role: participant.role as "planner_a" | "planner_b",
          operation: "critique",
          round: 1,
          sourceArtifactIds: [opposite.artifact_id],
        }))
      )
        return;
    }
    return;
  }
  if (turn.operation === "critique") {
    const proposals = await artifactsForOperation(workspaceId, missionId, "proposal");
    const critiques = await artifactsForOperation(workspaceId, missionId, "critique");
    if (critiques.length !== 2) throw new ValidationFailedError("Consensus requires exactly two critiques");
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:revision-round`),
      missionId,
      target: "revision_round",
    });
    for (const participant of participants) {
      const ownProposal = proposals.find(
        (proposal) => proposal.participant_assignment_id === participant.participant_assignment_id,
      )!;
      const receivedCritique = critiques.find((critique) => critique.reviewed_artifact_id === ownProposal.artifact_id)!;
      if (
        !(await dispatchConsensusTurn({
          actor,
          missionId,
          role: participant.role as "planner_a" | "planner_b",
          operation: "revision",
          round: 1,
          sourceArtifactIds: [ownProposal.artifact_id, receivedCritique.artifact_id],
        }))
      )
        return;
    }
    return;
  }
  if (turn.operation === "revision") {
    const sources = [
      ...(await artifactsForOperation(workspaceId, missionId, "proposal")),
      ...(await artifactsForOperation(workspaceId, missionId, "critique")),
      ...(await artifactsForOperation(workspaceId, missionId, "revision")),
    ].map((item) => item.artifact_id);
    if (sources.length !== 6) throw new ValidationFailedError("Synthesis requires the complete six-artifact package");
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:canonicalization`),
      missionId,
      target: "canonicalization",
    });
    if (
      !(await dispatchConsensusTurn({
        actor,
        missionId,
        role: "synthesizer",
        operation: "canonicalize",
        round: 1,
        sourceArtifactIds: sources,
      }))
    )
      return;
    return;
  }
  if (turn.operation === "canonicalize") {
    const canonical = await artifactsForOperation(workspaceId, missionId, "canonicalize");
    if (canonical.length !== 1) throw new ValidationFailedError("Consensus requires exactly one canonical plan");
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:await-verdicts`),
      missionId,
      target: "awaiting_final_verdicts",
    });
    for (const participant of participants) {
      if (
        !(await dispatchConsensusTurn({
          actor,
          missionId,
          role: participant.role as "planner_a" | "planner_b",
          operation: "verdict",
          round: 1,
          sourceArtifactIds: [canonical[0].artifact_id],
        }))
      )
        return;
    }
    return;
  }
  if (turn.operation === "verdict") {
    const verdicts = await artifactsForOperation(workspaceId, missionId, "verdict");
    if (verdicts.length !== 2) return;
    const openBlockers = await getDatabasePool().query<{ count: number }>(
      "SELECT count(*)::int count FROM consensus_objections WHERE workspace_id=$1 AND mission_id=$2 AND status='open'",
      [workspaceId, missionId],
    );
    const reached =
      new Set(verdicts.map((item) => item.canonical_plan_hash)).size === 1 &&
      verdicts.every(
        (item) =>
          ["approve", "approve_with_non_blocking_notes"].includes(item.verdict ?? "") &&
          item.blocking_objection_count === 0,
      ) &&
      openBlockers.rows[0].count === 0;
    await transitionConsensus({
      actor,
      commandId: stableUuid(`${missionId}:consensus-decision`),
      missionId,
      target: reached ? "consensus_reached" : "consensus_not_reached",
      reason: reached
        ? "Both exact-plan verdicts approved with no unresolved blockers"
        : "Verdicts or blockers disagree",
      consensusDecision: reached ? "reached" : "not_reached",
    });
    if (reached) {
      await transitionConsensus({
        actor,
        commandId: stableUuid(`${missionId}:await-human-approval`),
        missionId,
        target: "awaiting_human_approval",
      });
      await requestConsensusApproval(workspaceId, missionId);
    }
  }
}

async function requestConsensusApproval(workspaceId: string, missionId: string) {
  const state = await projection(workspaceId, missionId);
  if (!state.canonical_plan_artifact_id || !state.canonical_plan_hash || !state.project_brain_context_artifact_id)
    throw new ValidationFailedError("Canonical plan is required before approval");
  const evidenceRows = await getDatabasePool().query<{ artifact_id: string; checksum_sha256: string }>(
    `SELECT a.artifact_id,a.checksum_sha256 FROM artifacts a
     WHERE a.workspace_id=$1 AND a.artifact_id=ANY($2::uuid[]) AND a.deleted_at IS NULL`,
    [workspaceId, [state.canonical_plan_artifact_id, state.project_brain_context_artifact_id]],
  );
  if (evidenceRows.rowCount !== 2) throw new ValidationFailedError("Approval evidence artifacts are unavailable");
  const checksumFor = (artifactId: string | null) =>
    evidenceRows.rows.find((row) => row.artifact_id === artifactId)?.checksum_sha256;
  const executorAssignment = await participantForRole(workspaceId, missionId, "executor");
  const canonical = (
    await getDatabasePool().query<{ normalized_payload: Record<string, unknown> }>(
      `SELECT c.normalized_payload FROM consensus_artifacts c JOIN artifacts a
         ON a.workspace_id=c.workspace_id AND a.artifact_id=c.artifact_id
         AND a.deleted_at IS NULL AND a.checksum_sha256=c.artifact_checksum
       WHERE c.workspace_id=$1 AND c.mission_id=$2 AND c.artifact_kind='canonical_implementation_plan'`,
      [workspaceId, missionId],
    )
  ).rows[0];
  const repository = (
    await getDatabasePool().query<{ validation_commands: string[][]; repository_authority_hash: string | null }>(
      `SELECT validation_commands,repository_authority_hash FROM repositories
       WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
      [workspaceId, state.repository_id],
    )
  ).rows[0];
  if (!canonical?.normalized_payload || !repository)
    throw new ValidationFailedError("Canonical plan or repository validation policy is unavailable");
  await assertCurrentRepositoryAuthority(workspaceId, state.repository_id, state.repository_authority_hash);
  const validationCommands = governedValidationCommands(
    canonical.normalized_payload.validation_plan,
    repository.validation_commands,
  );
  if (!validationCommands.length)
    throw new ValidationFailedError("Consensus approval requires at least one owner-governed validation command");
  const approvalId = stableUuid(`consensus-approval:${missionId}:${state.canonical_plan_hash}`);
  const childMissionId = stableUuid(`consensus-child:${missionId}:${state.canonical_plan_hash}`);
  const action = {
    actionType: "repository.modify",
    authoritySource: "consensus_plan",
    missionId,
    childMissionId,
    repositoryId: state.repository_id,
    baseBranch: state.base_branch,
    repositorySnapshot: state.repository_snapshot,
    repositoryBaseCommit: state.repository_base_commit,
    repositoryAuthorityHash: state.repository_authority_hash,
    contextPackHash: state.context_pack_hash,
    canonicalPlanArtifactId: state.canonical_plan_artifact_id,
    canonicalPlanHash: state.canonical_plan_hash,
    executorAgentId: state.preferred_executor_agent_id,
    executorModelId: state.preferred_executor_model_id,
    executorProviderId: executorAssignment.provider_id,
    executorAssignmentId: executorAssignment.participant_assignment_id,
    capabilityAttestationId: executorAssignment.capability_attestation_id,
    capabilityAttestationHash: executorAssignment.capability_attestation_hash,
    permissionProfileHash: executorAssignment.permission_profile_hash,
    executionBudget: state.execution_budget,
    validationCommands,
    authorizedEffects: ["worktree.create", "worktree.write", "validation.run", "git.commit_local"],
    prohibitedEffects: [
      "git.commit_provider",
      "git.push",
      "pull_request.create",
      "repository.merge",
      "repository.publish",
      "deployment.execute",
      "infrastructure.mutate",
    ],
  };
  await appendEvents({
    workspaceId,
    aggregateType: "approval",
    aggregateId: approvalId,
    missionId,
    expectedVersion: 0,
    commandId: stableUuid(`${approvalId}:request`),
    commandType: "RequestConsensusPlanApproval",
    correlationId: missionId,
    actor: { type: "system", id: "consensus-coordinator" },
    events: [
      {
        eventType: "approval.requested",
        eventSchemaVersion: 1,
        payload: {
          taskId: null,
          executionId: null,
          approvalType: "consensus_plan",
          requestedAction: action,
          actionHash: canonicalHash(action),
          riskExplanation:
            "One human decision authorizes the exact immutable plan, selected executor/model, isolated repository writes, governed validation, and one local commit; push, pull request, merge, and deployment remain prohibited",
          riskLevel: "high",
          evidence: [
            {
              artifactId: state.canonical_plan_artifact_id,
              checksum: checksumFor(state.canonical_plan_artifact_id),
              semanticHash: state.canonical_plan_hash,
            },
            {
              artifactId: state.project_brain_context_artifact_id,
              checksum: checksumFor(state.project_brain_context_artifact_id),
            },
          ],
          requestedBy: "consensus-coordinator",
          supportingEvidenceSummary:
            "Two independent proposals, critiques, revisions, exact-plan verdicts, and immutable hashes",
          status: "pending",
        },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  await appendConsensus({
    actor: { workspaceId, id: "consensus-coordinator", type: "system" },
    commandId: stableUuid(`${approvalId}:link`),
    missionId,
    commandType: "LinkConsensusApproval",
    events: [{ eventType: "consensus.approval_requested", eventSchemaVersion: 1, payload: { approvalId } }],
  });
  return approvalId;
}

export async function onConsensusApprovalDecision(input: {
  workspaceId: string;
  approvalId: string;
  granted: boolean;
  actorId: string;
}) {
  const state = (
    await getDatabasePool().query<ConsensusProjection>(
      "SELECT * FROM consensus_plan_projections WHERE workspace_id=$1 AND human_approval_id=$2",
      [input.workspaceId, input.approvalId],
    )
  ).rows[0];
  if (!state) return undefined;
  if (input.granted) {
    try {
      await assertCurrentRepositoryAuthority(input.workspaceId, state.repository_id, state.repository_authority_hash);
    } catch (error) {
      if (!(error instanceof ValidationFailedError)) throw error;
      return transitionConsensus({
        actor: { workspaceId: input.workspaceId, id: input.actorId, type: "human" },
        commandId: stableUuid(`consensus-approval-authority-invalid:${input.approvalId}`),
        missionId: state.mission_id,
        target: "rejected",
        reason:
          "Repository authority changed; the granted approval cannot be consumed and a new plan approval is required",
      });
    }
  }
  return transitionConsensus({
    actor: { workspaceId: input.workspaceId, id: input.actorId, type: "human" },
    commandId: stableUuid(`consensus-approval-decision:${input.approvalId}:${input.granted}`),
    missionId: state.mission_id,
    target: input.granted ? "approved" : "rejected",
    reason: input.granted ? "Human approved the exact canonical plan" : "Human rejected the canonical plan",
  });
}

export async function assertConsensusApprovalDecisionAllowed(input: {
  workspaceId: string;
  approvalId: string;
  granted: boolean;
  database: Pick<PoolClient, "query">;
}) {
  if (!input.granted) return;
  const state = (
    await input.database.query<Pick<ConsensusProjection, "repository_id" | "repository_authority_hash">>(
      "SELECT repository_id,repository_authority_hash FROM consensus_plan_projections WHERE workspace_id=$1 AND human_approval_id=$2",
      [input.workspaceId, input.approvalId],
    )
  ).rows[0];
  if (!state) throw new ValidationFailedError("Consensus approval is not linked to a mission");
  await assertCurrentRepositoryAuthority(
    input.workspaceId,
    state.repository_id,
    state.repository_authority_hash,
    input.database,
    true,
  );
}

const recoveryOperationsByStatus: Partial<Record<ConsensusStatus, ConsensusOperation[]>> = {
  ready: ["prepare_context"],
  capturing_independent_proposals: ["prepare_context", "proposal"],
  proposals_complete: ["proposal"],
  critique_round: ["proposal", "critique"],
  revision_round: ["critique", "revision"],
  canonicalization: ["revision", "canonicalize"],
  awaiting_final_verdicts: ["canonicalize", "verdict"],
};

export async function reconcileConsensusState(workerId: string) {
  let repaired = 0;
  const approvals = await getDatabasePool().query<{
    workspace_id: string;
    approval_id: string;
    status: "granted" | "denied";
  }>(
    `SELECT a.workspace_id,a.approval_id,a.status FROM approval_projections a
     JOIN consensus_plan_projections c ON c.workspace_id=a.workspace_id AND c.human_approval_id=a.approval_id
     WHERE a.approval_type='consensus_plan' AND a.status IN('granted','denied')
       AND c.status='awaiting_human_approval' LIMIT 100`,
  );
  for (const approval of approvals.rows) {
    await onConsensusApprovalDecision({
      workspaceId: approval.workspace_id,
      approvalId: approval.approval_id,
      granted: approval.status === "granted",
      actorId: workerId,
    });
    repaired += 1;
  }
  const terminalTasks = await getDatabasePool().query<{
    workspace_id: string;
    mission_id: string;
    status: ConsensusStatus;
    task_id: string;
    task_status: string;
    operation: ConsensusOperation;
  }>(
    `SELECT c.workspace_id,c.mission_id,c.status,t.task_id,p.status task_status,t.operation
     FROM consensus_plan_projections c JOIN consensus_turns t
       ON t.workspace_id=c.workspace_id AND t.mission_id=c.mission_id
     JOIN task_projections p ON p.workspace_id=t.workspace_id AND p.task_id=t.task_id
     WHERE c.status NOT IN('consensus_not_reached','approved','rejected','implementation_mission_created',
       'completed','failed','cancelled') AND p.status IN('completed','failed','cancelled')
     ORDER BY p.updated_at LIMIT 200`,
  );
  for (const task of terminalTasks.rows) {
    if (!recoveryOperationsByStatus[task.status]?.includes(task.operation)) continue;
    await advanceConsensusAfterTask(
      task.workspace_id,
      task.mission_id,
      task.task_id,
      task.task_status === "completed" ? "task.completed" : `task.${task.task_status}`,
    );
    repaired += 1;
  }
  const childTasks = await getDatabasePool().query<{
    workspace_id: string;
    mission_id: string;
    task_id: string;
    status: string;
  }>(
    `SELECT m.workspace_id,m.mission_id,t.task_id,t.status FROM mission_projections m
     JOIN consensus_plan_projections c ON c.workspace_id=m.workspace_id AND c.implementation_mission_id=m.mission_id
     JOIN task_projections t ON t.workspace_id=m.workspace_id AND t.mission_id=m.mission_id
     WHERE c.status='implementation_mission_created' AND m.status='running'
       AND t.status IN('completed','failed','cancelled') LIMIT 100`,
  );
  for (const task of childTasks.rows) {
    await (
      await import("@/application/mission-coordinator")
    ).coordinateAfterTask(
      task.workspace_id,
      task.mission_id,
      task.task_id,
      task.status === "completed" ? "task.completed" : `task.${task.status}`,
    );
    repaired += 1;
  }
  const completedChildren = await getDatabasePool().query<{ workspace_id: string; mission_id: string }>(
    `SELECT c.workspace_id,c.implementation_mission_id mission_id FROM consensus_plan_projections c
     JOIN mission_projections m ON m.workspace_id=c.workspace_id AND m.mission_id=c.implementation_mission_id
     WHERE c.status='implementation_mission_created' AND m.status='completed' LIMIT 100`,
  );
  for (const child of completedChildren.rows) {
    await completeConsensusImplementation(child.workspace_id, child.mission_id);
    repaired += 1;
  }
  const unsuccessfulChildren = await getDatabasePool().query<{
    workspace_id: string;
    mission_id: string;
    child_status: "failed" | "cancelled";
  }>(
    `SELECT c.workspace_id,c.mission_id,m.status child_status FROM consensus_plan_projections c
     JOIN mission_projections m ON m.workspace_id=c.workspace_id AND m.mission_id=c.implementation_mission_id
     WHERE c.status='implementation_mission_created' AND m.status IN('failed','cancelled') LIMIT 100`,
  );
  for (const child of unsuccessfulChildren.rows) {
    await transitionConsensus({
      actor: { workspaceId: child.workspace_id, id: workerId, type: "system" },
      commandId: stableUuid(`consensus-child-terminal:${child.mission_id}:${child.child_status}`),
      missionId: child.mission_id,
      target: child.child_status,
      reason: `Implementation child ${child.child_status}`,
    });
    repaired += 1;
  }
  return repaired;
}

export async function createConsensusImplementationMission(input: {
  actor: CommandActor;
  commandId: string;
  consensusMissionId: string;
  executorAgentId?: string;
  executorModelId: string;
}) {
  const state = await projection(input.actor.workspaceId, input.consensusMissionId);
  if (state.status === "implementation_mission_created" && state.implementation_mission_id) {
    if (
      (input.executorAgentId && input.executorAgentId !== state.preferred_executor_agent_id) ||
      input.executorModelId !== state.preferred_executor_model_id
    )
      throw new ValidationFailedError("Implementation retry changed the human-approved executor or model");
    return { missionId: state.implementation_mission_id, duplicate: true };
  }
  if (state.status !== "approved" || !state.human_approval_id || !state.canonical_plan_hash)
    throw new ValidationFailedError("An exact granted consensus approval is required");
  const approval = (
    await getDatabasePool().query<{ status: string; requested_action: Record<string, unknown> }>(
      "SELECT status,requested_action FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
      [input.actor.workspaceId, state.human_approval_id],
    )
  ).rows[0];
  if (
    approval?.status !== "granted" ||
    approval.requested_action.canonicalPlanHash !== state.canonical_plan_hash ||
    approval.requested_action.repositorySnapshot !== state.repository_snapshot ||
    approval.requested_action.baseBranch !== state.base_branch ||
    approval.requested_action.actionType !== "repository.modify" ||
    approval.requested_action.authoritySource !== "consensus_plan" ||
    approval.requested_action.executorAgentId !== state.preferred_executor_agent_id ||
    approval.requested_action.executorModelId !== state.preferred_executor_model_id ||
    canonicalHash(approval.requested_action.executionBudget) !== canonicalHash(state.execution_budget)
  )
    throw new ValidationFailedError("Consensus approval is stale or does not match the canonical plan");
  const repository = (
    await getDatabasePool().query<{
      observed_commit: string | null;
      write_allowed: boolean;
      commit_allowed: boolean;
      validation_commands: string[][];
      repository_authority_hash: string | null;
      isolated_worktree_write_allowed: boolean;
      mission_agent_local_commit_allowed: boolean;
      provider_direct_commit_allowed: boolean;
      push_allowed: boolean;
      pull_request_allowed: boolean;
      merge_allowed: boolean;
      publication_allowed: boolean;
      deployment_allowed: boolean;
      infrastructure_mutation_allowed: boolean;
    }>(
      `SELECT observed_commit,write_allowed,commit_allowed,validation_commands,repository_authority_hash,
        isolated_worktree_write_allowed,mission_agent_local_commit_allowed,provider_direct_commit_allowed,
        push_allowed,pull_request_allowed,merge_allowed,publication_allowed,deployment_allowed,infrastructure_mutation_allowed
       FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
      [input.actor.workspaceId, state.repository_id],
    )
  ).rows[0];
  if (repository?.observed_commit !== state.repository_base_commit) {
    await appendConsensus({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${input.consensusMissionId}:stale:${repository?.observed_commit ?? "missing"}`),
      missionId: input.consensusMissionId,
      commandType: "MarkConsensusPlanStale",
      events: [
        {
          eventType: "consensus.stale_detected",
          eventSchemaVersion: 1,
          payload: {
            expectedCommit: state.repository_base_commit,
            observedCommit: repository?.observed_commit ?? null,
            reason: "Repository changed after planning",
          },
        },
      ],
    });
    throw new ValidationFailedError(
      "Repository changed after consensus; revalidation or a new consensus mission is required",
    );
  }
  if (
    repository.repository_authority_hash !== state.repository_authority_hash ||
    approval.requested_action.repositoryAuthorityHash !== state.repository_authority_hash
  ) {
    await transitionConsensus({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${input.consensusMissionId}:post-approval-authority-changed`),
      missionId: input.consensusMissionId,
      target: "rejected",
      reason:
        "Repository authority changed after human approval; the approval cannot be consumed and a new plan approval is required",
    });
    throw new ValidationFailedError("Repository authority changed after human approval");
  }
  if (
    repository.write_allowed ||
    repository.commit_allowed ||
    !repository.isolated_worktree_write_allowed ||
    !repository.mission_agent_local_commit_allowed ||
    repository.provider_direct_commit_allowed ||
    repository.push_allowed ||
    repository.pull_request_allowed ||
    repository.merge_allowed ||
    repository.publication_allowed ||
    repository.deployment_allowed ||
    repository.infrastructure_mutation_allowed
  )
    throw new ValidationFailedError("Repository authority no longer permits only isolated local implementation");
  const executorAgentId = input.executorAgentId ?? state.preferred_executor_agent_id;
  if (!executorAgentId) throw new ValidationFailedError("Select an implementation executor");
  if (
    executorAgentId !== state.preferred_executor_agent_id ||
    input.executorModelId !== state.preferred_executor_model_id
  )
    throw new ValidationFailedError("Implementation executor and model must match the human-approved authority");
  const executorAssignment = await participantForRole(input.actor.workspaceId, input.consensusMissionId, "executor");
  if (
    executorAssignment.agent_id !== executorAgentId ||
    executorAssignment.model_id !== input.executorModelId ||
    approval.requested_action.executorProviderId !== executorAssignment.provider_id ||
    approval.requested_action.executorAssignmentId !== executorAssignment.participant_assignment_id ||
    approval.requested_action.capabilityAttestationId !== executorAssignment.capability_attestation_id ||
    approval.requested_action.capabilityAttestationHash !== executorAssignment.capability_attestation_hash ||
    approval.requested_action.permissionProfileHash !== executorAssignment.permission_profile_hash
  )
    throw new ValidationFailedError("Implementation executor capability binding does not match the human approval");
  const eligible = await evaluateAgentEligibility({
    workspaceId: input.actor.workspaceId,
    agentId: executorAgentId,
    domain: "software_delivery",
    requiredCapabilities: [
      "repository.read",
      "repository.isolated_worktree_write",
      "code.implement",
      "test.run",
      "git.commit_local",
    ],
    requiredResources: [
      { resourceType: "repository", resourceId: state.repository_id, permission: "isolated_worktree_write" },
    ],
    protocolVersion: "1.0",
    requiredMissionRole: "executor",
    requiredOperation: "implement_change",
    requiredModel: input.executorModelId,
    requiredModelRole: "executor",
    requireStructuredOutput: true,
    requireRepositoryMutation: true,
    requireVerifiedMissionAgentArtifact: true,
  });
  if (
    !eligible.eligible ||
    eligible.providerId !== executorAssignment.provider_id ||
    eligible.capabilityAttestationId !== executorAssignment.capability_attestation_id ||
    eligible.capabilityAttestationHash !== executorAssignment.capability_attestation_hash
  )
    throw new ValidationFailedError("Selected executor is not eligible", { reasons: eligible.reasons });
  const canonical = (
    await getDatabasePool().query<{ artifact_id: string; normalized_payload: Record<string, unknown> }>(
      `SELECT c.artifact_id,c.normalized_payload FROM consensus_artifacts c JOIN artifacts a
         ON a.workspace_id=c.workspace_id AND a.artifact_id=c.artifact_id
         AND a.deleted_at IS NULL AND a.checksum_sha256=c.artifact_checksum
       WHERE c.workspace_id=$1 AND c.mission_id=$2 AND c.artifact_kind='canonical_implementation_plan'`,
      [input.actor.workspaceId, input.consensusMissionId],
    )
  ).rows[0];
  if (!canonical?.normalized_payload) throw new ValidationFailedError("Canonical plan payload is unavailable");
  const plan = canonical.normalized_payload;
  const validationCommands = governedValidationCommands(plan.validation_plan, repository.validation_commands);
  if (!validationCommands.length)
    throw new ValidationFailedError(
      "Approved consensus implementation requires at least one owner-governed validation command",
    );
  if (canonicalHash(approval.requested_action.validationCommands) !== canonicalHash(validationCommands))
    throw new ValidationFailedError("Repository validation policy changed after human approval");
  const childMissionId = stableUuid(`consensus-child:${input.consensusMissionId}:${state.canonical_plan_hash}`);
  if (approval.requested_action.childMissionId !== childMissionId)
    throw new ValidationFailedError("Consensus approval does not bind the deterministic implementation child");
  const existingChild = (
    await getDatabasePool().query<{ parent_consensus_mission_id: string; approved_plan_hash: string; status: string }>(
      "SELECT parent_consensus_mission_id,approved_plan_hash,status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
      [input.actor.workspaceId, childMissionId],
    )
  ).rows[0];
  if (
    existingChild &&
    (existingChild.parent_consensus_mission_id !== input.consensusMissionId ||
      existingChild.approved_plan_hash !== state.canonical_plan_hash)
  )
    throw new ValidationFailedError("Existing implementation child does not match the approved consensus plan");
  if (!existingChild)
    await handleCreateMission({
      actor: input.actor,
      commandId: stableUuid(`${childMissionId}:create-mission`),
      missionId: childMissionId,
      mission: {
        name: `Implement approved consensus plan`,
        objective: String(plan.objective),
        description: "A separate approval-gated Repository Change Mission bound to an immutable consensus plan.",
        domain: "software_delivery",
        priority: "normal",
        riskLevel: "moderate",
        successCriteria: Array.isArray(plan.acceptance_criteria)
          ? plan.acceptance_criteria.map(String)
          : ["Approved canonical plan is implemented"],
        constraints: [
          "Executor must acknowledge the exact canonical plan hash",
          "Material deviations require a separate human approval",
          "Existing repository change command policy remains authoritative",
        ],
        budgetLimits: {
          maximumDurationSeconds: state.execution_budget.maximumDurationSeconds,
          ...(state.execution_budget.maximumCostAmount === null
            ? {}
            : { maximumCostAmount: state.execution_budget.maximumCostAmount }),
        },
        missionType: "repository_change",
        repositoryId: state.repository_id,
        baseBranch: state.base_branch,
        baseCommit: state.repository_base_commit,
        repositorySnapshot: state.repository_snapshot,
        parentConsensusMissionId: input.consensusMissionId,
        approvedPlanArtifactId: canonical.artifact_id,
        approvedPlanHash: state.canonical_plan_hash,
        resolvedInputs: {
          contextPackHash: state.context_pack_hash,
          humanApprovalId: state.human_approval_id,
          executorAgentId,
          executorModelId: input.executorModelId,
          executorProviderId: executorAssignment.provider_id,
          executorAssignmentId: executorAssignment.participant_assignment_id,
          capabilityAttestationId: executorAssignment.capability_attestation_id,
          capabilityAttestationHash: executorAssignment.capability_attestation_hash,
          permissionProfileHash: executorAssignment.permission_profile_hash,
          executionBudget: state.execution_budget,
          validationCommands,
          repositoryAuthorityHash: state.repository_authority_hash,
        },
      },
    });
  const taskId = stableUuid(`${childMissionId}:implementation-task`);
  const existingTask = (
    await getDatabasePool().query<{ status: string }>(
      "SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
      [input.actor.workspaceId, taskId],
    )
  ).rows[0];
  if (!existingTask)
    await handleCreateTask({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${childMissionId}:create-task`),
      taskId,
      task: {
        missionId: childMissionId,
        name: "Implement the approved canonical plan",
        instructions: `Implement only canonical plan ${state.canonical_plan_hash}. Stop and request a deviation approval if it is materially invalid.`,
        expectedOutput: "Implementation evidence, validation results, diff, and one local commit for review.",
        priority: "normal",
        riskLevel: "moderate",
        requiredCapabilities: [
          "repository.read",
          "repository.isolated_worktree_write",
          "code.implement",
          "test.run",
          "git.commit_local",
        ],
        requiredResources: [
          { resourceType: "repository", resourceId: state.repository_id, permission: "isolated_worktree_write" },
        ],
        maximumAttempts: state.execution_budget.maximumAttempts,
        timeoutSeconds: state.execution_budget.maximumDurationSeconds,
        approvalPolicy: {
          missionType: "change",
          writeApprovalRequired: true,
          approvedPlanArtifactId: canonical.artifact_id,
          approvedPlanHash: state.canonical_plan_hash,
          contextPackHash: state.context_pack_hash,
          parentConsensusMissionId: input.consensusMissionId,
          humanApprovalId: state.human_approval_id,
          executorModelId: input.executorModelId,
          executorProviderId: executorAssignment.provider_id,
          executorAssignmentId: executorAssignment.participant_assignment_id,
          capabilityAttestationId: executorAssignment.capability_attestation_id,
          capabilityAttestationHash: executorAssignment.capability_attestation_hash,
          permissionProfileHash: executorAssignment.permission_profile_hash,
          executionBudget: state.execution_budget,
          validationCommands,
          repositoryAuthorityHash: state.repository_authority_hash,
        },
        // Canonical-plan prose is never executed. Only commands that independently
        // satisfy the existing implementation-time allowlist cross this boundary.
        verificationRequirements: validationCommands,
      },
    });
  let childStatus = (
    await getDatabasePool().query<{ status: string }>(
      "SELECT status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
      [input.actor.workspaceId, childMissionId],
    )
  ).rows[0]?.status;
  if (childStatus === "draft") {
    await handleMissionTransition({
      actor: input.actor,
      commandId: stableUuid(`${childMissionId}:planned`),
      missionId: childMissionId,
      target: "planned",
    });
    childStatus = "planned";
  }
  if (childStatus === "planned") {
    await handleMissionTransition({
      actor: input.actor,
      commandId: stableUuid(`${childMissionId}:running`),
      missionId: childMissionId,
      target: "running",
    });
    childStatus = "running";
  }
  const currentTask = (
    await getDatabasePool().query<{ status: string }>(
      "SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
      [input.actor.workspaceId, taskId],
    )
  ).rows[0];
  if (["pending", "blocked"].includes(currentTask.status))
    await handleTaskTransition({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${childMissionId}:implementation-ready`),
      taskId,
      target: "ready",
    });
  const executionId = stableUuid(`${childMissionId}:implementation-execution`);
  const existingExecution = (
    await getDatabasePool().query("SELECT 1 FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2", [
      input.actor.workspaceId,
      executionId,
    ])
  ).rowCount;
  if (!existingExecution && childStatus === "running")
    await handleRequestRemoteExecution({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${childMissionId}:execution`),
      executionId,
      taskId,
      agentId: executorAgentId,
      timeoutSeconds: state.execution_budget.maximumDurationSeconds,
    });
  await appendConsensus({
    actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
    commandId: stableUuid(`${childMissionId}:link-parent`),
    missionId: input.consensusMissionId,
    commandType: "CreateConsensusImplementationMission",
    events: [
      {
        eventType: "consensus.implementation_mission_created",
        eventSchemaVersion: 1,
        payload: {
          implementationMissionId: childMissionId,
          executorAgentId,
          executorModelId: input.executorModelId,
          canonicalPlanArtifactId: canonical.artifact_id,
          canonicalPlanHash: state.canonical_plan_hash,
          humanApprovalId: state.human_approval_id,
        },
      },
      {
        eventType: "consensus.status_changed",
        eventSchemaVersion: 1,
        payload: { status: "implementation_mission_created", reason: "Approved child mission created exactly once" },
      },
    ],
  });
  return { missionId: childMissionId, duplicate: false };
}

export async function getConsensusHistory(workspaceId: string, missionId: string) {
  const state = await projection(workspaceId, missionId);
  const participants = (
    await getDatabasePool().query(
      `SELECT p.*,a.name agent_name,a.agent_version,a.supported_operations,a.supported_models
       FROM consensus_participant_assignments p JOIN agents a ON a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
       WHERE p.workspace_id=$1 AND p.mission_id=$2 ORDER BY p.role`,
      [workspaceId, missionId],
    )
  ).rows;
  const artifacts = (
    await getDatabasePool().query(
      `SELECT c.*,a.byte_size,a.checksum_sha256,a.media_type,a.created_at artifact_created_at
       FROM consensus_artifacts c JOIN artifacts a ON a.workspace_id=c.workspace_id AND a.artifact_id=c.artifact_id
       WHERE c.workspace_id=$1 AND c.mission_id=$2 ORDER BY a.created_at`,
      [workspaceId, missionId],
    )
  ).rows;
  const objections = (
    await getDatabasePool().query(
      "SELECT * FROM consensus_objections WHERE workspace_id=$1 AND mission_id=$2 ORDER BY created_at,objection_id",
      [workspaceId, missionId],
    )
  ).rows;
  const usage = (
    await getDatabasePool().query(
      `SELECT provider,model,metric_type,quantity,unit,cost_amount,currency,cost_confidence,participant_assignment_id,assignment_role,planning_phase,execution_attempt,recorded_at
       FROM usage_records WHERE workspace_id=$1 AND mission_id=$2 ORDER BY recorded_at`,
      [workspaceId, missionId],
    )
  ).rows;
  const learningCandidate = state.learning_candidate_artifact_id
    ? (
        await getDatabasePool().query(
          `SELECT artifact_id,kind,checksum_sha256,created_at FROM artifacts
           WHERE workspace_id=$1 AND artifact_id=$2 AND deleted_at IS NULL`,
          [workspaceId, state.learning_candidate_artifact_id],
        )
      ).rows[0]
    : null;
  return { state, participants, artifacts, objections, usage, learningCandidate };
}

export async function completeConsensusImplementation(workspaceId: string, implementationMissionId: string) {
  const child = (
    await getDatabasePool().query<{
      parent_consensus_mission_id: string | null;
      status: string;
      repository_id: string;
      base_commit: string;
    }>(
      `SELECT parent_consensus_mission_id,status,repository_id,base_commit FROM mission_projections
       WHERE workspace_id=$1 AND mission_id=$2`,
      [workspaceId, implementationMissionId],
    )
  ).rows[0];
  if (!child?.parent_consensus_mission_id || child.status !== "completed") return undefined;
  const state = await projection(workspaceId, child.parent_consensus_mission_id);
  if (state.learning_candidate_artifact_id)
    return { artifactId: state.learning_candidate_artifact_id, duplicate: true };
  const execution = (
    await getDatabasePool().query<{ execution_id: string; task_id: string; commit_id: string | null; status: string }>(
      `SELECT execution_id,task_id,commit_id,status FROM execution_projections
       WHERE workspace_id=$1 AND mission_id=$2 ORDER BY attempt DESC,created_at DESC LIMIT 1`,
      [workspaceId, implementationMissionId],
    )
  ).rows[0];
  if (!execution || execution.status !== "succeeded")
    throw new ValidationFailedError("Consensus learning candidate requires a succeeded child execution");
  const validationReceipt = (
    await getDatabasePool().query<{ validation_receipt_id: string; receipt_hash: string }>(
      `SELECT validation_receipt_id,receipt_hash FROM consensus_execution_validation_receipts
       WHERE workspace_id=$1 AND mission_id=$2 AND execution_id=$3 AND result_commit=$4`,
      [workspaceId, implementationMissionId, execution.execution_id, execution.commit_id],
    )
  ).rows[0];
  if (!validationReceipt)
    throw new ValidationFailedError("Consensus child completion requires a durable execution-bound validation receipt");
  const candidateKey = `consensus-learning:${child.parent_consensus_mission_id}:${implementationMissionId}`;
  const existing = (
    await getDatabasePool().query<{ artifact_id: string }>(
      "SELECT artifact_id FROM artifacts WHERE workspace_id=$1 AND metadata->>'candidateKey'=$2 AND deleted_at IS NULL",
      [workspaceId, candidateKey],
    )
  ).rows[0];
  const objections = (
    await getDatabasePool().query(
      `SELECT objection_id,category,status,source_artifact_id,resolved_by_artifact_id
       FROM consensus_objections WHERE workspace_id=$1 AND mission_id=$2 ORDER BY objection_id`,
      [workspaceId, child.parent_consensus_mission_id],
    )
  ).rows;
  const evidence = (
    await getDatabasePool().query(
      `SELECT artifact_id,kind,checksum_sha256 FROM artifacts
       WHERE workspace_id=$1 AND mission_id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY created_at`,
      [workspaceId, [child.parent_consensus_mission_id, implementationMissionId]],
    )
  ).rows;
  const usage = (
    await getDatabasePool().query(
      `SELECT provider,model,metric_type,quantity,unit,cost_amount,currency,cost_confidence
       FROM usage_records WHERE workspace_id=$1 AND mission_id=ANY($2::uuid[]) ORDER BY recorded_at`,
      [workspaceId, [child.parent_consensus_mission_id, implementationMissionId]],
    )
  ).rows;
  const participants = (
    await getDatabasePool().query(
      `SELECT role,provider_id,model_id FROM consensus_participant_assignments
       WHERE workspace_id=$1 AND mission_id=$2 ORDER BY role`,
      [workspaceId, child.parent_consensus_mission_id],
    )
  ).rows;
  const candidate = {
    schema_version: "2.5.0",
    artifact_type: "proposed-learning",
    status: "proposed",
    human_approval: "required",
    repository: {
      repository_id: child.repository_id,
      planned_commit: child.base_commit,
      implementation_commit: execution.commit_id,
    },
    mission: {
      consensus_mission_id: child.parent_consensus_mission_id,
      implementation_mission_id: implementationMissionId,
      consensus_reached: state.consensus_decision === "reached",
      canonical_plan_hash: state.canonical_plan_hash,
      human_plan_decision: "approved",
      implementation_outcome: execution.status,
      implementation_review_required: state.require_implementation_review,
      implementation_review_status: "not_automated_in_v1",
      validation_receipt_id: validationReceipt.validation_receipt_id,
      validation_receipt_hash: validationReceipt.receipt_hash,
    },
    objection_outcomes: objections,
    planner_executor_pairing: participants,
    evidence: evidence.map((item: Record<string, unknown>) => ({
      kind: item.kind,
      artifact_id: item.artifact_id,
      checksum_sha256: item.checksum_sha256,
    })),
    usage,
    proposed_claim: "Retain this outcome as review evidence for future planning; do not promote without human review.",
  };
  const body = Buffer.from(JSON.stringify(candidate, null, 2));
  assertConsensusArtifactSecretSafe(body);
  const stored = existing
    ? undefined
    : await storeExecutionArtifact({
        workspaceId,
        missionId: implementationMissionId,
        taskId: execution.task_id,
        executionId: execution.execution_id,
        kind: "project_brain_learning_candidate",
        mediaType: "application/json",
        body,
        metadata: { candidateKey, source: "consensus-completion", governanceStatus: "proposed" },
        maxBytes: 256 * 1024,
      });
  const artifactId = existing?.artifact_id ?? stored!.artifactId;
  await appendConsensus({
    actor: { workspaceId, id: "consensus-coordinator", type: "system" },
    commandId: stableUuid(`${candidateKey}:record`),
    missionId: child.parent_consensus_mission_id,
    commandType: "ProposeConsensusLearningCandidate",
    events: [
      {
        eventType: "consensus.learning_candidate_proposed",
        eventSchemaVersion: 1,
        payload: { artifactId, implementationMissionId, governanceStatus: "proposed" },
      },
      {
        eventType: "consensus.status_changed",
        eventSchemaVersion: 1,
        payload: { status: "completed", reason: "Child implementation completed and learning candidate proposed" },
      },
    ],
  });
  await handleMissionTransition({
    actor: { workspaceId, userId: "consensus-coordinator", role: "owner" },
    commandId: stableUuid(`${child.parent_consensus_mission_id}:mission-complete`),
    missionId: child.parent_consensus_mission_id,
    target: "completed",
  });
  return { artifactId, duplicate: Boolean(existing) };
}
