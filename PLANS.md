# Mission Control — Production Readiness Execution Plan

The long-term product direction is maintained in `docs/INTERNAL_PRODUCT_ENGINEERING_ROADMAP.md`. It guides architecture and phase sequencing but does not authorize implementation or expand agent authority; the approved boundaries in this plan remain controlling.

**Status:** Phase 3 complete at `76ea49b`; Phase 4 remote-agent integration approved — 2026-07-18

**Planning date:** 2026-07-18

**Operating rule:** Deliver one reviewable vertical slice per phase and stop at every phase boundary

## Outcome

Evolve the deployed demo into a domain-neutral operational control plane while preserving its event-derived launch, crisis, recommendation, approval, provenance, and debrief experience. Production readiness means durable state, authenticated integrations, enforceable policy, observable execution, recovery behavior, and tested audit reconstruction—not a connected UI alone.

## Non-negotiable invariants

1. Canonical events are append-only; corrections are new events.
2. UI and operational status are rebuildable projections with no independent business state.
3. Commands validate expected aggregate version, legal transition, policy, and idempotency before append.
4. External effects originate from durable outbox/job records, never an untracked web request.
5. Simulated, controlled, fallback, and live execution are visibly distinct.
6. Raw secrets, prompts, chain-of-thought, and large artifact bodies are excluded from events and logs.
7. No autonomous financial transaction execution is introduced.
8. Every phase preserves a one-command deterministic demo path and stops for review.

## Phase 0 — Audit and architecture (complete)

### Delivered

- Repository and runtime audit: `docs/PRODUCTION_GAP_ANALYSIS.md`.
- Four-plane architecture, domain model, event catalog, execution protocol, state machines, persistence proposal, threat model, and migration strategy: `docs/PRODUCTION_ARCHITECTURE.md`.
- This phased executable plan.
- Root Codex instructions updated for the production-planning gate.

### Validation evidence

- Typecheck passed.
- 8/8 automated tests passed.
- Production build passed.
- Local launch page, health endpoint, and mission creation passed.
- Production dependency audit reported zero vulnerabilities.
- Lint gate is broken and recorded as Phase 1 bootstrap work.

### Review gate — passed 2026-07-18

Approved: modular monolith, PostgreSQL authority, transactional outbox and database-backed jobs, workspace-aware schema, single-user secure Phase 1 authentication, indefinite domain-event retention, local/S3-compatible artifact abstraction, one-way DynamoDB import, and an external Codex worker boundary. Phase 2 execution dispatch remains out of scope.

## Phase 1 — Durable domain core

**Completion:** Accepted implementation evidence is recorded in `docs/PHASE_1_COMPLETION_REPORT.md`. All ten vertical slices are complete. No Phase 2 external adapter work has begun.

**Goal:** Run the existing mock demo on production-grade events, explicit state machines, and rebuildable read models.

### Reviewable vertical slices and commit boundaries

1. **Validation baseline:** Node 22 declarations, Prettier check, supported ESLint flat configuration, CI validation workflow.
2. **PostgreSQL foundation:** Docker Compose, database client, migration runner, ordered migrations, reset-safe development instructions.
3. **Workspace and authentication:** seeded default workspace/user/membership, signed secure session cookie, owner/member authorization helpers, server-side workspace enforcement.
4. **Event store:** v2 envelope, atomic multi-event append, aggregate head/version constraint, global position, command idempotency, typed concurrency conflict.
5. **State machines:** authoritative Mission and Task transitions, dependency readiness, idempotent command handlers, terminal protection.
6. **Projections:** transactional mission/task projections, query APIs, projector version/checkpoints, UI reads from projections rather than React reconstruction.
7. **Outbox and internal jobs:** event/outbox atomicity, leased database jobs, bounded retries, dead-letter state, graceful worker shutdown and health/readiness.
8. **Replay and artifacts:** resumable/restartable projection rebuild, artifact metadata and local storage provider with checksum/integrity verification.
9. **DynamoDB compatibility:** idempotent one-way import CLI, legacy envelope translation, source metadata, incompatibility report, removal plan.
10. **Demo cutover:** versioned mock template and PostgreSQL-backed existing demo, golden projection/browser regression, operational docs and Phase 1 report.

### Durable browser route migration — approved 2026-07-18

| Browser-facing path                                                       | Slice disposition                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`, `/logout`, `/api/auth/*`                                        | Migrated to PostgreSQL-backed owner authentication and server-validated sessions.                                                                                                         |
| `/` mission launch                                                        | Migrated to authenticated durable creation; retains the existing visual launch treatment.                                                                                                 |
| `GET/POST /api/missions`                                                  | One production list/create API backed by workspace-scoped projections and `CreateMission`. Legacy creation is removed.                                                                    |
| `/missions`                                                               | New durable projection-backed mission list ordered by `updated_at`.                                                                                                                       |
| `/missions/:missionId`                                                    | Migrated to PostgreSQL mission projection plus browser-safe PostgreSQL timeline. Clearly labeled `Simulated execution`.                                                                   |
| `/api/missions/:missionId/events`                                         | Migrated to authenticated, workspace-scoped safe timeline query. Raw legacy event responses are removed.                                                                                  |
| `/api/missions/:missionId/{plan,start,pause,resume,complete,fail,cancel}` | Explicit authenticated command endpoints with version checks and typed errors.                                                                                                            |
| `/api/missions/:missionId/advance`, `/approve`                            | Removed from the browser surface; browser-timer authority is prohibited.                                                                                                                  |
| Legacy `mission-console.tsx`                                              | Removed after durable detail controls replace it.                                                                                                                                         |
| JSONL/DynamoDB demo event adapters                                        | Temporarily retained only for compatibility tests and the one-way import slice; inaccessible from main production navigation. Tracked for removal after import compatibility is complete. |
| Hard-coded demo debrief and ServicePilot preview                          | Preview remains isolated demo evidence; the hard-coded mission debrief is removed from the durable mission path. A future debrief must derive from recorded events.                       |

All lifecycle activity in this slice is manual and server-authoritative. It is explicitly presented as simulated execution; no connected agent is implied.

### Schema outline

All tenant-owned tables include `workspace_id`. Domain events have no routine deletion policy.

| Table                                                     | Purpose / key constraints                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspaces`                                              | Default workspace and future isolation boundary.                                                                                                 |
| `users`, `workspace_memberships`                          | One Phase 1 user; unique membership and `owner`/`member` role.                                                                                   |
| `events`                                                  | Global `position`; unique `event_id`; unique `(workspace_id, aggregate_type, aggregate_id, aggregate_version)`; versioned JSON payload/metadata. |
| `aggregate_heads`                                         | Current version per workspace aggregate; locked during append.                                                                                   |
| `commands`                                                | Unique workspace/idempotency key with result event IDs and status.                                                                               |
| `outbox`                                                  | Effect/consumer intent committed with events; unique idempotency key.                                                                            |
| `projection_checkpoints`                                  | Projector name/version, last global position, rebuild state/error.                                                                               |
| `mission_projections`                                     | Transactional, rebuildable mission read model.                                                                                                   |
| `task_projections`, `task_dependencies`                   | Transactional, rebuildable task state and dependency graph.                                                                                      |
| `execution_projections`, `approval_projections`, `agents` | Workspace-aware Phase 1 schema foundation; execution behavior remains deferred.                                                                  |
| `jobs`, `dead_letters`                                    | Internal leased jobs, attempts, backoff, failure visibility.                                                                                     |
| `artifacts`                                               | Metadata/checksum/object reference only; large content stays outside PostgreSQL/events.                                                          |
| `webhook_deliveries`, `idempotency_records`               | Schema foundation for later authenticated adapters.                                                                                              |

### Migration order

1. Extensions/enums and identity/workspace tables.
2. Canonical events, aggregate heads, commands, and idempotency constraints.
3. Mission/task projections and dependency edges.
4. Outbox, jobs, dead letters, and projection checkpoints.
5. Agent/execution/approval/webhook projection foundations.
6. Artifact metadata.
7. Seed the default workspace, single user, membership, templates, and deterministic demo data through an idempotent seed command.

Migrations are forward-only in production. Development reset is explicit and never targets an unresolved database. Rollback is an application-version rollback plus a compatible forward migration when data has already been committed.

### Event-store API

```ts
interface ProductionEventStore {
  append(input: {
    workspaceId: string;
    aggregateType: string;
    aggregateId: string;
    expectedVersion: number;
    commandId: string;
    correlationId: string;
    causationId?: string;
    actor: { type: "human" | "agent" | "system" | "scheduler"; id: string };
    events: NewDomainEvent[];
    outbox?: NewOutboxMessage[];
  }): Promise<AppendResult>;
  readAggregate(query: AggregateQuery): Promise<DomainEvent[]>;
  readMission(query: MissionEventQuery): Promise<DomainEvent[]>;
  readAll(query: GlobalEventQuery): Promise<DomainEventPage>;
}
```

An incorrect `expectedVersion` throws a typed conflict and appends nothing. A repeated `commandId` returns the stored result. Database uniqueness is authoritative.

### Projection strategy

- Mission and Task projections are updated **transactionally** with canonical append during Phase 1.
- Outbox delivery and future operational consumers are **asynchronous**.
- Every projection is **rebuildable** by a deterministic projector from global event position zero.
- Rebuild uses a named projector version, shadow/rebuild state, checkpoints, and idempotent upserts. A failed rebuild may resume from its committed checkpoint or restart after clearing only its isolated rebuild target.
- UI query routes read projection tables. React owns presentation and ephemeral interaction state only.

### Authentication choice

Phase 1 uses one environment-configured user authenticated by a server-validated password and a signed, `HttpOnly`, `Secure` (in production), `SameSite=Lax` session cookie with bounded lifetime and key rotation support. The user belongs to one automatically seeded default workspace. Authorization helpers require an active owner/member membership on every command and query. Password and session secrets come from the secret provider/environment and never enter domain events or tables. Multi-user OIDC, invitations, SSO, and advanced RBAC are deferred.

### Artifact storage

The `ArtifactStore` port supports write, metadata lookup, authorized download reference, temporary deletion, and SHA-256 integrity verification. Local files use a configurable directory outside the repository. Production uses an S3-compatible provider. PostgreSQL stores only workspace/mission/task/execution references, provider/key, media type, byte size, checksum, provenance, and lifecycle metadata.

### Database-backed job boundary

Phase 1 jobs are internal only: projection processing/rebuild, outbox processing, and failed-job detection. Workers use leases, bounded attempts, jittered backoff, correlation IDs, dead letters, graceful shutdown, and separate liveness/readiness. No job may start Codex or another external agent during Phase 1.

### DynamoDB migration approach

Provide an explicit CLI that reads legacy mission events through the existing DynamoDB adapter, translates supported `1.0` demo events into the v2 envelope, preserves safe IDs/timestamps, adds `metadata.importSource = "dynamodb-demo-v1"`, and appends with a stable import command ID. Repeated imports are idempotent. Unsupported records are reported and skipped without partial aggregate corruption. There is no dual write or continuous synchronization. After an agreed compatibility window, retain an export and remove DynamoDB application reads/infrastructure in a separately approved migration.

### Known risks

- Introducing PostgreSQL into the current DynamoDB deployment changes operating cost and recovery procedures.
- Legacy demo event meanings are message-dependent and may not map cleanly to normalized production events.
- Transactional projectors can lengthen append latency or couple schema rollout to event rollout.
- Cookie authentication is intentionally narrow and must not become an accidental long-term identity platform.
- A local filesystem artifact provider is single-host only and must never be selected in horizontally scaled production.
- Demo pacing currently depends on browser timers and must move to deterministic mock jobs without changing the judge-facing rhythm.
- The repository currently runs under Node 20 locally; all acceptance evidence must be regenerated under Node 22.

### Phase 1 acceptance tests

1. PostgreSQL mission and projections survive web and worker restart.
2. Empty-state replay reconstructs the complete mission/task projections.
3. Repeated command ID produces no duplicate event/outbox outcome.
4. Two appends at one expected version yield one success and one typed conflict.
5. Illegal Mission/Task transitions append nothing.
6. Completing a dependency changes a blocked dependent task to ready through canonical events.
7. Workspace A cannot query or command Workspace B data.
8. Applicable events and outbox records commit or roll back together.
9. Failed projection rebuild resumes or restarts without corrupting the active projection.
10. Existing launch → recommendation → approval → debrief flow runs from PostgreSQL-backed state.
11. Terminal aggregates reject later mutation except explicitly modeled correction/audit commands.
12. Artifact write/read/download/delete/integrity behavior is workspace-authorized and checksum-verified.

### Proposed scope

1. Repair toolchain baseline: enforce Node 22, replace broken lint command, add format/lint/typecheck/test/build CI gates.
2. Add PostgreSQL migrations for events, aggregate heads, commands, outbox, projection checkpoints, jobs/dead letters, and initial projections.
3. Implement v2 event envelope, schema registry, legacy demo upcasters/projector, optimistic aggregate append, and command idempotency.
4. Implement Mission, Task, and Execution transition tables plus dependency readiness.
5. Add projection runner, checkpointing, seed command, rebuild command, and equality checks.
6. Convert the controlled Stripe flow into `demo-stripe-billing@1` using a deterministic mock adapter and controllable clock.
7. Switch the demo behind a feature flag only after golden event/projection and browser regression tests pass.

### Files/systems expected to change

Domain/application/event modules, database schema and migration tooling, event-store adapters, mock template/adapter, route command boundary, tests, CI, environment documentation, and deployment database configuration. Experience styling should not materially change.

### Compatibility and migration risks

- Legacy `1.0` demo events must remain readable.
- Existing DynamoDB mission links need an explicit retention/read-only decision.
- PostgreSQL cutover must not duplicate commands or effects.
- Projector changes can alter visible demo state; golden snapshots and browser tests are mandatory.

### Acceptance criteria

- Fresh database migration and seed complete with documented commands.
- Every task/execution transition accepts legal moves and rejects illegal moves in unit tests.
- Concurrent commands yield one aggregate version sequence and one idempotent result.
- Dropping all projections and rebuilding produces identical checksums and visible demo state.
- Process restart at every demo phase does not lose or duplicate progress.
- Full deterministic demo completes with the same truth labels and no browser-timer authority.
- Formatting, lint, typecheck, unit/integration tests, build, and dependency audit pass.

### Stop report

State what is real, mocked, incomplete, and deferred; list migrations and rollback; provide demo regression evidence; stop for review.

## Phase 2 — Real agent execution

**Goal:** Dispatch and supervise real external work through durable, authenticated adapter boundaries.

**Authorized vertical slice:** One bounded software-engineering task against a registered noncritical repository, executed by a real Codex CLI in a generated Git worktree. Local edits, declared tests, artifact collection, and a local commit are permitted. Push, PR creation, merge, deployment, destructive commands, infrastructure modification, secrets access, Hermes, public webhooks, DeFi, and multi-agent live execution are excluded. Detailed decisions: `docs/PHASE_2_CODEX_EXECUTION.md`.

### Reviewable implementation slices

1. Architecture and protocol documents.
2. Workspace-scoped agent and repository registries.
3. Execution aggregate, transactional projection, and task coordination.
4. Runtime-validated protocol 1.0.
5. Realpath repository guard, worktree manager, and safe process runner.
6. Codex adapter command-line vertical slice.
7. Leased Codex worker, operational heartbeats, recovery, cancellation, timeout, and failure classification.
8. Checksummed local artifacts and execution evidence.
9. Owner agent/repository management and live execution browser UI.
10. Restart, safety, projection replay, integration, real acceptance, and completion report.

### Phase 2 invariants

- Codex-specific logic stays in registry, adapter, worker, protocol translation, artifact, and runtime-security modules.
- The adapter never edits Mission, Task, Approval, or projection rows directly.
- Browser input references repository IDs only; paths and branches are resolved from owner-managed policy.
- Every live execution uses a unique generated branch/worktree and preserves it for review.
- Full prompts, transcripts, diffs, and logs are artifact bodies, not event payloads.
- No execution can push, merge, deploy, access secrets, or expand permissions autonomously.
- `mock` and `codex` remain visibly and operationally distinct.

### Proposed scope

1. Add agent registry, capabilities, trust, concurrency, configuration and credential references.
2. Implement adapter port plus `mock` and signed `webhook` adapters.
3. Add durable dispatch/delivery/poll/heartbeat/timeout/retry/cancel jobs with leases, backoff, and dead letters.
4. Add authenticated protocol endpoints for acceptance, heartbeat, progress, artifact, completion, failure, and cancellation.
5. Add per-agent credentials/signatures, timestamp/replay protection, schema/size validation, and execution authorization.
6. Add operational execution and delivery projections while retaining the existing Mission Log presentation.

### Acceptance criteria

- A ready task is dispatched once logically under duplicate job delivery.
- Duplicate callbacks return the original result and append no duplicate event.
- Invalid signature, stale timestamp, wrong agent/execution, schema violation, and illegal transition are rejected and audited safely.
- Stale heartbeat produces deterministic timeout/health evidence; a retry creates a new attempt.
- Pause, cancel, manual retry, and reassign survive worker and web restarts.
- Dead-lettered work is visible and recoverable by an authorized operator.
- Mock-adapter software mission succeeds end to end without arbitrary sleeps.

### Stop report

Demonstrate worker termination/recovery and callback replay tests; stop for review before policy-driven sensitive actions.

## Phase 3 — Human identity, approvals, and policy

**Goal:** Make human and agent authority enforceable and auditable.

**Authorized vertical slice:** Deterministic versioned policy, durable parameter-bound action requests and approvals, approval-gated push of the exact generated execution branch, separately approved pull-request creation, operational budgets, approval inbox, and workspace audit history. Merge, deployment, secrets, destructive production changes, infrastructure modification, and financial/blockchain actions remain permanently denied. Detailed decisions: `docs/PHASE_3_POLICY_APPROVALS.md`.

### Proposed scope

1. Add OIDC authentication, workspaces, initial roles, ownership checks, secure sessions/headers, CSRF and rate limiting.
2. Add versioned deterministic policy engine and credential-provider abstraction.
3. Add approval request, grant, deny, expire, and stale-decision behavior bound to exact action/evidence/version.
4. Build approval inbox and evidence view from projections.
5. Add software, systems, and DeFi analysis-only default policies.

### Acceptance criteria

- Cross-workspace read/command attempts fail in API and integration tests.
- UI hiding is never the enforcement boundary.
- Merge/deploy/destructive requests cannot dispatch without a valid, unexpired, parameter-bound approval.
- Approval denial and expiration append audit events and prevent action.
- Changed action parameters make an earlier approval stale.
- DeFi signing/submission is denied even when an approval is attempted.
- No credential value is stored in domain tables, events, or logs.

### Stop report

Provide threat-model test evidence and policy matrix; stop for security review.

## Phase 4 — Generic authenticated remote agents

**Goal:** Coordinate Hermes and Codex through the same domain-neutral execution authority while adding no financial, production, merge, deployment, secret, or unrestricted-command authority.

**Architecture:** `docs/PHASE_4_REMOTE_AGENTS.md` defines the trust model, signed protocol 1.0, durable delivery, callbacks, capabilities, health, artifacts, approvals, recovery, Hermes bridge, deployment shape, threat model, and migration.

### First reporting boundary

1. Owner registers Hermes and receives a credential exactly once.
2. Signed protocol messages pass schema, timestamp, nonce, message, credential, workspace, and constant-time signature validation.
3. Hermes advertises capabilities and heartbeats.
4. An execution request is committed with a durable outbox delivery.
5. Hermes separately accepts, reports progress, submits one checksummed Markdown artifact, and completes.
6. Duplicate messages are idempotent; nonce replay and changed-payload message reuse are rejected and audited.

### Remaining Phase 4 slices

1. Deterministic capability/resource/policy/concurrency assignment and health calculation.
2. Remote approval request and decision delivery for analysis/workflow decisions only.
3. Remote supervision and credential rotation UI.
4. Genuine operational-health Hermes mission and restart recovery.
5. Read-only DeFi analysis with signing/submission absent and denied.
6. Mixed Hermes analysis and Codex implementation mission with separate push and PR approvals.
7. Full security, recovery, projection rebuild, browser, and operational validation.

### Completion status

Phase 4 implementation and genuine DeFi/mixed-agent acceptance completed on 2026-07-18. Credential lifecycle, deterministic health and eligibility, separate resource grants, durable remote approvals, browser supervision, analysis-only DeFi, and a Hermes-to-Codex handoff are operational. The exact Codex commit was pushed after a separate approval. PR creation remained safely unperformed because GitHub rejected the fixture branch's unrelated history; no history rewrite or authority expansion was attempted. See `docs/PHASE_4_COMPLETION_REPORT.md` and `docs/PHASE_4_OPERATIONS.md`.

### Acceptance criteria

- At least one genuine Hermes execution and one mixed Hermes/Codex mission use the generic protocol and existing aggregates.
- HTTP acknowledgement records delivery only; an authenticated protocol message records acceptance.
- Restart and duplicate delivery/callback tests preserve one coherent execution and artifact set.
- Agent availability is calculated by Mission Control from heartbeat, delivery, failure, saturation, credential, and disablement evidence.
- All visible remote state and audit history rebuild from canonical events; operational rate/nonce/delivery records remain bounded infrastructure state.
- DeFi tasks are analysis only, and transaction signing/submission remain structurally absent and policy denied.

### Stop report

Report at the first vertical-slice boundary, then complete DeFi, mixed-agent, UI, recovery, and full validation. Stop before transaction signing, production remediation, merge, deployment, or secret access.

## Phase 5 — Scheduling and operational workflows

**Goal:** Prove the core is domain-neutral through safe templates and scheduled mission instances.

**Authorized scope:** Versioned immutable mission templates, timezone-aware one-time/recurring schedules, leased idempotent scheduler runs, durable notifications, evidence-based usage/cost, projection-backed daily operations, safe recovery controls, worker readiness, and production operations documentation. All scheduled and manual launches use the existing command, eligibility, resource, policy, approval, and audit paths. Detailed decisions: `docs/PHASE_5_OPERATIONS.md`.

### First reporting boundary

1. Publish five initial template version 1 definitions with registered-resource input validation.
2. Launch immutable mission/task snapshots from an exact template version.
3. Create one-time and recurring schedules with explicit timezone, concurrency, and missed-run policy.
4. Run a dedicated leased scheduler using deterministic run keys.
5. Complete one scheduled Hermes health report and produce an in-app notification.
6. Restart the scheduler and prove no duplicate mission or notification.
7. Rebuild and verify template, schedule, mission, and notification projections.

### First-boundary status

Completed on 2026-07-19. Five published templates, immutable version snapshots, durable one-time and recurring schedules, leased deterministic schedule runs, the genuine scheduled Hermes health report, in-app completion notification, restart idempotency, and projection rebuild equality are demonstrated. See `docs/PHASE_5_FIRST_BOUNDARY.md`.

### Proposed scope

1. Add immutable template versions for software delivery, DeFi analysis, and systems monitoring.
2. Add one-time/recurring schedules, time zones, disabled/manual modes, concurrency, and missed-run policy.
3. Add deterministic health from heartbeat, failure, critical path, approval age, budget, deadline, availability, and retry evidence.
4. Add usage/cost projections, agent heartbeat/detail, artifact viewer, and failed-job operations UI.

### Acceptance criteria

- Each schedule trigger creates a new mission instance and never mutates a permanent mission.
- Concurrent/missed runs follow configured policy under clock-controlled tests.
- DeFi analysis ends with simulation/recommendation and contains no transaction execution path.
- Monitoring mission detects a fixture anomaly, gates sensitive remediation, verifies recovery, and emits an incident debrief.
- Mission debrief values are computed exclusively from recorded evidence.
- Cost/usage totals reconcile to execution events and omit sensitive content.

### Stop report

Show all three templates on the same orchestration core; stop before broad adapter or marketplace expansion.

### Completion status

Phase 5 completed on 2026-07-19. Mission Control now provides bounded schedule concurrency/recovery, lifecycle and run-now controls, preferences and durable external notifications, evidence-classified usage/cost, deterministic budgets, worker health/readiness, dead-letter recovery, an attention-first operations dashboard, safe search and saved views, deterministic anomalies with remediation denial, bounded retention, restore validation, and production operations documentation. Full Node 22, PostgreSQL, worker restart, projection rebuild, and browser validation passed. See `docs/PHASE_5_COMPLETION_REPORT.md`.

## Phase 6 — Production launch and daily adoption

**Goal:** Deploy the existing modular monolith as the owner's daily control plane without expanding agent authority.

**Authorized topology:** Render web plus seven long-running workers, human-created Render PostgreSQL, Cloudflare R2 durable artifacts, one independent uptime monitor, and one approved external notification destination. Auto-deploy remains off; exact reviewed production commits are deployed manually. The Codex worker is isolated with temporary persistent worktrees, while durable output is copied to R2.

**Pre-provider boundary status:** Production hardening, migration safeguards, owner provisioning, object storage, readiness, security headers, durable emergency controls, Blueprint, provider checklist, environment manifest, rollout/rollback procedure, runbooks, and acceptance log are implemented. Provider resources remain untouched pending human selections in `docs/PHASE_6_PROVIDER_INPUTS.md`.

**Permanent authority boundary:** Mission Control agents cannot deploy, merge, remediate production autonomously, modify arbitrary infrastructure or secrets, sign/submit blockchain transactions, move assets, or modify DeFi positions. Git push and PR creation remain separately approval-gated.

**Next boundary:** After human provider configuration, migrate production, provision owner, verify R2, deploy web/workers, validate login/Operations/monitoring/Hermes/emergency controls, then onboard one safe repository and begin the minimum seven-day acceptance period.

## Adoption milestone — First agent to first mission

**Goal:** Remove documentation and Agent Registry from the first-run path so a new owner can reach a verified agent heartbeat and a preselected first mission without product knowledge.

**Authorized first boundary:** Guided onboarding creates a workspace-scoped remote identity and one-time credential, presents one copyable command, installs the credential locally with owner-only permissions, starts a signed protocol 1.0 heartbeat, detects that heartbeat in the browser, and advances directly to a small read-only first mission. The Agent Registry remains a post-connection management surface. The connector does not gain merge, deployment, infrastructure, secret, signing, submission, or other prohibited authority.

**Canonical events and projections:** `agent.registered`, `agent.credential_created`, `agent.heartbeat_received`, and `agent.credential_verified` remain the canonical history. The existing agent projection supplies onboarding status; the wizard owns only ephemeral selection, copy, loading, and polling state. Replaying agent events must continue to reconstruct the visible connection state.

**Acceptance criteria:**

1. A new owner chooses Codex, Hermes, Claude Code, or Generic Remote Agent without opening documentation.
2. One command stores the displayed-once credential with owner-only permissions and starts the connector heartbeat.
3. The browser observes the authenticated heartbeat and advances automatically.
4. Generic agents can reveal their prefilled endpoint, credential identifier, protocol version, and test command.
5. The next primary action is a preselected, read-only first mission; the Agent Registry is secondary.
6. Existing protocol signature, replay, workspace-isolation, capability, policy, and permanent action prohibitions remain enforced.

**Deferred from the first boundary:** A distributable npm package, OS service management, inbound work polling for machines without public callbacks, and fully automatic Codex/Hermes/Claude execution. These must be delivered before claiming that the connected agent completed the first mission.

### Pull-based Mission Agent boundary — approved 2026-07-19

Mission Agent is the outbound-only local runtime. Pull assignments use bounded long polling and durable operational leases; canonical execution events remain business truth. Codex is the first complete adapter and is restricted to read-only repository analysis. Hermes, Claude Code, and generic adapters may connect but must clearly report that local execution is not yet supported. See `docs/MISSION_AGENT_PROTOCOL.md` for the protocol, threat model, recovery semantics, and rollback.

Completion requires a fresh production user to connect behind NAT, confirm pull readiness, register a safe local repository, launch the starter analysis mission, observe live progress, receive a genuine Markdown artifact, restart without duplicate work, revoke access, and reconnect. The hackathon evidence package begins only after this acceptance succeeds.

### Repository Change Missions — approved 2026-07-20

**Goal:** Turn the proven read-only repository analysis into an approval-gated implementation workflow without expanding Mission Control's permanent authority.

**Boundary:** A user selects Change Repository, supplies an editable objective, acceptance criteria, and optional allowlisted validation commands. Codex first creates a read-only implementation plan. Mission Control then requires an explicit `repository.modify` approval before the local Mission Agent creates an isolated `mission/*` branch and Git worktree. Codex may modify only that worktree. The runtime gathers validation output and diff evidence, creates one local commit, and stops at human review.

**Permanent prohibitions:** No automatic push, pull request, merge, deployment, infrastructure or secret modification, transaction signing, or transaction submission. The registered source branch and worktree must remain unchanged.

**Canonical truth:** Existing mission, task, execution, approval, progress, artifact, and completion events remain authoritative. Worktree paths, lease tokens, and restart checkpoints are bounded operational state and cannot independently authorize or complete work.

**Acceptance:** Demonstrate the plan before approval, prove no write occurs before approval, approve the exact repository/base/objective action, produce an isolated local branch and commit, show changed files/full diff/validation evidence, preserve the original branch, and recover safely from a restarted Mission Agent.

## Mission Control 0.4 — Engineering Manager

**Controlling outcome:** Make Mission Control the best place to supervise AI software engineers.

**Approved first slice — 2026-07-20:** Recommendations are canonical, persistent, evidence-linked entities with Open, Accepted, In Progress, Completed, Stale, and Dismissed lifecycle states. Repository Analysis emits structured recommendations, repository and mission views expose them, and one action creates an idempotently linked, approval-gated Repository Change Mission inheriting objective, evidence, acceptance criteria, and allowlisted validation suggestions.

**Sequence after the first slice:** Expand versioned engineering Mission Templates, add a review-before-execution Mission Planner, project an evidence-backed Mission Graph, and deepen Repository Health.

**Architecture direction:** Build Repository Knowledge rather than private Agent Memory. Repository architecture, tooling, standards, decisions, known issues, mission history, and recommendations remain durable platform knowledge that interchangeable agents consume. Every visible recommendation, graph relationship, and health claim must cite canonical evidence and rebuild from the event log and durable artifacts.

**Authority boundary:** Version 0.4 does not weaken existing approval separation. File modification, branch push, and pull-request creation remain distinct actions; merge, deployment, infrastructure/secret modification, and transaction signing/submission remain prohibited unless separately authorized in a later phase.

**First-slice acceptance:** Recommendation projections must rebuild from canonical events; source mission, execution, artifact, and evidence remain traceable; generated validation commands pass a strict allowlist; retries cannot create duplicate missions; terminal lifecycle states cannot reopen; existing Mission Agent installations remain compatible; and no recommendation can independently authorize repository modification.

## Mission Control 0.5 — Repository Intelligence (proposed)

**Controlling outcome:** Make the repository—not an individual agent—the durable, explainable system of record for what happened, why it happened, and what should happen next. This roadmap entry is product direction, not implementation authorization.

**Priority 1 — Repository Health:** Promote Repository Health into the primary daily dashboard. A versioned deterministic scoring projection may summarize test posture, architecture, security, technical debt, documentation, dependency freshness, CI, mission outcomes, and recommendation lifecycle. Every score and subscore must expose its calculation version, freshness, confidence, contributing observations, and evidence. Unknown data lowers confidence or remains unknown; it must not silently become a failing score.

**Priority 2 — Repository Timeline:** Project repository activity as mission history rather than Git history: analyses, recommendations, accepted work, change missions, validations, approvals, commits, publication, deployments, incidents, and audits. Timeline relationships must come from canonical causation, provenance, and explicit mission links. Git commits may be evidence, but are not the timeline's source of truth.

**Priority 3 — Repository Knowledge:** Create evidence-backed pages for major components such as Authentication. Knowledge connects architecture, files, tests, risks, recommendations, decisions, ownership observations, and related missions. Model-generated summaries remain attributed observations; accepted human decisions and verified execution outcomes remain distinguishable facts.

**Priority 4 — Health trends:** Record immutable, versioned health assessments so users can compare like-for-like scores over time and see which completed recommendations changed which dimensions. A completed mission does not automatically improve health: new repository evidence and the scoring rules must justify the change.

**Priority 5 — Action templates:** Offer versioned mission templates at actionable findings so common work can begin with evidence, objective, acceptance criteria, and validation already linked. Template selection cannot bypass planning, policy, or approval boundaries.

**Semantic layer direction:** Queries such as “Why is authentication designed this way?”, “Which recommendations have been ignored for 90 days?”, and “Which components generate the most technical debt?” should traverse evidence-backed repository relationships. Semantic retrieval may locate relevant records and draft an answer, but citations must resolve to canonical events, artifacts, recommendations, decisions, and outcomes. Generated prose is never an independent source of truth.

**First implementation gate:** Before coding, approve the health dimensions and weights; missing-data behavior; observation and assessment schemas; timeline relationship vocabulary; component identity and rename rules; freshness/staleness behavior; model-versus-deterministic responsibilities; migrations; backfill; rebuild tests; compatibility; rollback; production acceptance; and the smallest demonstrable vertical slice.

**Recommended smallest slice:** One repository receives a versioned explainable health assessment after analysis, a mission-and-recommendation timeline, and a before/after trend only after an evidence-producing follow-up analysis. Repository Knowledge and natural-language semantic queries should follow after those foundations are proven.

**Authority boundary:** Repository Intelligence is read, projection, and planning capability. It grants no autonomous push, pull-request, merge, deployment, infrastructure or secret modification, transaction signing, or transaction submission authority.

## Cross-phase test matrix

- Unit: transitions, dependency resolution, policy, health, retry classification, schemas, serialization.
- Integration: append/projection, command idempotency, dispatch/outbox, callback auth/replay, approvals, rebuild.
- End to end: success, retry, heartbeat timeout, approve, deny, reassign, DeFi stop boundary, scheduled monitoring run.
- Operational: web/worker termination, expired lease, dead letter/recovery, migration rollback, backup/restore, projection shadow rebuild.
- Experience: golden demo at target viewport, accessibility, refresh at each phase, truth-label/provenance checks.

Tests use controllable clocks and deterministic adapters; arbitrary sleeps are prohibited.

## Phase working method

Before each phase, present exact scope, files/systems, migrations, compatibility risks, and rollback. Implement the smallest complete vertical slice, run every relevant gate, report real/mocked/incomplete/deferred behavior, make one reviewable phase commit only when requested, and stop for approval. Architectural changes update the source-of-truth documents in the same phase.
