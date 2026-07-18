# Phase 2 — Controlled Codex Execution

**Status:** Complete and validated — 2026-07-18

## Boundary and first outcome

Phase 2 adds one real, bounded software-engineering adapter without changing the Mission or Task aggregates, coordinator, generic job leases, approval UI semantics, or projection authority. The existing `simulated` executor stays available. The first live workflow changes a noncritical fixture repository in an isolated Git worktree, runs its declared tests, creates a local commit, and records review evidence. Push, merge, deployment, secrets access, destructive commands, infrastructure changes, and external callbacks are prohibited.

## Agent registry

Agents are workspace-owned records, not event aggregates in Phase 2. Owner commands register, enable, or disable them. Records contain adapter (`mock` or `codex`), status (`active`, `degraded`, `offline`, `disabled`), capabilities, domains, trust, concurrency, heartbeat, and references to runtime configuration and credentials. Raw credentials never enter PostgreSQL, events, prompts, artifacts, or logs. Current execution count is a query derived from nonterminal execution projections.

Dispatch requires an active agent, required capabilities, matching workspace, available concurrency, and repository permission. A stale heartbeat changes dispatch eligibility, not execution identity: it never creates a replacement execution automatically.

## Repository registry and isolation

A repository is registered by an owner with a canonical local path, default branch, allowed agent IDs, and explicit read/write/commit/push/merge/deploy flags. Browser mission input carries only `repositoryId`; it cannot submit a path.

At registration and again at execution, the worker resolves the real path and enforces that it is beneath one configured approved root. It rejects traversal, symlink escapes, missing `.git`, unregistered agents, disabled records, and disallowed base refs. Worktrees live under a separate configured worktree root and use generated paths and branches:

```text
codex/<mission-id>/<task-id>/<execution-id>
```

The worker never modifies or cleans the registered working tree. Worktrees and artifacts remain after every outcome until a separate explicit cleanup operation is approved.

## Execution aggregate

One execution aggregate represents one attempt by one agent on one task. States are `requested`, `accepted`, `preparing`, `running`, `waiting_for_approval`, `paused`, `verifying`, `succeeded`, `failed`, `timed_out`, and `cancelled`. Its events are requested, accepted, preparation started, started, meaningful progress, command completed, artifact produced, approval requested, pause/resume, verification started, succeeded, failed, timed out, cancellation requested, and cancelled.

Heartbeats are high-volume operational records in `execution_heartbeats`; the latest timestamp/stage is copied to the execution projection. Meaningful stage changes remain canonical events. Execution success deterministically transitions the Task through verification to completion; failure/timeout/cancellation uses the documented task retry or terminal policy through Task command handlers. The adapter never edits task rows.

## Protocol 1.0

Internal messages use discriminated TypeScript schemas and runtime validators. Every message includes `protocolVersion: "1.0"`, workspace, execution, mission, task, and idempotency identity. Message kinds are request, acceptance, heartbeat, progress, command result, artifact, approval request, completion, failure, cancellation request, and cancellation acknowledgement. Unknown fields may be ignored only where explicitly forward-compatible; missing/invalid fields and unsupported versions produce typed `protocol_error` failures.

Events store concise operational facts. Full prompts, transcript, command output, diff, patch, test logs, and final report are local artifact objects referenced by checksum metadata.

## Worker lifecycle

`npm run worker:codex` is a separate process. It claims only `execute_codex` jobs with PostgreSQL leases, validates registries and protocol, creates the branch/worktree, appends acceptance/preparation/start events, launches a fixed Codex CLI executable using argument arrays, emits operational heartbeats, collects bounded progress, enforces timeout/cancellation, runs allowlisted validation commands, creates a local commit if permitted, stores artifacts, and applies the execution outcome through application commands.

Recovery uses the execution aggregate and persisted worktree metadata. A redelivered job returns immediately for terminal executions. For a nonterminal execution with a valid preserved worktree, it inspects durable stage/action markers before continuing; commit creation is keyed by execution ID and existing commit metadata. Worker loss never causes concurrent duplicate execution while a lease or fresh heartbeat exists.

## Runtime and credential boundary

The controlled process runner enforces a resolved worktree cwd, argument arrays without an implicit shell, timeout, cancellation signal, output byte limits, and a minimal environment allowlist (`PATH`, locale, safe Codex configuration references, and explicitly configured test variables). It does not inherit the web or worker environment wholesale. Configured secret values and redaction patterns are removed from logs before persistence.

The Codex prompt contains mission/task facts, registered repository/base ref, generated worktree, allowed capabilities, tests, artifact requirements, and explicit no-push/no-merge/no-deploy constraints. It contains no application credentials and requests operational output, not chain-of-thought.

## Heartbeat, timeout, cancellation, and failures

- Default heartbeat interval: 30 seconds.
- Stale threshold: 90 seconds. Mark execution stalled/degraded; do not duplicate it.
- Offline threshold: 180 seconds. Agent becomes unavailable for new dispatch.
- Default coding timeout: 3600 seconds, capped by server configuration.

Cancellation appends a request, marks the operational cancellation flag, aborts child processes, preserves evidence, appends acknowledgement/cancelled, and coordinates the task. Timeout follows the same termination path but records `timed_out`. Shutdown stops claims and allows a bounded active-operation drain; the lease then permits recovery.

Failures are classified as `invalid_configuration`, `repository_unavailable`, `authentication_failure`, `codex_start_failure`, `execution_failure`, `command_failure`, `test_failure`, `timeout`, `cancellation`, `worker_lost`, `protocol_error`, `artifact_failure`, or `unknown`. Configuration, authentication, protocol, and safety failures are non-retryable; repository/worker/start failures are retryable when no mutation occurred; test, command, artifact, and unknown failures require human review; cancellation is not retried; timeout is retryable only when the task policy explicitly permits it.

## Artifacts

The local artifact provider writes beneath a configured artifact root using generated workspace/execution keys, SHA-256 verification, byte limits, and workspace-scoped metadata. Phase 2 collects prompt, redacted transcript/log, status, changed-file list, diff summary, patch, test/build logs, validation report, final summary, and commit ID when available. Events contain only kind, checksum, size, and artifact ID. No PR, push, merge, or deployment claim is emitted.

## Approval boundaries

Local read/write, declared tests, and one local commit are allowed for the first registered repository. Push is disabled, merge and deployment are prohibited. Destructive commands, migrations, infrastructure, secrets, permission expansion, and configured cost/time expansion are denied or converted to a durable approval request. Phase 2 does not implement autonomous continuation for prohibited merge/deploy actions.

## Local development and production model

Local development registers a fixture repository beneath `CODEX_REPOSITORY_ROOT`, sets `CODEX_WORKTREE_ROOT` and `ARTIFACT_STORAGE_ROOT` outside that repository, and points `CODEX_EXECUTABLE` to the installed CLI or controlled fixture executable. Web, generic worker, and Codex worker are separate processes.

Production uses a dedicated worker identity/container with PostgreSQL access, a read-limited credential reference, mounted or cloned approved repositories, separate worktree/artifact volumes, resource limits, no inbound public endpoint, and no deployment credentials. Production infrastructure remediation itself is outside Phase 2.

## Acceptance and stop condition

Acceptance records identifiers, timestamps, branch/worktree, Codex execution ID, changed files, tests, commit, and artifacts; proves the source working tree stayed untouched; restarts web and worker; proves no duplicate commit; rebuilds projections; and verifies identical UI/debrief state. Stop before Hermes, public webhooks, DeFi, autonomous merge/deploy, or multi-agent live planning.
