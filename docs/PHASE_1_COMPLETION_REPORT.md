# Phase 1 Completion Report

**Status:** Complete — 2026-07-18

Phase 1 delivers a PostgreSQL-authoritative, authenticated, event-derived simulated mission vertical slice. It intentionally stops before Codex, Hermes, webhook, heartbeat, DeFi, or other external execution adapters.

## Durable behavior

- Missions use authoritative `draft`, `planned`, `running`, `paused`, `completed`, `failed`, and `cancelled` states.
- Tasks use authoritative `pending`, `blocked`, `ready`, `assigned`, `running`, `waiting_for_approval`, `paused`, `verifying`, `completed`, `failed`, and `cancelled` states.
- Task creation, dependency edges, readiness, assignment, progress, approvals, verification, outcomes, retries, and cancellation are canonical events with optimistic concurrency and command idempotency.
- Dependencies reject self, cycle, cross-mission, and foreign-workspace links. Duplicate links are idempotent.
- Failed-dependency policy: an unrecoverable required task fails the mission; downstream tasks remain visibly blocked and never silently start. Cancelled dependencies likewise remain unmet.
- Mission start requires a task plan. Pause prevents worker starts. Resume reevaluates eligibility. Cancellation records cancellation events for all nonterminal tasks. Only the coordinator can complete a mission after every required task completes.

## Simulated execution and approvals

`npm run worker` starts a separate internal worker. Ready-task outbox messages enqueue leased `simulate_task` jobs. Claims use `FOR UPDATE SKIP LOCKED`; leases recover stale workers; command and job idempotency make repeat delivery safe. Each job assigns `simulated`, starts, reports deterministic progress, enters verification, and completes—or stops at a configured approval boundary. The Next.js process owns no durable timers.

Approval requests, grants, and denials are events and projections. The worker leaves a task in `waiting_for_approval`; an authenticated decision records the approval event, then resumes and finishes the task on grant or fails it and coordinates mission failure on denial.

Send `SIGTERM` or `SIGINT` for graceful shutdown. The worker stops claiming, finishes the active database operation, and exits after releasing its pool. Restarting it resumes pending or stale-leased jobs.

## Replay and verification

`npm run projections:rebuild` takes a PostgreSQL advisory transaction lock, deletes and replays only inside one transaction, validates event schema versions, and commits the rebuilt projection set atomically. MVCC keeps normal readers on the prior committed projections until promotion; a failure rolls the complete rebuild back, so partial state is never visible. Workspace and projection flags are accepted. Because mission summaries depend on tasks and foreign keys connect these models, a selected projection rebuild expands to the required projection closure.

`npm run projections:verify` snapshots live rows, rebuilds in a rollback-only transaction, and reports per-table hashes, counts, and discrepancies without correcting drift. A deliberate historical JSON-shape drift was detected during acceptance; rebuild corrected it and the next verification returned equality.

## DynamoDB compatibility

`npm run legacy:import-dynamodb` is a one-way adapter with fixture and live-reader modes, dry-run support, explicit v1 mappings, stable IDs for unsafe legacy identifiers, source metadata, quarantine for unsupported records, and command-level idempotency. It never overwrites a PostgreSQL aggregate containing newer non-imported events. Acceptance imported the captured fixture once, repeated it with zero new events, and rendered the resulting mission through current projections.

Legacy JSONL/DynamoDB modules and agent fixture routes remain only for compatibility evidence. They can be deleted after the agreed legacy-link retention window and an approved infrastructure migration; no production browser navigation reads them.

## Browser and debrief

The authenticated mission page shows the durable ordered dependency plan, task state, executor, attempts, progress, blockers, approvals, execution counts, canonical timeline, and a deterministic terminal debrief. It polls safe projection/timeline APIs and does not calculate readiness or outcomes. `Simulated execution` remains prominent.

The durable debrief is derived from mission/task/approval projections and event count. Artifact count is zero until a future approved artifact-store/UI slice records artifacts; no invented artifact is displayed.

## Acceptance evidence

- Node `v22.20.0`.
- Format, ESLint, TypeScript, 10 unit tests, 19 PostgreSQL integration tests, production build, and the upgraded browser E2E passed.
- Browser E2E created the seven-task ServicePilot plan, exercised fan-out/fan-in dependencies, restarted the web process, restarted the worker, stopped at approval, granted it, completed all seven tasks, logged out/in, and recovered the same outcome.
- Projection rebuild replayed 95 ordered events; post-rebuild verification reported equality.
- DynamoDB fixture dry-run reported three supported events and no writes; actual import added three events; repeat import added zero.

## Migrations and rollback

- `0007_phase1_execution.sql` adds execution summary fields, task attempt/progress positions, approval evidence, simulation job types, rebuild-run records, and legacy quarantine.
- `0008_job_claim_metadata.sql` adds required job priority and claim timestamps.

Both migrations are forward-only. Rollback is an application rollback that preserves the additive columns/tables, followed by a compatible forward migration if schema removal is ever approved; canonical events are never deleted as rollback behavior.

## Deferred by the Phase 1 boundary

- Real Codex/Hermes execution and callbacks
- Heartbeats and external delivery protocols
- Phase 3 policy engine and multi-user OIDC
- DeFi or financial execution
- S3 artifact content and artifact download UI
- External webhooks
