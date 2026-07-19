import { randomUUID } from "node:crypto";
import { requestAction, rehydrateAction, transitionAction, policyEvaluated } from "@/domain/action-request";
import { applyActionProjection } from "@/application/action-projector";
import { requestActionApproval } from "@/application/approval-commands";
import { canonicalHash } from "@/lib/canonical-json";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents, type ActorType, type NewDomainEvent } from "@/lib/postgres-event-store";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
import { evaluatePolicy, type ActionType, type PolicyInput } from "@/policy/policy-engine";
import { loadPolicyRestrictions } from "@/policy/policy-store";
import { enqueueJob } from "@/lib/job-store";
import { validatePublicationPreflight } from "@/git/publication-preflight";
import { assertCapabilityEnabled } from "@/application/emergency-controls";

export type ActionActor = { workspaceId: string; id: string; type: ActorType; role?: "owner" | "member" };

async function context(workspaceId: string, executionId: string) {
  const row = (
    await getDatabasePool().query(
      `SELECT e.*,a.status agent_status,a.trust_level,a.capabilities,r.local_path,r.default_branch,r.protected_branches,r.allowed_branch_prefixes,r.allowed_remotes,r.push_allowed,r.pull_request_allowed FROM execution_projections e JOIN agents a ON a.workspace_id=e.workspace_id AND a.agent_id=e.agent_id JOIN repositories r ON r.workspace_id=e.workspace_id AND r.repository_id=e.repository_id WHERE e.workspace_id=$1 AND e.execution_id=$2`,
      [workspaceId, executionId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Execution");
  if (row.status !== "succeeded" || !row.commit_id || !row.branch_name)
    throw new ValidationFailedError("A successful execution with a local branch and commit is required");
  return row;
}
function policyInput(
  row: Record<string, unknown>,
  actionType: ActionType,
  parameters: Record<string, unknown>,
): PolicyInput {
  return {
    actionType,
    environment: "development",
    agent: {
      status: String(row.agent_status),
      trustLevel: String(row.trust_level),
      capabilities: row.capabilities as string[],
    },
    repository: {
      defaultBranch: String(row.default_branch),
      protectedBranches: row.protected_branches as string[],
      allowedBranchPrefixes: row.allowed_branch_prefixes as string[],
      allowedRemotes: row.allowed_remotes as string[],
      pushAllowed: Boolean(row.push_allowed),
      pullRequestAllowed: Boolean(row.pull_request_allowed),
    },
    parameters,
    reversible: false,
    affectsExternalSystem: true,
  };
}
async function appendAction(actor: ActionActor, actionId: string, event: NewDomainEvent, command: string) {
  const existing = await loadAggregateEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "action_request",
    aggregateId: actionId,
  });
  const state = rehydrateAction(existing);
  if (!state) throw new NotFoundError("Action request");
  return appendEvents({
    workspaceId: actor.workspaceId,
    aggregateType: "action_request",
    aggregateId: actionId,
    missionId: state.missionId,
    expectedVersion: state.version,
    commandId: stableUuid(`${command}:${actionId}:${state.version}`),
    commandType: command,
    correlationId: state.missionId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: actor.type, id: actor.id },
    events: [event],
    applyProjections: applyActionProjection,
  });
}
export async function requestSensitiveAction(input: {
  actor: ActionActor;
  commandId: string;
  actionRequestId?: string;
  executionId: string;
  actionType: ActionType;
  parameters: Record<string, unknown>;
  targetResource: string;
}) {
  if (["repository.push_branch", "repository.create_pull_request"].includes(input.actionType))
    await assertCapabilityEnabled(input.actor.workspaceId, "stop_git_publication");
  const row = await context(input.actor.workspaceId, input.executionId);
  const actionId = input.actionRequestId ?? randomUUID();
  const bound: Record<string, unknown> = {
    actionType: input.actionType,
    repositoryId: row.repository_id,
    executionId: input.executionId,
    branch: row.branch_name,
    commit: row.commit_id,
    ...input.parameters,
  };
  if (["repository.push_branch", "repository.create_pull_request"].includes(input.actionType))
    await validatePublicationPreflight({
      worktreePath: String(row.worktree_path),
      worktreeRoot: process.env.CODEX_WORKTREE_ROOT!,
      remote: String(bound.remote ?? "origin"),
      allowedRemotes: row.allowed_remotes as string[],
      targetBranch: String(bound.targetBranch ?? row.default_branch),
      protectedBranches: row.protected_branches as string[],
      allowedBranchPrefixes: row.allowed_branch_prefixes as string[],
      generatedBranch: String(bound.sourceBranch ?? bound.branch),
      approvedCommit: String(bound.commit),
      force: Boolean(bound.force),
    });
  const actionHash = canonicalHash(bound);
  const restrictions = await loadPolicyRestrictions(input.actor.workspaceId, {
    repositoryId: row.repository_id,
    agentId: row.agent_id,
    environment: "development",
    actionType: input.actionType,
  });
  const decision = evaluatePolicy({ ...policyInput(row, input.actionType, bound), restrictions });
  const requested = requestAction({
    actionType: input.actionType,
    targetResource: input.targetResource,
    parametersSummary: bound,
    actionHash,
    requestedBy: input.actor.id,
    idempotencyKey: input.commandId,
    taskId: row.task_id,
    executionId: input.executionId,
    agentId: row.agent_id,
    repositoryId: row.repository_id,
  });
  const events: NewDomainEvent[] = [
    requested,
    { eventType: "policy.evaluation_started", eventSchemaVersion: 1, payload: { status: "evaluating" } },
  ];
  const synthetic = {
    id: actionId,
    missionId: row.mission_id,
    status: "evaluating" as const,
    version: 2,
    actionType: input.actionType,
    actionHash,
  };
  events.push(policyEvaluated(synthetic, decision));
  if (decision.outcome === "deny")
    events.push(transitionAction(synthetic, "denied", { ...decision, status: "denied" }));
  const result = await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "action_request",
    aggregateId: actionId,
    missionId: row.mission_id,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RequestSensitiveAction",
    correlationId: row.mission_id,
    actor: { type: input.actor.type, id: input.actor.id },
    events,
    applyProjections: applyActionProjection,
  });
  if (decision.outcome !== "require_approval") return { actionRequestId: actionId, decision, events: result.events };
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const approvalId = await requestActionApproval({
    workspaceId: input.actor.workspaceId,
    missionId: row.mission_id,
    taskId: row.task_id,
    executionId: input.executionId,
    agentId: row.agent_id,
    actionRequestId: actionId,
    actionType: input.actionType,
    targetResource: input.targetResource,
    actionHash,
    approvalType: decision.approvalType,
    policyVersion: decision.policyVersion,
    policyReasons: decision.reasons,
    evidence: [],
    requestedBy: input.actor.id,
    expiresAt,
  });
  const current = rehydrateAction(
    await loadAggregateEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "action_request",
      aggregateId: actionId,
    }),
  )!;
  await appendAction(
    input.actor,
    actionId,
    transitionAction(current, "waiting_for_approval", {
      approvalId,
      policyVersion: decision.policyVersion,
      outcome: decision.outcome,
      reasons: decision.reasons,
    }),
    "WaitForActionApproval",
  );
  return { actionRequestId: actionId, approvalId, decision, events: result.events };
}

export async function resolveActionApproval(input: {
  actor: ActionActor;
  approvalId: string;
  granted: boolean;
  reason: string;
}) {
  if (input.actor.role && input.actor.role !== "owner")
    throw new ValidationFailedError("Workspace owner permission is required");
  const approval = (
    await getDatabasePool().query("SELECT * FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2", [
      input.actor.workspaceId,
      input.approvalId,
    ])
  ).rows[0];
  if (!approval?.action_request_id) throw new NotFoundError("Action approval");
  if (approval.status === "pending" && approval.expires_at && new Date(approval.expires_at) <= new Date()) {
    const { expireApproval } = await import("@/application/approval-commands");
    await expireApproval({
      workspaceId: input.actor.workspaceId,
      approvalId: input.approvalId,
      actorId: input.actor.id,
    });
    const expiredEvents = await loadAggregateEvents({
        workspaceId: input.actor.workspaceId,
        aggregateType: "action_request",
        aggregateId: approval.action_request_id,
      }),
      expiredState = rehydrateAction(expiredEvents)!;
    if (expiredState.status === "waiting_for_approval")
      await appendAction(
        input.actor,
        expiredState.id,
        transitionAction(expiredState, "expired", { approvalId: input.approvalId }),
        "ExpireAction",
      );
    throw new ValidationFailedError("Approval has expired");
  }
  const { decideApproval } = await import("@/application/approval-commands");
  const decision = await decideApproval({
    workspaceId: input.actor.workspaceId,
    approvalId: input.approvalId,
    granted: input.granted,
    actorId: input.actor.id,
    reason: input.reason,
  });
  if (!decision.applied) return false;
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "action_request",
    aggregateId: approval.action_request_id,
  });
  const state = rehydrateAction(events)!;
  await appendAction(
    input.actor,
    state.id,
    transitionAction(state, input.granted ? "approved" : "denied", {
      approvalId: input.approvalId,
      reason: input.reason,
    }),
    input.granted ? "ApproveAction" : "DenyAction",
  );
  if (input.granted)
    await enqueueJob({
      workspaceId: input.actor.workspaceId,
      jobType: "execute_action",
      payload: { actionRequestId: state.id },
      idempotencyKey: `execute-action:${state.id}`,
      correlationId: state.missionId,
      maxAttempts: 3,
    });
  return true;
}
