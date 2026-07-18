# Phase 3 — Policy, Approval, and Publication

**Status:** Complete and validated — 2026-07-18

## Boundary and first outcome

Phase 3 adds enforceable publication controls without changing Mission, Task, or Execution authority. A completed Codex execution may request two separate external effects: push its exact generated branch, then create a pull request for that confirmed remote branch. Each effect is a durable Action Request, deterministically evaluated, separately approved, revalidated, and executed by a leased worker. Merge and deployment are not action implementations and remain denied.

## Runtime baseline

Node `>=22.20.0 <23` is mandatory. `.nvmrc`, strict npm engines, a preinstall guard, explicit CI validation, and worker startup checks enforce it. Every operations guide begins with `nvm use`, and Phase 3 evidence is collected under Node 22.20.0.

## Policy model

Policy definitions are immutable versioned workspace records with optional repository, agent, environment, and action scopes, effective dates, enabled state, priority, and JSON rule configuration. The Phase 3 evaluator is a pure deterministic function over an explicit snapshot: workspace, mission/task/execution, agent capabilities/trust/status, repository protections, requested action and canonical parameters, environment, reversibility/external-effect flags, approval history, and budget state.

The result is `allow`, `require_approval`, or `deny`, with policy version and stable reason codes. Repository and agent restrictions can only narrow workspace defaults. Permanent denials win over approvals: protected/default branch push, force push, merge, deployment, secrets, infrastructure modification, destructive database operations, execution outside the worktree, unregistered repositories, signing, and asset movement.

Local registered-repository reads/writes, declared validation, formatting/lint, generated branches, local commits, and artifact creation remain allowed. Generated-branch push and pull-request creation require approval. Permission/timeout/budget increases and potentially destructive commands require approval only where a separately implemented safe executor exists; Phase 3 does not create executors for permanently denied categories.

## Action Request aggregate

States are `requested`, `evaluating`, `denied`, `waiting_for_approval`, `approved`, `executing`, `succeeded`, `failed`, `expired`, and `cancelled`. Canonical events are `action.requested`, `policy.evaluated`, `action.allowed`, `action.denied`, `action.approval_requested`, `action.approved`, `action.execution_started`, `action.execution_succeeded`, `action.execution_failed`, `action.expired`, and `action.cancelled`.

The aggregate owns the requested action type, target resource, sanitized parameter summary, canonical SHA-256 parameter hash, policy version/outcome/reasons, requester, approval ID, execution result, failure classification/disposition, correlation, and idempotency. Projectors are disposable. External execution originates only from a durable job written with the authorizing event.

## Approval semantics

The existing approval aggregate is extended to `pending`, `granted`, `denied`, `expired`, `cancelled`, and `consumed`. A publication approval records action request, execution, agent, action type, target, risk, policy reasons, evidence references, expiry, requester/decider, decision reason, original policy version, execution-time policy version, and action hash.

Granting is idempotent. A grant authorizes only its action request and hash. It is consumed atomically when action execution begins, preventing reuse while preserving retry recovery for that same action. Denial and expiry are terminal for that request. A new attempt requires a new Action Request and approval.

Before execution the worker verifies workspace/owner authority, approval status and expiry, unconsumed identity, action/resource/hash equality, exact repository/execution/branch/commit/remote values, and current policy. A deny stops permanently. A changed policy or material parameter requires a new approval. The original and execution-time policy versions are recorded.

## Git publication boundary

`GitProvider` exposes only `pushBranch` and `createPullRequest`. Domain code has no GitHub fields. The local provider uses argument arrays without a shell and pushes `refs/heads/<generated>` to the same remote branch without force. It verifies the local branch contains the exact approved commit and no later commit. Allowed remote names and generated prefixes come from the repository registry; default/protected branches and arbitrary refspecs are rejected after approval as defense in depth.

Credentials are resolved by a `GitCredentialProvider` only inside the action worker. References may be stored; values may not enter PostgreSQL, canonical events, prompts, artifacts, or logs. Codex never receives publication credentials. Production uses an installation/secret-manager provider. A safe fixture provider proves behavior locally; a real GitHub acceptance uses an owner-configured noncritical repository and records only provider, PR number/URL, branches, commit, and state.

Pull-request creation requires a previously confirmed successful push action for the same repository, execution, source branch, and commit. Target must be the configured default branch. Provider confirmation is required before recording a URL. Duplicate delivery resolves by provider/idempotency identity and never creates a second PR. Merge is absent from the provider interface.

## Budgets and command policy

Execution limits cover duration, retries, commands, artifact/log bytes, per-agent and per-repository concurrency, estimated model cost, and tokens when reported. Configured warning thresholds append durable evidence; hard limits stop safely. Increasing a limit creates an approval-gated action and never mutates a running process directly from browser input.

Commands are classified as `read_only`, `build`, `test`, `file_modification`, `package_install`, `database_migration`, `destructive`, `infrastructure`, `secret_access`, `network_access`, or `unknown`. The controlled runner accepts only server-configured argument arrays in the worktree. Destructive, infrastructure, secret access, and unknown are denied by default. The prompt is advisory; the runner is enforcement.

## UI and audit

`/approvals` is the owner inbox with status/action/mission/agent/risk filters, expiry, evidence, reasons, and decision reason. Mission and execution views show action, policy version/outcome/reasons, approval, result, and audit timeline. `/audit` is a workspace-scoped projection from action, policy, approval, and execution events: actor, action, resource, decisions, result, timestamp, and correlation. Credential references and sensitive payloads are excluded.

## Recovery and failures

Action jobs use leases and idempotent provider operations. Restart before effect permits lease recovery; restart after an uncertain effect first queries/verifies remote state. Matching remote state completes safely. It never force-pushes. Failures cover expiry/denial/policy or commit change, remote/auth/rate limits, branch conflict/non-fast-forward, existing PR, provider timeout, duplicate delivery, and worker interruption, each with retryable, non-retryable, or human-review disposition.

Projection rebuild replays events only and never repeats Git effects. Approval/action projections and the mission debrief reconstruct from canonical facts. The debrief distinguishes local implementation, approved push, confirmed PR, no merge, and no deployment.

## Deployment and rollback

Web, generic execution worker, Codex worker, and action worker remain separate processes. The action worker alone receives a narrow credential-provider reference and outbound provider access. Rollback disables action claiming and policy definitions; it never deletes events or remote refs. Schema changes are forward-only and compatible with Phase 1 simulated approvals and Phase 2 executions.

## Acceptance stop condition

Acceptance denies the first push with no remote change, approves a new exact-commit push, separately approves a confirmed real pull request, proves merge/deploy unavailable, restarts web/workers, rebuilds projections, and verifies identical audit/debrief truth. Stop before merge, deployment, production remediation, or blockchain execution.
