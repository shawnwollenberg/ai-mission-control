# Mission Control Agent Protocol 1.0 — Pull Transport

**Status:** Approved implementation boundary — 2026-07-19

Mission Agent is the outbound-only local runtime for Mission Control. Codex, Hermes, Claude Code, and generic command adapters sit behind this runtime. The first execution-capable adapter is Codex, limited to read-only repository analysis.

## Authority and source of truth

Canonical execution, task, mission, artifact, agent, and repository events remain business truth. `pull_assignments`, lease tokens, rate counters, nonces, message receipts, and local recovery files are bounded operational state. They coordinate delivery but cannot independently complete an execution or mission.

The pull transport consumes `execution.requested`, agent credential and heartbeat facts, task/resource projections, policy state, and emergency controls. It produces existing execution lifecycle events plus `agent.pull_ready`, repository registration facts, and artifact metadata. Rebuilding canonical projections preserves every user-visible business result; an interrupted lease may be safely reconstructed as available from a nonterminal requested execution.

## Authentication

Every request uses HTTPS and protocol 1.0 HMAC headers. The signature binds method, exact path, timestamp, nonce, message ID, SHA-256 body checksum, and protocol version. Mission Control validates the credential, agent, workspace, five-minute clock window, checksum, signature, nonce uniqueness, message idempotency, body size, and rate category before processing.

Credentials are created by a workspace owner and displayed once. Mission Control stores only a derived verifier. Mission Agent uses the macOS Keychain when available or an owner-readable `0600` file on Linux. Unsafe permissions are rejected. Credentials, raw local paths, source content, and unrelated command output never enter events or logs.

## Pull lifecycle

1. `AgentHeartbeat` advertises Mission Agent version, adapter, and `assignment.pull` capability.
2. `POST /api/agent-protocol/v1/assignments/pull` waits for at most 20 seconds and returns an eligible assignment or `204`.
3. Claiming creates a 60-second operational lease and an opaque lease token. Duplicate pulls by the same runtime return its active lease.
4. `POST /api/agent-protocol/v1/assignments/{id}/acknowledge` records `ExecutionAccepted` through the canonical execution command path.
5. `POST /api/agent-protocol/v1/assignments/{id}/lease` renews the lease while the same execution remains nonterminal.
6. Existing signed protocol messages report heartbeat, bounded progress, artifact, success, failure, and cancellation acknowledgement.
7. `POST /api/agent-protocol/v1/assignments/{id}/cancellation` reports whether cancellation was requested.
8. `POST /api/agent-protocol/v1/assignments/{id}/release` makes safely abandoned, nonterminal work recoverable after policy checks.

Lease tokens are stored as SHA-256 hashes and are bound to workspace, agent, assignment, execution attempt, and lease owner. Losing a lease prevents late completion from overwriting a newer attempt. Terminal executions cannot be reclaimed.

## Assignment eligibility

Mission Control returns work only when the credential and agent are active, heartbeat and pull readiness are fresh, the task is assigned to that agent, required capabilities and repository grants match, concurrency and policy allow execution, emergency controls permit remote assignments, and no valid lease exists. Queries are always scoped by the authenticated workspace and agent.

Assignment payloads contain correlation IDs, objective, bounded instructions, expected Markdown output, repository resource ID and fingerprint, timeout, allowed capabilities, read-only constraints, artifact requirements, and prohibited actions. They never contain credentials, server secrets, another workspace’s identifiers, or a complete local path.

## Codex adapter safety

The initial adapter resolves the workspace repository ID only through Mission Agent’s protected local configuration. It validates real paths and symlink boundaries, records Git branch/commit evidence, snapshots the repository before and after execution, invokes Codex with a read-only prompt and timeout, and rejects any filesystem change. It cannot install packages, commit, push, create a pull request, merge, deploy, access secrets, or run an arbitrary server-supplied shell command.

## Recovery and cancellation

Mission Agent persists only assignment identity, lease metadata, stage, artifact checksum, and acknowledgement state. On restart it heartbeats, reconciles the active assignment, renews a still-valid lease, and retransmits idempotent results. Expired leases become reclaimable; terminal results remain terminal. Cancellation polling stops new stages, asks the adapter to stop, preserves bounded evidence, acknowledges cancellation, and releases the lease.

## Limits and compatibility

Long polls are bounded to 20 seconds with client jitter. Pull, heartbeat, progress, and artifact categories have independent per-agent limits. Inline Markdown artifacts remain capped by the existing protocol and execution budgets. Protocol additions are backward compatible with push-mode 1.0 agents. Rollback disables pull registration and endpoints, stops Mission Agent clients, and leaves additive schema and canonical history intact.
