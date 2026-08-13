# Mission Control Agent Protocol 1.0 — Pull Transport

**Status:** Protocol 1.0 with additive Mission Agent 0.8.0 candidate consensus fields — updated 2026-08-04

Mission Agent is the outbound-only local runtime for Mission Control. Codex, Hermes, Claude Code, and generic command adapters sit behind this runtime. Codex and Claude Code are execution-capable through the same signed boundary; Hermes retains its existing scope.

## Authority and source of truth

Canonical execution, task, mission, artifact, agent, and repository events remain business truth. `pull_assignments`, lease tokens, rate counters, nonces, message receipts, and local recovery files are bounded operational state. They coordinate delivery but cannot independently complete an execution or mission.

The pull transport consumes `execution.requested`, agent credential and heartbeat facts, task/resource projections, policy state, and emergency controls. It produces existing execution lifecycle events plus `agent.pull_ready`, repository registration facts, and artifact metadata. Rebuilding canonical projections preserves every user-visible business result; an interrupted lease may be safely reconstructed as available from a nonterminal requested execution.

## Authentication

Every request uses HTTPS and protocol 1.0 HMAC headers. The signature binds method, exact path, timestamp, nonce, message ID, SHA-256 body checksum, and protocol version. Mission Control validates the credential, agent, workspace, five-minute clock window, checksum, signature, nonce uniqueness, message idempotency, body size, and rate category before processing.

Credentials are created by a workspace owner and displayed once. Mission Control stores only a derived verifier. Mission Agent uses the macOS Keychain when available or an owner-readable `0600` file on Linux. Unsafe permissions are rejected. Credentials, raw local paths, source content, and unrelated command output never enter events or logs.

## Pull lifecycle

1. `AgentHeartbeat` advertises Mission Agent version, adapter, and `assignment.pull` capability.
2. `POST /api/agent-protocol/v1/assignments/pull` waits for at most 20 seconds and returns an eligible assignment or `204`.
3. Claiming creates a 60-second operational lease, an opaque lease token, and increments a monotonic fencing token. Consensus operations must present the exact fence on acknowledgement, lease, cancellation, approval checks, release, and protocol callbacks.
4. `POST /api/agent-protocol/v1/assignments/{id}/acknowledge` records `ExecutionAccepted` through the canonical execution command path.
5. `POST /api/agent-protocol/v1/assignments/{id}/lease` renews the lease while the same execution remains nonterminal.
6. Existing signed protocol messages report heartbeat, bounded progress, artifact, success, failure, and cancellation acknowledgement.
7. `POST /api/agent-protocol/v1/assignments/{id}/cancellation` reports whether cancellation was requested.
8. `POST /api/agent-protocol/v1/assignments/{id}/release` makes safely abandoned, nonterminal work recoverable after policy checks.

Lease tokens are ephemeral response-bound bearer credentials. The assignment row stores only SHA-256, and protocol receipts and Mission Agent state store only a strictly validated non-secret authorization receipt containing endpoint-explicit kind, UUID lease ID, token fingerprint, issue/expiry times, fence, and exact workspace/agent/credential/assignment/execution-or-operation/owner binding. Project Brain receipts remain operation-kind even when linked to an execution. Repeating the same signed pull message returns that non-secret receipt, not the original token. A fresh pull by the same lease owner while the lease is active returns no authority-shaped assignment; the original in-memory holder may continue until expiry. After expiry a fresh claim rotates the fence and issues a new ephemeral token. Losing a pull response therefore fails closed for at most the bounded lease interval instead of reconstructing authority from durable storage. Terminal executions cannot be reclaimed.

Receipt-v2 migration requires protocol traffic to be drained. It stops if an unexpired legacy receipt remains, removes
only expired invalid operational receipts, and validates the structural constraint before completion. Retained forensic
databases are not migrated or sanitized until their separately governed evidence-destruction step.

## Assignment eligibility

Mission Control returns work only when the credential and agent are active, heartbeat and pull readiness are fresh, the task is assigned to that agent, required capabilities and repository grants match, concurrency and policy allow execution, emergency controls permit remote assignments, and no valid lease exists. Queries are always scoped by the authenticated workspace and agent.

Assignment payloads contain correlation IDs, objective, bounded instructions, expected Markdown output, repository resource ID and fingerprint, timeout, allowed capabilities, read-only constraints, artifact requirements, and prohibited actions. They never contain credentials, server secrets, another workspace’s identifiers, or a complete local path.

## Codex adapter safety

The initial adapter resolves the workspace repository ID only through Mission Agent’s protected local configuration. It validates real paths and symlink boundaries, records Git branch/commit evidence, snapshots the repository before and after execution, invokes Codex with a read-only prompt and timeout, and rejects any filesystem change. It cannot install packages, commit, push, create a pull request, merge, deploy, access secrets, or run an arbitrary server-supplied shell command.

Mission Agent 0.3.1 adds the separately selected `repository_change` assignment. It plans in the source repository under the read-only sandbox, submits the plan with a `repository.modify` approval request, and polls the approval through the signed leased-assignment channel. Only a grant permits creation of an isolated `mission/*` worktree and a workspace-write Codex invocation. The runtime accepts only parsed allowlisted validation commands, uploads review evidence, creates one local commit, and verifies the source branch and worktree are unchanged. It never pushes, creates a pull request, merges, deploys, changes infrastructure or secrets, or signs/submits transactions.

Mission Agent 0.6.0 adds a separate publication pull channel. Only a consumed owner approval for `repository.publish_for_review` produces an assignment. The runtime revalidates the exact worktree, branch, commit, clean status, remote identity, target commit, and diff checksum; pushes the exact commit without force; and uses the owner's locally scoped GitHub CLI authentication to create the approved PR. Mission Control independently confirms the provider PR, target, branch, and head SHA before recording success. This authority cannot modify more files, merge, deploy, bypass CI/review, change infrastructure or secrets, or sign/submit transactions.

Mission Agent 0.6.1 normalizes singular evidence objects emitted by Codex into the bounded evidence list required by Recommendation validation and reports execution heartbeats during long local stages. Version 0.6.2 similarly normalizes singular acceptance criteria and validation suggestions without weakening server validation. Version 0.6.3 unwraps nested protocol acknowledgement results so approval identifiers, artifact identifiers, and publication state remain consistent across the signed transport. These are compatibility fixes; they grant no additional authority.

Mission Agent 0.4.0 adds a second read-only analysis pass that emits a bounded JSON recommendation artifact. Mission Control validates that artifact before creating canonical repository Recommendation aggregates. Invalid JSON, missing evidence, unsafe paths, unsupported impact/risk values, or oversized recommendation sets fail the analysis rather than persisting untrusted model text as product state.

Mission Agent 0.5.0 extends that same read-only pass with bounded observations across architecture, tests, security, technical debt, documentation, dependencies, and CI. Mission Control validates repository-relative evidence and calculates the numeric Repository Health score itself using versioned deterministic rules. Missing dimensions remain unknown and reduce confidence; they are not treated as failures. Each assessment is a canonical event-derived snapshot linked to its source mission, execution, artifact, and repository commit.

## Recovery and cancellation

Mission Agent persists only assignment identity, non-secret lease receipt metadata, stage, artifact checksum, and acknowledgement state. It never persists the raw bearer token. On restart it heartbeats and reacquires a freshly fenced assignment after the prior bounded lease expires; it may retransmit idempotent non-authorizing results. Terminal results remain terminal. Cancellation polling stops new stages, asks the adapter to stop, preserves bounded evidence, acknowledges cancellation, and releases the in-memory lease.

## Limits and compatibility

Long polls are bounded to 20 seconds with client jitter. Pull, heartbeat, progress, and artifact categories have independent per-agent limits. Inline Markdown artifacts remain capped by the existing protocol and execution budgets. Protocol additions are backward compatible with push-mode 1.0 agents. Rollback disables pull registration and endpoints, stops Mission Agent clients, and leaves additive schema and canonical history intact.

## Consensus assignment extension

Mission Agent 0.8.0 adds a compatible `missionType: consensus_plan` task envelope containing operation, role assignment, planning round, exact repository snapshot/base commit, one immutable Project Brain artifact/hash, selected model, released source artifacts, and turn/artifact/command/retry limits. Proposal assignments contain no other proposal. Later source packages are selected server-side and normalized before delivery.

The heartbeat advertises stable provider identity, runtime version, roles, operations, models, structured-output support, Project Brain support, and repository-mutation support. Mission Control accepts only a subset of owner-approved registration capability and filters assignments by capability rather than provider name. Existing agents that omit the additive provider profile remain valid for their earlier missions but are ineligible for consensus.

Every consensus artifact is JSON except the Project Brain YAML/JSON context pack. The server checks the active execution, lease/fence, operation, role, mission, assignment, snapshot, context, schema, source artifact, reviewed artifact, canonical hash, checksum, size, and secret scan before appending canonical metadata. Agents never submit authoritative phase transitions.
