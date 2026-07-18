# Mission Control — Production Readiness Execution Plan

**Status:** Phase 1 complete; stopped at Phase 2 boundary — 2026-07-18

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

## Phase 4 — First real Codex integration

**Goal:** Complete one real, bounded repository change through an isolated Codex worker.

### Proposed scope

1. Deploy/register a Codex worker outside the web tier.
2. Create isolated branch/worktree execution with repository, path, tool, time, network, and resource constraints.
3. Report acceptance, heartbeat, progress, sanitized failure, tests, usage, and immutable artifact metadata.
4. Store diff/test/summary artifacts with checksum and provenance.
5. Require approval before merge or deployment; do not automatically merge.

### Acceptance criteria

- A user creates a small noncritical repository mission and a real Codex worker receives it.
- Progress and heartbeats are real and visible.
- Worker loss produces a recoverable timeout without duplicate repository effects.
- Tests and resulting commit/diff/PR metadata are attached and checksum-verifiable.
- Merge/deploy remains blocked until explicit policy-compliant approval.
- Full timeline rebuilds after all services restart.
- Replayed callbacks and jobs do not duplicate commits, artifacts, or actions.

### Stop report

Label every result live/controlled/fallback, document repository credential boundaries, and stop before adding another runtime.

## Phase 5 — Scheduling and operational workflows

**Goal:** Prove the core is domain-neutral through safe templates and scheduled mission instances.

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

## Cross-phase test matrix

- Unit: transitions, dependency resolution, policy, health, retry classification, schemas, serialization.
- Integration: append/projection, command idempotency, dispatch/outbox, callback auth/replay, approvals, rebuild.
- End to end: success, retry, heartbeat timeout, approve, deny, reassign, DeFi stop boundary, scheduled monitoring run.
- Operational: web/worker termination, expired lease, dead letter/recovery, migration rollback, backup/restore, projection shadow rebuild.
- Experience: golden demo at target viewport, accessibility, refresh at each phase, truth-label/provenance checks.

Tests use controllable clocks and deterministic adapters; arbitrary sleeps are prohibited.

## Phase working method

Before each phase, present exact scope, files/systems, migrations, compatibility risks, and rollback. Implement the smallest complete vertical slice, run every relevant gate, report real/mocked/incomplete/deferred behavior, make one reviewable phase commit only when requested, and stop for approval. Architectural changes update the source-of-truth documents in the same phase.
