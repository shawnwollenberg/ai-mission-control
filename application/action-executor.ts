import { applyActionProjection } from "@/application/action-projector";
import { consumeApproval } from "@/application/approval-commands";
import { rehydrateAction, transitionAction } from "@/domain/action-request";
import { LocalGitProvider } from "@/git/local-git-provider";
import { GitHubProvider } from "@/git/github-provider";
import { LocalGitCredentialProvider } from "@/git/credential-provider";
import type { GitProvider } from "@/git/git-provider";
import { canonicalHash } from "@/lib/canonical-json";
import { getDatabasePool } from "@/lib/database";
import { loadAggregateEvents, appendEvents } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";
import { evaluatePolicy } from "@/policy/policy-engine";
import { loadPolicyRestrictions } from "@/policy/policy-store";
import { ValidationFailedError } from "@/lib/application-errors";
import { validatePublicationPreflight } from "@/git/publication-preflight";
import { assertCapabilityEnabled } from "@/application/emergency-controls";

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
export async function executeAction(
  workspaceId: string,
  actionId: string,
  workerId: string,
  providerOverride?: GitProvider,
) {
  const row = (
    await getDatabasePool().query(
      `SELECT ar.*,ap.status approval_status,ap.expires_at,ap.action_hash approval_hash,e.worktree_path,e.branch_name,e.commit_id,a.status agent_status,a.trust_level,a.capabilities,r.name repository_name,r.default_branch,r.protected_branches,r.allowed_branch_prefixes,r.allowed_remotes,r.push_allowed,r.pull_request_allowed,r.provider_type,r.provider_configuration_reference FROM action_request_projections ar JOIN approval_projections ap ON ap.workspace_id=ar.workspace_id AND ap.approval_id=ar.approval_id JOIN execution_projections e ON e.workspace_id=ar.workspace_id AND e.execution_id=ar.execution_id JOIN agents a ON a.workspace_id=ar.workspace_id AND a.agent_id=ar.agent_id JOIN repositories r ON r.workspace_id=ar.workspace_id AND r.repository_id=ar.repository_id WHERE ar.workspace_id=$1 AND ar.action_request_id=$2`,
      [workspaceId, actionId],
    )
  ).rows[0];
  if (!row) throw new ValidationFailedError("Action execution context is incomplete");
  if (["repository.push_branch", "repository.create_pull_request"].includes(row.action_type))
    await assertCapabilityEnabled(workspaceId, "stop_git_publication");
  if (row.status === "succeeded") return row.result;
  if (row.status === "failed" && row.retry_disposition === "requires-human-review") return row.result;
  if (row.status !== "approved" || row.approval_status !== "granted")
    throw new ValidationFailedError("Action and approval must both be approved");
  if (row.expires_at && new Date(row.expires_at) <= new Date())
    throw new ValidationFailedError("Approval expired before execution");
  const parameters = row.parameters_summary as Record<string, unknown>;
  if (canonicalHash(parameters) !== row.action_hash || row.approval_hash !== row.action_hash)
    throw new ValidationFailedError("Approved action parameters changed");
  if (parameters.commit !== row.commit_id || parameters.branch !== row.branch_name)
    throw new ValidationFailedError("Execution commit or branch changed after approval");
  const restrictions = await loadPolicyRestrictions(workspaceId, {
    repositoryId: row.repository_id,
    agentId: row.agent_id,
    environment: "development",
    actionType: row.action_type,
  });
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
    restrictions,
  });
  if (policy.outcome !== "require_approval" || policy.policyVersion !== row.policy_version)
    throw new ValidationFailedError("Current policy requires a new decision");
  await validatePublicationPreflight({
    worktreePath: row.worktree_path,
    worktreeRoot: process.env.CODEX_WORKTREE_ROOT!,
    remote: String(parameters.remote ?? "origin"),
    allowedRemotes: row.allowed_remotes,
    targetBranch: String(parameters.targetBranch ?? row.default_branch),
    protectedBranches: row.protected_branches,
    allowedBranchPrefixes: row.allowed_branch_prefixes,
    generatedBranch: String(parameters.sourceBranch ?? parameters.branch),
    approvedCommit: String(parameters.commit),
    force: Boolean(parameters.force),
  });
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
    const provider =
      providerOverride ?? (row.provider_type === "github" ? new GitHubProvider() : new LocalGitProvider());
    const credentialEnvironment = await new LocalGitCredentialProvider().environment(
      row.provider_configuration_reference ?? undefined,
    );
    if (row.action_type === "repository.push_branch")
      result = await provider.pushBranch({
        worktreePath: row.worktree_path,
        worktreeRoot: process.env.CODEX_WORKTREE_ROOT!,
        remote: String(parameters.remote),
        branch: String(parameters.branch),
        commit: String(parameters.commit),
        credentialEnvironment,
      });
    else if (row.action_type === "repository.create_pull_request") {
      const pushed = (
        await getDatabasePool().query(
          `SELECT result FROM action_request_projections WHERE workspace_id=$1 AND repository_id=$2 AND execution_id=$3 AND action_type='repository.push_branch' AND status='succeeded' AND result->>'branch'=$4 AND result->>'commit'=$5 LIMIT 1`,
          [
            workspaceId,
            row.repository_id,
            row.execution_id,
            String(parameters.sourceBranch),
            String(parameters.commit),
          ],
        )
      ).rows[0];
      if (!pushed) throw new ValidationFailedError("Pull request requires a confirmed matching remote branch");
      result = await provider.createPullRequest({
        repository: String(parameters.providerRepository ?? row.repository_name),
        sourceBranch: String(parameters.sourceBranch),
        targetBranch: String(parameters.targetBranch),
        commit: String(parameters.commit),
        title: String(parameters.title),
        description: String(parameters.description),
        idempotencyKey: row.idempotency_key,
        credentialEnvironment,
      });
    } else throw new ValidationFailedError("No executor exists for this action type");
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
