import { randomUUID } from "node:crypto";
import {
  executionFact,
  rehydrateExecution,
  requestExecution,
  requestExecutionCancellation,
  transitionExecution,
  type ExecutionStatus,
} from "@/domain/execution";
import { ConcurrencyConflictError, NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { appendEvents, loadAggregateEvents, type ActorType, type NewDomainEvent } from "@/lib/postgres-event-store";
import { applyExecutionProjection } from "@/application/execution-projector";
import { getDispatchPolicy } from "@/application/registry";
import { getDatabasePool } from "@/lib/database";
import { enqueueJob } from "@/lib/job-store";
import { handleTaskTransition } from "@/application/task-commands";
import { stableUuid } from "@/lib/stable-id";
import { canonicalHash } from "@/lib/canonical-json";
import { evaluateAgentEligibility, type RequiredResource } from "@/application/agent-eligibility";
import { evaluateExecutionBudget, recordUsage } from "@/application/usage-budget";
import { readExecutionArtifact } from "@/execution/artifact-store";
import { assertCapabilityEnabled } from "@/application/emergency-controls";
import { createPullAssignment, completePullAssignment } from "@/application/pull-assignments";
import { coordinateAfterTask } from "@/application/mission-coordinator";
export type ExecutionActor = { workspaceId: string; id: string; type: ActorType };
type DispatchTaskRow = { mission_id: string; status: string; current_attempt: number; timeout_seconds: number | null };
async function append(
  actor: ExecutionActor,
  commandId: string,
  executionId: string,
  event: NewDomainEvent,
  commandType: string,
  expected?: number,
) {
  const existing = await loadAggregateEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
  });
  const state = rehydrateExecution(existing);
  if (!state) throw new NotFoundError("Execution");
  if (expected !== undefined && expected !== state.version)
    throw new ConcurrencyConflictError({ expectedVersion: expected, actualVersion: state.version });
  const result = await appendEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
    missionId: state.missionId,
    expectedVersion: state.version,
    commandId,
    commandType,
    correlationId: state.missionId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: actor.type, id: actor.id },
    events: [event],
    applyProjections: applyExecutionProjection,
  });
  if (
    ["execution.succeeded", "execution.failed", "execution.timed_out", "execution.cancelled"].includes(event.eventType)
  ) {
    const execution = (
      await getDatabasePool().query(
        "SELECT mission_id,task_id,agent_id,adapter_type,started_at FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
        [actor.workspaceId, executionId],
      )
    ).rows[0];
    if (execution)
      await recordUsage({
        workspaceId: actor.workspaceId,
        commandId: stableUuid(`execution-operational-usage:${executionId}`),
        actorId: "usage-recorder",
        missionId: execution.mission_id,
        taskId: execution.task_id,
        executionId,
        agentId: execution.agent_id,
        provider: execution.adapter_type === "codex" ? "openai" : "remote_agent",
        runtime: execution.adapter_type,
        metricType: "duration",
        quantity: execution.started_at ? Math.max(0, Date.now() - new Date(execution.started_at).getTime()) : undefined,
        unit: "milliseconds",
        costConfidence: "unknown",
        source: "mission_control_execution",
      });
    await completePullAssignment(actor.workspaceId, executionId);
  }
  return {
    executionId,
    events: result.events,
    state: rehydrateExecution([...existing, ...result.events])!,
    duplicateCommand: result.duplicateCommand,
  };
}
export async function handleRequestExecution(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId?: string;
  taskId: string;
  agentId: string;
  repositoryId: string;
  timeoutSeconds?: number;
}) {
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_new_executions");
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_codex_assignments");
  const policy = await getDispatchPolicy(input.actor.workspaceId, input.agentId, input.repositoryId);
  if (policy.adapter_type !== "codex") throw new ValidationFailedError("This command requires a Codex agent");
  if (policy.location_mode !== "server" || policy.local_path.startsWith("mission-agent://"))
    throw new ValidationFailedError("Local Codex execution requires a server repository checkout");
  if (!policy.read_allowed || !policy.write_allowed)
    throw new ValidationFailedError("Repository does not allow the required access");
  const task = (
    await getDatabasePool().query<DispatchTaskRow>(
      "SELECT mission_id,status,current_attempt,timeout_seconds FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
      [input.actor.workspaceId, input.taskId],
    )
  ).rows[0];
  if (!task) throw new NotFoundError("Task");
  if (task.status !== "ready") throw new ValidationFailedError("Task must be ready for execution");
  const executionId = input.executionId ?? randomUUID();
  await evaluateExecutionBudget({ workspaceId: input.actor.workspaceId, missionId: task.mission_id, executionId });
  const attempt = task.current_attempt + 1;
  const timeoutSeconds = input.timeoutSeconds ?? task.timeout_seconds ?? 3600;
  const event = requestExecution({
    missionId: task.mission_id,
    taskId: input.taskId,
    agentId: input.agentId,
    repositoryId: input.repositoryId,
    attempt,
    adapterType: "codex",
    timeoutSeconds,
    idempotencyKey: input.commandId,
  });
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
    missionId: task.mission_id,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RequestExecution",
    correlationId: task.mission_id,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [event],
    applyProjections: applyExecutionProjection,
  });
  await handleTaskTransition({
    actor: input.actor,
    commandId: stableUuid(`execution-assignment:${executionId}`),
    taskId: input.taskId,
    target: "assigned",
    details: { assignedExecutor: input.agentId },
  });
  if (!policy.project_brain_enabled)
    await enqueueJob({
      workspaceId: input.actor.workspaceId,
      jobType: "execute_codex",
      payload: { executionId },
      idempotencyKey: `execute:${executionId}`,
      correlationId: task.mission_id,
      maxAttempts: 3,
    });
  return { executionId, events: result.events, duplicateCommand: result.duplicateCommand };
}
export async function handleRequestRemoteExecution(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId?: string;
  taskId: string;
  agentId: string;
  timeoutSeconds?: number;
}) {
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_new_executions");
  await assertCapabilityEnabled(input.actor.workspaceId, "pause_remote_assignments");
  const task = (
    await getDatabasePool().query<
      DispatchTaskRow & {
        name: string;
        instructions: string;
        expected_output: string | null;
        required_capabilities: string[];
        domain: string;
        required_resources: RequiredResource[];
        approval_requirements: {
          missionType?: string;
          writeApprovalRequired?: boolean;
          consensusOperation?: string;
          participantAssignmentId?: string;
          participantRole?: string;
          planningRound?: number;
          sourceArtifactIds?: string[];
          approvedPlanArtifactId?: string;
          approvedPlanHash?: string;
          contextPackHash?: string;
          parentConsensusMissionId?: string;
          humanApprovalId?: string;
          executorModelId?: string;
          capabilityAttestationId?: string;
          capabilityAttestationHash?: string;
          repositoryAuthorityHash?: string;
          executionBudget?: Record<string, unknown>;
        };
        verification_requirements: string[];
        mission_type: string;
        repository_snapshot: string | null;
        base_branch: string | null;
        base_commit: string | null;
        approved_plan_artifact_id: string | null;
        approved_plan_hash: string | null;
        mission_objective: string;
        success_criteria: string[];
        mission_constraints: string[];
      }
    >(
      `SELECT t.mission_id,t.status,t.current_attempt,t.timeout_seconds,t.name,t.instructions,t.expected_output,t.required_capabilities,t.required_resources,t.approval_requirements,t.verification_requirements,
       m.domain,m.mission_type,m.repository_snapshot,m.base_branch,m.base_commit,m.approved_plan_artifact_id,m.approved_plan_hash,
       m.objective mission_objective,m.success_criteria,m.constraints mission_constraints
       FROM task_projections t JOIN mission_projections m ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id
       WHERE t.workspace_id=$1 AND t.task_id=$2`,
      [input.actor.workspaceId, input.taskId],
    )
  ).rows[0];
  if (!task) throw new NotFoundError("Task");
  if (task.status !== "ready") throw new ValidationFailedError("Task must be ready for execution");
  const consensusChange =
    task.approval_requirements?.missionType === "change" &&
    Boolean(task.approval_requirements.parentConsensusMissionId);
  const eligibility = await evaluateAgentEligibility({
    workspaceId: input.actor.workspaceId,
    agentId: input.agentId,
    domain: task.domain,
    requiredCapabilities: task.required_capabilities,
    requiredResources: task.required_resources,
    protocolVersion: "1.0",
    requiredMissionRole: consensusChange
      ? "executor"
      : task.approval_requirements?.missionType === "consensus_plan"
        ? task.approval_requirements.consensusOperation === "verdict"
          ? "reviewer"
          : "planner"
        : undefined,
    requiredOperation: consensusChange ? "implement_change" : undefined,
    requiredModel: consensusChange ? task.approval_requirements.executorModelId : undefined,
    requireRepositoryMutation: consensusChange,
    requireVerifiedMissionAgentArtifact:
      consensusChange || task.approval_requirements?.missionType === "consensus_plan",
  });
  if (!eligibility.eligible)
    throw new ValidationFailedError("Remote agent is ineligible", { reasons: eligibility.reasons });
  const executionId = input.executionId ?? randomUUID(),
    attempt = task.current_attempt + 1,
    timeoutSeconds = input.timeoutSeconds ?? task.timeout_seconds ?? 3600,
    messageId = randomUUID();
  const deliveryMode = (
    await getDatabasePool().query<{ delivery_mode: "push" | "pull" }>(
      "SELECT delivery_mode FROM agents WHERE workspace_id=$1 AND agent_id=$2",
      [input.actor.workspaceId, input.agentId],
    )
  ).rows[0]?.delivery_mode;
  if (!deliveryMode) throw new NotFoundError("Agent");
  await evaluateExecutionBudget({ workspaceId: input.actor.workspaceId, missionId: task.mission_id, executionId });
  const event = requestExecution({
    missionId: task.mission_id,
    taskId: input.taskId,
    agentId: input.agentId,
    repositoryId: task.required_resources.find((resource) => resource.resourceType === "repository")?.resourceId,
    attempt,
    adapterType: "remote_http",
    timeoutSeconds,
    idempotencyKey: input.commandId,
  });
  const consensusPlanning = task.mission_type === "consensus_plan";
  const repositoryChange = !consensusPlanning && task.approval_requirements?.missionType === "change";
  const repositoryId = task.required_resources.find((resource) => resource.resourceType === "repository")?.resourceId;
  if (!repositoryId) throw new ValidationFailedError("Remote execution requires a repository resource");
  const repository = (
    await getDatabasePool().query<{
      location_mode: string;
      observed_commit: string | null;
      repository_fingerprint: string | null;
      project_brain_enabled: boolean;
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
      repository_authority_hash: string | null;
      identity_migration_status: string;
    }>(
      `SELECT location_mode,observed_commit,repository_fingerprint,project_brain_enabled,read_allowed,write_allowed,
        commit_allowed,isolated_worktree_write_allowed,mission_agent_local_commit_allowed,
        provider_direct_commit_allowed,push_allowed,pull_request_allowed,merge_allowed,publication_allowed,deployment_allowed,
        infrastructure_mutation_allowed,repository_authority_hash,identity_migration_status
       FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL`,
      [input.actor.workspaceId, repositoryId],
    )
  ).rows[0];
  if (!repository || repository.location_mode !== "mission_agent")
    throw new ValidationFailedError("Remote execution requires a Mission Agent repository");
  if (!["not_required", "completed"].includes(repository.identity_migration_status))
    throw new ValidationFailedError("Repository dispatch is blocked during identity migration");
  if (!repository.read_allowed) throw new ValidationFailedError("Repository does not allow required remote access");
  if (consensusPlanning || consensusChange) {
    const authorityBinding = (
      await getDatabasePool().query<{ repository_authority_hash: string | null }>(
        `SELECT repository_authority_hash FROM consensus_plan_projections
         WHERE workspace_id=$1 AND mission_id=$2`,
        [
          input.actor.workspaceId,
          consensusChange ? task.approval_requirements.parentConsensusMissionId : task.mission_id,
        ],
      )
    ).rows[0];
    if (
      !repository.repository_authority_hash ||
      repository.repository_authority_hash !== authorityBinding?.repository_authority_hash
    )
      throw new ValidationFailedError("Repository authority changed after consensus readiness");
  }
  if (
    consensusChange &&
    (repository.write_allowed ||
      repository.commit_allowed ||
      !repository.isolated_worktree_write_allowed ||
      !repository.mission_agent_local_commit_allowed ||
      repository.provider_direct_commit_allowed ||
      repository.push_allowed ||
      repository.pull_request_allowed ||
      repository.merge_allowed ||
      repository.publication_allowed ||
      repository.deployment_allowed ||
      repository.infrastructure_mutation_allowed)
  )
    throw new ValidationFailedError("Repository change requires narrow isolated-worktree and local-commit authority");
  let consensusPackage: Record<string, unknown> | undefined;
  if (consensusPlanning) {
    const consensus = (
      await getDatabasePool().query(
        `SELECT c.repository_snapshot,c.repository_base_commit,c.base_branch,c.project_brain_context_artifact_id,c.context_pack_hash,
         c.planning_schema_version,c.maximum_artifact_bytes,c.maximum_command_count,c.maximum_retry_count,
         p.participant_assignment_id,p.agent_id,p.provider_id,p.model_id,p.capability_attestation_id,
         p.capability_attestation_hash,p.permission_profile_hash,p.runtime_model_identity,
         p.provider_runtime_requirements_id,p.provider_runtime_requirements_hash
         FROM consensus_plan_projections c JOIN consensus_participant_assignments p
           ON p.workspace_id=c.workspace_id AND p.mission_id=c.mission_id AND p.participant_assignment_id=$3
         WHERE c.workspace_id=$1 AND c.mission_id=$2`,
        [input.actor.workspaceId, task.mission_id, task.approval_requirements.participantAssignmentId],
      )
    ).rows[0];
    if (!consensus) throw new ValidationFailedError("Consensus assignment binding is missing");
    const sources = task.approval_requirements.sourceArtifactIds?.length
      ? (
          await getDatabasePool().query(
            `SELECT c.artifact_id,c.artifact_kind,c.schema_version,c.normalized_payload,c.canonical_plan_hash
             FROM consensus_artifacts c JOIN artifacts a ON a.workspace_id=c.workspace_id AND a.artifact_id=c.artifact_id
               AND a.deleted_at IS NULL AND a.checksum_sha256=c.artifact_checksum
             WHERE c.workspace_id=$1 AND c.mission_id=$2 AND c.artifact_id=ANY($3::uuid[])
             ORDER BY c.created_at`,
            [input.actor.workspaceId, task.mission_id, task.approval_requirements.sourceArtifactIds],
          )
        ).rows
      : [];
    if (sources.length !== (task.approval_requirements.sourceArtifactIds?.length ?? 0))
      throw new ValidationFailedError("Consensus source package is incomplete");
    const contextArtifact = consensus.project_brain_context_artifact_id
      ? await readExecutionArtifact(input.actor.workspaceId, consensus.project_brain_context_artifact_id)
      : undefined;
    if (task.approval_requirements.consensusOperation !== "prepare_context") {
      if (!contextArtifact || contextArtifact.metadata.checksum_sha256 !== consensus.context_pack_hash)
        throw new ValidationFailedError("Immutable Project Brain context pack is unavailable or has changed");
    }
    consensusPackage = {
      operation: task.approval_requirements.consensusOperation,
      participantAssignmentId: task.approval_requirements.participantAssignmentId,
      participantRole: task.approval_requirements.participantRole,
      planningRound: task.approval_requirements.planningRound,
      repositorySnapshot: consensus.repository_snapshot,
      baseBranch: consensus.base_branch,
      repositoryBaseCommit: consensus.repository_base_commit,
      contextPackArtifactId: consensus.project_brain_context_artifact_id,
      contextPackHash: consensus.context_pack_hash,
      ...(contextArtifact
        ? {
            contextPack: {
              artifactId: consensus.project_brain_context_artifact_id,
              hash: consensus.context_pack_hash,
              mediaType: contextArtifact.metadata.media_type,
              contentBase64: contextArtifact.body.toString("base64"),
            },
          }
        : {}),
      planningSchemaVersion: consensus.planning_schema_version,
      selectedModel: consensus.model_id,
      assignmentBinding: {
        participantAssignmentId: consensus.participant_assignment_id,
        agentId: consensus.agent_id,
        providerId: consensus.provider_id,
        modelId: consensus.model_id,
        capabilityAttestationId: consensus.capability_attestation_id,
        capabilityAttestationHash: consensus.capability_attestation_hash,
        permissionProfileHash: consensus.permission_profile_hash,
        runtimeModelIdentity: consensus.runtime_model_identity,
        providerRuntimeRequirementsId: consensus.provider_runtime_requirements_id,
        providerRuntimeRequirementsHash: consensus.provider_runtime_requirements_hash,
      },
      missionObjective: task.mission_objective,
      acceptanceCriteria: task.success_criteria,
      missionConstraints: task.mission_constraints,
      sourceArtifacts: sources.map((source: Record<string, unknown>) => ({
        artifactId: source.artifact_id,
        artifactKind: source.artifact_kind,
        schemaVersion: source.schema_version,
        canonicalPlanHash: source.canonical_plan_hash,
        content: source.normalized_payload,
      })),
      limits: {
        maximumArtifactBytes: consensus.maximum_artifact_bytes,
        maximumCommandCount: consensus.maximum_command_count,
        maximumRetryCount: consensus.maximum_retry_count,
      },
    };
  }
  let approvedPlanPackage: Record<string, unknown> | undefined;
  if (repositoryChange && task.approved_plan_artifact_id && task.approved_plan_hash) {
    const executorAssignment = (
      await getDatabasePool().query<{
        participant_assignment_id: string;
        agent_id: string;
        provider_id: string;
        model_id: string;
        capability_attestation_id: string;
        capability_attestation_hash: string;
        permission_profile_hash: string;
        runtime_model_identity: string;
        provider_runtime_requirements_id: string;
        provider_runtime_requirements_hash: string;
      }>(
        `SELECT participant_assignment_id,agent_id,provider_id,model_id,capability_attestation_id,
           capability_attestation_hash,permission_profile_hash,runtime_model_identity,
           provider_runtime_requirements_id,provider_runtime_requirements_hash
         FROM consensus_participant_assignments
         WHERE workspace_id=$1 AND mission_id=$2 AND role='executor'`,
        [input.actor.workspaceId, task.approval_requirements.parentConsensusMissionId],
      )
    ).rows[0];
    if (
      !executorAssignment ||
      executorAssignment.agent_id !== input.agentId ||
      executorAssignment.model_id !== task.approval_requirements.executorModelId ||
      executorAssignment.capability_attestation_id !== task.approval_requirements.capabilityAttestationId ||
      executorAssignment.capability_attestation_hash !== task.approval_requirements.capabilityAttestationHash
    )
      throw new ValidationFailedError("Executor assignment capability binding is missing, stale, or changed");
    const approved = (
      await getDatabasePool().query(
        `SELECT c.normalized_payload FROM consensus_artifacts c JOIN artifacts a
           ON a.workspace_id=c.workspace_id AND a.artifact_id=c.artifact_id
           AND a.deleted_at IS NULL AND a.checksum_sha256=c.artifact_checksum
         WHERE c.workspace_id=$1 AND c.artifact_id=$2
           AND c.artifact_kind='canonical_implementation_plan' AND c.canonical_plan_hash=$3`,
        [input.actor.workspaceId, task.approved_plan_artifact_id, task.approved_plan_hash],
      )
    ).rows[0];
    if (!approved?.normalized_payload) throw new ValidationFailedError("Approved canonical plan is unavailable");
    const approval = (
      await getDatabasePool().query<{
        approval_id: string;
        action_hash: string;
        status: string;
        requested_action: Record<string, unknown>;
      }>(
        `SELECT approval_id,action_hash,status,requested_action FROM approval_projections
         WHERE workspace_id=$1 AND approval_id=$2 AND approval_type='consensus_plan'`,
        [input.actor.workspaceId, task.approval_requirements.humanApprovalId],
      )
    ).rows[0];
    if (
      approval?.status !== "granted" ||
      approval.requested_action.canonicalPlanArtifactId !== task.approved_plan_artifact_id ||
      approval.requested_action.childMissionId !== task.mission_id ||
      approval.requested_action.canonicalPlanHash !== task.approved_plan_hash ||
      approval.requested_action.repositoryId !== repositoryId ||
      approval.requested_action.repositorySnapshot !== task.repository_snapshot ||
      approval.requested_action.baseBranch !== task.base_branch ||
      approval.requested_action.repositoryBaseCommit !== task.base_commit ||
      approval.requested_action.repositoryAuthorityHash !== repository.repository_authority_hash ||
      task.approval_requirements.repositoryAuthorityHash !== repository.repository_authority_hash ||
      approval.requested_action.contextPackHash !== task.approval_requirements.contextPackHash ||
      approval.requested_action.executorAssignmentId !== executorAssignment.participant_assignment_id ||
      approval.requested_action.capabilityAttestationId !== executorAssignment.capability_attestation_id ||
      approval.requested_action.capabilityAttestationHash !== executorAssignment.capability_attestation_hash ||
      approval.requested_action.permissionProfileHash !== executorAssignment.permission_profile_hash ||
      !approval.requested_action.executionBudget ||
      !task.approval_requirements.executionBudget ||
      canonicalHash(approval.requested_action.executionBudget) !==
        canonicalHash(task.approval_requirements.executionBudget)
    )
      throw new ValidationFailedError("Consensus approval receipt is unavailable or does not match the child mission");
    approvedPlanPackage = {
      artifactId: task.approved_plan_artifact_id,
      hash: task.approved_plan_hash,
      repositorySnapshot: task.repository_snapshot,
      repositoryAuthorityHash: repository.repository_authority_hash,
      baseBranch: task.base_branch,
      contextPackHash: task.approval_requirements.contextPackHash,
      parentConsensusMissionId: task.approval_requirements.parentConsensusMissionId,
      executionBudget: task.approval_requirements.executionBudget,
      selectedModel: task.approval_requirements.executorModelId,
      validationReceiptId: stableUuid(`consensus-validation-receipt:${input.executionId}:${attempt}`),
      executorAssignment: {
        participantAssignmentId: executorAssignment.participant_assignment_id,
        agentId: executorAssignment.agent_id,
        providerId: executorAssignment.provider_id,
        modelId: executorAssignment.model_id,
        capabilityAttestationId: executorAssignment.capability_attestation_id,
        capabilityAttestationHash: executorAssignment.capability_attestation_hash,
        permissionProfileHash: executorAssignment.permission_profile_hash,
        executionBudget: task.approval_requirements.executionBudget,
        runtimeModelIdentity: executorAssignment.runtime_model_identity,
        providerRuntimeRequirementsId: executorAssignment.provider_runtime_requirements_id,
        providerRuntimeRequirementsHash: executorAssignment.provider_runtime_requirements_hash,
      },
      content: approved.normalized_payload,
      approvalReceipt: {
        approvalId: approval.approval_id,
        status: "granted",
        repositoryId,
        repositorySnapshot: task.repository_snapshot,
        baseBranch: task.base_branch,
        repositoryBaseCommit: task.base_commit,
        repositoryAuthorityHash: repository.repository_authority_hash,
        contextPackHash: task.approval_requirements.contextPackHash,
        canonicalPlanArtifactId: task.approved_plan_artifact_id,
        canonicalPlanHash: task.approved_plan_hash,
        executorAgentId: executorAssignment.agent_id,
        executorProviderId: executorAssignment.provider_id,
        executorModelId: executorAssignment.model_id,
        executorAssignmentId: executorAssignment.participant_assignment_id,
        capabilityAttestationId: executorAssignment.capability_attestation_id,
        capabilityAttestationHash: executorAssignment.capability_attestation_hash,
        permissionProfileHash: executorAssignment.permission_profile_hash,
        actionHash: approval.action_hash,
      },
    };
  }
  const taskEnvelope = {
    missionType: consensusPlanning ? "consensus_plan" : repositoryChange ? "repository_change" : "repository_analysis",
    taskObjective: task.name,
    instructions: task.instructions,
    expectedOutput: task.expected_output,
    allowedCapabilities: task.required_capabilities,
    allowedResources: task.required_resources,
    prohibitedActions: [
      ...(!repositoryChange ? ["file.modify", "package.install", "git.commit"] : []),
      "git.push",
      "pull_request.create",
      "repository.merge",
      "deployment.execute",
      "production.remediate",
      "secret.access",
      "transaction.sign",
      "transaction.submit",
    ],
    constraints: consensusPlanning
      ? ["read_only_consensus_planning", "immutable_snapshot", "bounded_structured_output", "no_agent_chat"]
      : repositoryChange
        ? ["write_requires_approval", "isolated_worktree", "local_commit_only", "no_network_side_effects"]
        : ["read_only_repository_analysis"],
    validationCommands:
      repositoryChange || consensusPlanning
        ? task.verification_requirements.map((command) => command.split(/\s+/))
        : [],
    timeoutSeconds,
    heartbeatIntervalSeconds: 30,
    artifactRequirements: consensusPlanning
      ? [
          (
            {
              prepare_context: "project_brain_context_pack",
              proposal: "consensus_proposal",
              critique: "consensus_critique",
              revision: "consensus_revision",
              canonicalize: "canonical_implementation_plan",
              verdict: "canonical_plan_verdict",
            } as Record<string, string>
          )[String(task.approval_requirements.consensusOperation)],
        ]
      : repositoryChange
        ? ["implementation_plan", "git_patch", "validation_results", "change_summary"]
        : ["repository_analysis"],
    ...(consensusPackage ? { consensus: consensusPackage } : {}),
    ...(approvedPlanPackage ? { approvedPlan: approvedPlanPackage } : {}),
  };
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: executionId,
    missionId: task.mission_id,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RequestRemoteExecution",
    correlationId: task.mission_id,
    actor: { type: input.actor.type, id: input.actor.id },
    events: [event],
    outbox:
      deliveryMode === "push"
        ? [
            {
              eventIndex: 0,
              messageId,
              topic: "remote-agent.delivery",
              idempotencyKey: `remote-execution:${executionId}`,
              payload: {
                messageId,
                agentId: input.agentId,
                messageType: "ExecutionRequested",
                protocolVersion: "1.0",
                executionId,
                missionId: task.mission_id,
                taskId: input.taskId,
                attempt,
                taskEnvelope,
              },
            },
          ]
        : [],
    applyProjections: async (client, events) => {
      await applyExecutionProjection(client, events);
      if (deliveryMode === "pull" && repository.project_brain_enabled)
        await client.query(
          `INSERT INTO remote_project_brain_execution_dispatches(
             workspace_id,execution_id,mission_id,task_id,agent_id,attempt,task_envelope,status
           ) VALUES($1,$2,$3,$4,$5,$6,$7,'awaiting_context')
           ON CONFLICT(workspace_id,execution_id) DO NOTHING`,
          [
            input.actor.workspaceId,
            executionId,
            task.mission_id,
            input.taskId,
            input.agentId,
            attempt,
            JSON.stringify(taskEnvelope),
          ],
        );
      else if (deliveryMode === "pull")
        await createPullAssignment(client, {
          workspaceId: input.actor.workspaceId,
          executionId,
          missionId: task.mission_id,
          taskId: input.taskId,
          agentId: input.agentId,
          attempt,
          payload: taskEnvelope,
        });
    },
  });
  await handleTaskTransition({
    actor: input.actor,
    commandId: stableUuid(`execution-assignment:${executionId}`),
    taskId: input.taskId,
    target: "assigned",
    details: { assignedExecutor: input.agentId },
  });
  return { executionId, messageId, events: result.events, duplicateCommand: result.duplicateCommand };
}
export async function handleExecutionTransition(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
  target: ExecutionStatus;
  details?: Record<string, unknown>;
  expectedVersion?: number;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events);
  if (!state) throw new NotFoundError("Execution");
  const event = transitionExecution(state, input.target, input.details);
  if (!event) return { executionId: input.executionId, events: [], state, duplicateCommand: false };
  return append(
    input.actor,
    input.commandId,
    input.executionId,
    event,
    `Execution:${state.status}->${input.target}`,
    input.expectedVersion ?? state.version,
  );
}

export type MissionAgentGenerationTermination = {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
  assignmentId: string;
  assignmentAttempt: number;
  leaseReceiptId: string;
  leaseTokenFingerprint: string;
  leaseOwner: string;
  fencingToken: number;
  invocationId: string;
  registeredProcessIdentitySha256: string;
  observedProcessIdentitySha256: string;
  expectedVersion: number;
  exitCode: number | null;
  terminationSignal: string | null;
  diagnosticIdentitySha256: string;
  originalFailureClassification?: string | null;
  terminalDeliveryClassification?: string | null;
  lastLocalStage?: string | null;
  executionFailedDeliveryAttempted?: boolean;
  executionFailedAcknowledged?: boolean;
};

const terminalExecutionStatuses = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

type MissionAgentLifecycleAuthority = {
  status: ExecutionStatus;
  failure_classification: string | null;
  aggregate_version: number;
  mission_id: string;
  task_id: string;
  assignment_id: string;
  attempt: number;
  assignment_status: string;
  lease_receipt_id: string | null;
  lease_token_fingerprint: string | null;
  lease_owner: string | null;
  fencing_token: number;
};

async function finalizeMissionAgentLifecycleFailure(
  input: MissionAgentGenerationTermination,
  authority: MissionAgentLifecycleAuthority,
) {
  const task = (
    await getDatabasePool().query<{ status: string }>(
      "SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
      [input.actor.workspaceId, authority.task_id],
    )
  ).rows[0];
  if (!task) throw new ValidationFailedError("Mission Agent lifecycle task binding is unavailable");
  if (task.status !== "failed")
    await handleTaskTransition({
      actor: input.actor,
      commandId: stableUuid(`${input.commandId}:task-failed`),
      taskId: authority.task_id,
      target: "failed",
      details: { reason: "mission_agent_generation_terminated" },
    });
  await coordinateAfterTask(input.actor.workspaceId, authority.mission_id, authority.task_id, "task.failed");
  const verified = (
    await getDatabasePool().query<{
      task_status: string;
      assignment_status: string;
      lease_token_hash: string | null;
      lease_expires_at: Date | null;
    }>(
      `SELECT t.status task_status,p.status assignment_status,p.lease_token_hash,p.lease_expires_at
         FROM task_projections t JOIN pull_assignments p
           ON p.workspace_id=t.workspace_id AND p.task_id=t.task_id
        WHERE t.workspace_id=$1 AND t.task_id=$2 AND p.assignment_id=$3`,
      [input.actor.workspaceId, authority.task_id, input.assignmentId],
    )
  ).rows[0];
  if (
    !verified ||
    verified.task_status !== "failed" ||
    verified.assignment_status !== "completed" ||
    verified.lease_token_hash !== null ||
    verified.lease_expires_at !== null
  )
    throw new ValidationFailedError("Mission Agent lifecycle consequences are not durably terminal");
}

export function decideMissionAgentGenerationTermination(
  input: MissionAgentGenerationTermination,
  authority: MissionAgentLifecycleAuthority | undefined,
) {
  if (
    !/^[0-9a-f]{64}$/.test(input.registeredProcessIdentitySha256) ||
    input.observedProcessIdentitySha256 !== input.registeredProcessIdentitySha256 ||
    !/^[0-9a-f]{64}$/.test(input.diagnosticIdentitySha256) ||
    !input.invocationId ||
    input.assignmentAttempt < 1 ||
    input.fencingToken < 1 ||
    input.expectedVersion < 1
  )
    throw new ValidationFailedError("Mission Agent lifecycle process identity is invalid");
  if (!authority)
    throw new ValidationFailedError("Mission Agent lifecycle execution/assignment binding is unavailable");
  if (authority.assignment_id !== input.assignmentId)
    throw new ValidationFailedError("Mission Agent lifecycle assignment identity changed");
  if (authority.aggregate_version < input.expectedVersion)
    throw new ValidationFailedError("Mission Agent lifecycle aggregate version regressed");
  if (terminalExecutionStatuses.has(authority.status)) return "already_terminal" as const;
  if (
    authority.attempt !== input.assignmentAttempt ||
    authority.lease_receipt_id !== input.leaseReceiptId ||
    authority.lease_token_fingerprint !== input.leaseTokenFingerprint ||
    authority.lease_owner !== input.leaseOwner ||
    Number(authority.fencing_token) !== input.fencingToken
  )
    return "authority_replaced" as const;
  if (!["leased", "acknowledged"].includes(authority.assignment_status))
    throw new ValidationFailedError("Mission Agent lifecycle assignment is not actively governed");
  return "fail" as const;
}

export function missionAgentGenerationExitDisposition(input: {
  authorityReplaced: boolean;
  timedOut: boolean;
  exitCode: number | null;
  expectedExit: boolean;
}) {
  if (input.authorityReplaced) return "authorized_successor" as const;
  if (input.timedOut) return "timeout" as const;
  if (input.exitCode !== 0) return "failed_exit" as const;
  if (!input.expectedExit) return "premature_exit" as const;
  return "terminal" as const;
}

/**
 * Reconciles a launcher-observed Mission Agent generation exit through the
 * canonical execution command path. The launcher detects host truth; this
 * command validates the still-current assignment authority and decides whether
 * a failure transition is permitted. A replaced lease/fence is treated as an
 * authorized successor boundary, never as authority for the stale generation.
 */
export async function handleMissionAgentGenerationTermination(input: MissionAgentGenerationTermination) {
  const readAuthority = async () =>
    (
      await getDatabasePool().query<MissionAgentLifecycleAuthority>(
        `SELECT e.status,e.failure_classification,e.aggregate_version,e.mission_id,e.task_id,p.assignment_id,p.attempt,
                p.status assignment_status,p.lease_receipt_id,p.lease_token_fingerprint,p.lease_owner,p.fencing_token
           FROM execution_projections e JOIN pull_assignments p
             ON p.workspace_id=e.workspace_id AND p.execution_id=e.execution_id
          WHERE e.workspace_id=$1 AND e.execution_id=$2 AND p.assignment_id=$3`,
        [input.actor.workspaceId, input.executionId, input.assignmentId],
      )
    ).rows[0];

  const authority = await readAuthority();
  const decision = decideMissionAgentGenerationTermination(input, authority);
  if (decision === "already_terminal") {
    if (authority.status === "failed" && authority.failure_classification === "mission_agent_generation_terminated")
      await finalizeMissionAgentLifecycleFailure(input, authority);
    return {
      disposition: "already_terminal" as const,
      status: authority.status,
      aggregateVersion: authority.aggregate_version,
    };
  }
  if (decision === "authority_replaced")
    return {
      disposition: "authority_replaced" as const,
      status: authority.status,
      aggregateVersion: authority.aggregate_version,
    };

  let result;
  try {
    result = await handleExecutionTransition({
      actor: input.actor,
      commandId: input.commandId,
      executionId: input.executionId,
      target: "failed",
      expectedVersion: authority.aggregate_version,
      details: {
        classification: "mission_agent_generation_terminated",
        assignmentId: input.assignmentId,
        assignmentAttempt: input.assignmentAttempt,
        leaseReceiptId: input.leaseReceiptId,
        fencingToken: input.fencingToken,
        invocationId: input.invocationId,
        processIdentitySha256: input.registeredProcessIdentitySha256,
        exitCode: input.exitCode,
        terminationSignal: input.terminationSignal,
        diagnosticIdentitySha256: input.diagnosticIdentitySha256,
        originalFailureClassification: input.originalFailureClassification ?? null,
        terminalDeliveryClassification: input.terminalDeliveryClassification ?? null,
        lastMissionAgentLocalStage: input.lastLocalStage ?? null,
        executionFailedDeliveryAttempted: input.executionFailedDeliveryAttempted ?? null,
        executionFailedAcknowledged: input.executionFailedAcknowledged ?? null,
      },
    });
  } catch (error) {
    if (!(error instanceof ConcurrencyConflictError)) throw error;
    const raced = await readAuthority();
    if (raced?.status === "failed" && raced.failure_classification === "mission_agent_generation_terminated") {
      await finalizeMissionAgentLifecycleFailure(input, raced);
      return { disposition: "terminal_race" as const, status: raced.status, aggregateVersion: raced.aggregate_version };
    }
    if (raced && terminalExecutionStatuses.has(raced.status))
      return { disposition: "terminal_race" as const, status: raced.status, aggregateVersion: raced.aggregate_version };
    throw error;
  }
  await finalizeMissionAgentLifecycleFailure(input, authority);
  return { disposition: "failed" as const, status: result.state.status, aggregateVersion: result.state.version };
}
export async function handleExecutionFact(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
  type:
    | "execution.progress_reported"
    | "execution.command_completed"
    | "execution.artifact_produced"
    | "execution.provider_diagnostic_recorded"
    | "execution.provider_diagnostic_rejected"
    | "execution.remote_approval_denied"
    | "execution.approval_decision_acknowledged";
  payload: Record<string, unknown>;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events);
  if (!state) throw new NotFoundError("Execution");
  return append(
    input.actor,
    input.commandId,
    input.executionId,
    executionFact(state, input.type, input.payload),
    input.type,
    state.version,
  );
}
export async function handleExecutionCancellation(input: {
  actor: ExecutionActor;
  commandId: string;
  executionId: string;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events);
  if (!state) throw new NotFoundError("Execution");
  const event = requestExecutionCancellation(state);
  if (!event) return { executionId: input.executionId, events: [], state, duplicateCommand: false };
  return append(input.actor, input.commandId, input.executionId, event, "RequestExecutionCancellation", state.version);
}
