import { applyActionProjection } from "@/application/action-projector";
import { consumeApproval } from "@/application/approval-commands";
import { rehydrateAction, transitionAction } from "@/domain/action-request";
import { LocalGitProvider } from "@/git/local-git-provider";
import { canonicalHash } from "@/lib/canonical-json";
import { getDatabasePool } from "@/lib/database";
import { loadAggregateEvents, appendEvents } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";
import { evaluatePolicy } from "@/policy/policy-engine";
import { ValidationFailedError } from "@/lib/application-errors";

async function append(
  workspaceId: string,
  actionId: string,
  event: ReturnType<typeof transitionAction>,
  actorId: string,
) {
  const existing = await loadAggregateEvents({ workspaceId, aggregateType: "action_request", aggregateId: actionId });
  const state = rehydrateAction(existing)!;
  return appendEvents({
    workspaceId,
    aggregateType: "action_request",
    aggregateId: actionId,
    missionId: state.missionId,
    expectedVersion: state.version,
    commandId: stableUuid(`${event.eventType}:${actionId}:${state.version}`),
    commandType: event.eventType,
    correlationId: state.missionId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: "system", id: actorId },
    events: [event],
    applyProjections: applyActionProjection,
  });
}
export async function executeAction(workspaceId: string, actionId: string, workerId: string) {
  const row = (
    await getDatabasePool().query(
      `SELECT ar.*,ap.status approval_status,ap.expires_at,ap.action_hash approval_hash,e.worktree_path,e.branch_name,e.commit_id,a.status agent_status,a.trust_level,a.capabilities,r.default_branch,r.protected_branches,r.allowed_branch_prefixes,r.allowed_remotes,r.push_allowed,r.pull_request_allowed FROM action_request_projections ar JOIN approval_projections ap ON ap.workspace_id=ar.workspace_id AND ap.approval_id=ar.approval_id JOIN execution_projections e ON e.workspace_id=ar.workspace_id AND e.execution_id=ar.execution_id JOIN agents a ON a.workspace_id=ar.workspace_id AND a.agent_id=ar.agent_id JOIN repositories r ON r.workspace_id=ar.workspace_id AND r.repository_id=ar.repository_id WHERE ar.workspace_id=$1 AND ar.action_request_id=$2`,
      [workspaceId, actionId],
    )
  ).rows[0];
  if (!row) throw new ValidationFailedError("Action execution context is incomplete");
  if (row.status === "succeeded") return row.result;
  if (row.status !== "approved" || row.approval_status !== "granted")
    throw new ValidationFailedError("Action and approval must both be approved");
  if (row.expires_at && new Date(row.expires_at) <= new Date())
    throw new ValidationFailedError("Approval expired before execution");
  const parameters = row.parameters_summary as Record<string, unknown>;
  if (canonicalHash(parameters) !== row.action_hash || row.approval_hash !== row.action_hash)
    throw new ValidationFailedError("Approved action parameters changed");
  if (parameters.commit !== row.commit_id || parameters.branch !== row.branch_name)
    throw new ValidationFailedError("Execution commit or branch changed after approval");
  const policy = evaluatePolicy({
    actionType: row.action_type,
    environment: "development",
    agent: { status: row.agent_status, trustLevel: row.trust_level, capabilities: row.capabilities },
    repository: {
      defaultBranch: row.default_branch,
      protectedBranches: row.protected_branches,
      allowedBranchPrefixes: row.allowed_branch_prefixes,
      allowedRemotes: row.allowed_remotes,
      pushAllowed: row.push_allowed,
      pullRequestAllowed: row.pull_request_allowed,
    },
    parameters,
    reversible: false,
    affectsExternalSystem: true,
  });
  if (policy.outcome !== "require_approval" || policy.policyVersion !== row.policy_version)
    throw new ValidationFailedError("Current policy requires a new decision");
  await consumeApproval({
    workspaceId,
    approvalId: row.approval_id,
    actorId: workerId,
    policyVersion: policy.policyVersion,
  });
  let state = rehydrateAction(
    await loadAggregateEvents({ workspaceId, aggregateType: "action_request", aggregateId: actionId }),
  )!;
  await append(
    workspaceId,
    actionId,
    transitionAction(state, "executing", { policyVersionAtExecution: policy.policyVersion }),
    workerId,
  );
  try {
    let result: unknown;
    if (row.action_type === "repository.push_branch")
      result = await new LocalGitProvider().pushBranch({
        worktreePath: row.worktree_path,
        worktreeRoot: process.env.CODEX_WORKTREE_ROOT!,
        remote: String(parameters.remote),
        branch: String(parameters.branch),
        commit: String(parameters.commit),
      });
    else throw new ValidationFailedError("Pull-request provider is not configured");
    state = rehydrateAction(
      await loadAggregateEvents({ workspaceId, aggregateType: "action_request", aggregateId: actionId }),
    )!;
    await append(workspaceId, actionId, transitionAction(state, "succeeded", { result }), workerId);
    return result;
  } catch (error) {
    state = rehydrateAction(
      await loadAggregateEvents({ workspaceId, aggregateType: "action_request", aggregateId: actionId }),
    )!;
    await append(
      workspaceId,
      actionId,
      transitionAction(state, "failed", {
        classification: "action_execution_failure",
        retryDisposition: "requires-human-review",
        result: { message: error instanceof Error ? error.message : String(error) },
      }),
      workerId,
    );
    throw error;
  }
}
