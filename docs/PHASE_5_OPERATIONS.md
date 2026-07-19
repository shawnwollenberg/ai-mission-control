# Phase 5 Templates, Scheduling, and Daily Operations

**Status:** Approved implementation architecture  
**Baseline:** `0bf8757`  
**Date:** 2026-07-19

## Authority boundary

Phase 5 adds convenient ways to request existing work. It grants no new execution authority. Template launch and schedule firing authenticate a workspace actor, validate registered resources, append canonical events, and invoke the existing mission/task command handlers. Agent eligibility, resource permission, policy evaluation, remote authentication, publication approvals, and permanent denials remain unchanged. Merge, deployment, remediation, infrastructure modification, secret access, transaction signing/submission, asset movement, and DeFi position modification remain prohibited.

## Template contract

A template has a durable ID and monotonically increasing versions. Each version records status (`draft`, `published`, `deprecated`), domain, JSON input schema, task definitions, dependency edges, capabilities, resource input bindings, selection rules, approval/risk/timeout/budget defaults, artifact expectations, and lifecycle timestamps. Publishing freezes the version. Editing published content creates a new draft version; published rows are rejected by database and command-layer mutation checks.

Launch accepts only schema-declared values. Repository and resource inputs are durable registered IDs; paths, credentials, workspace IDs, policy definitions, and arbitrary shell commands are not input types. Launch records the exact template/version, resolved safe inputs, resolved task graph, and resolved defaults on the mission and task events. Later template changes cannot affect an existing mission.

Initial published templates are Software Change, Operational Health Report, DeFi Portfolio Review, Research and Writing, and Mixed Analysis and Implementation. The DeFi template contains no execution task and requires the exact statement `Analysis only.  No transaction was signed or submitted.`

## Schedule contract

Schedules reference one published template version plus validated inputs. The explicit rule supports `once`, `hourly`, `every_n_hours`, `daily`, `weekly`, and safely parsed five-field cron. Time zones use IANA identifiers. The initial minimum interval is one hour. Each row records enabled state, start/end bounds, next/last intended run, last result, concurrency (`skip_if_running`, `queue_next`, `allow_parallel`), missed-run policy (`skip`, `run_once_on_recovery`, `run_all_with_limit`), maximum active runs, creator, and lease state.

The scheduler claims due rows with `FOR UPDATE SKIP LOCKED`, a bounded lease, and graceful shutdown. The stable run ID and command keys derive from schedule ID, intended UTC occurrence, and template version. Multiple workers or restarted workers therefore create one schedule run and one mission. Every due, created, skipped, delayed, failed, enable/disable, and delete decision is canonical evidence. Backlog recovery is capped by `SCHEDULER_MAX_RECOVERY_RUNS` (default 10).

Defaults are `skip_if_running` for operational and DeFi reports, `queue_next` for code-writing schedules, `run_once_on_recovery` for daily health, and `skip` for high-frequency monitoring. Run-now creates a distinct intended occurrence and still uses the same idempotency boundary.

## Notifications

Notifications are workspace-scoped, idempotent projections from safe source events. Initial in-app notifications include approval requested, mission completion/failure, task failure, schedule run failure/skip, offline worker/agent, timeout, publication completion, and security attention. External channel preferences store credential references, never raw provider secrets. Delivery retries do not alter the source mission. Quiet hours are evaluated in the preference timezone; digest grouping uses event category and UTC digest window.

## Usage and cost

Usage records preserve reported model/runtime/tokens/duration/commands/storage/external API data. `exact`, `estimated`, and `unknown` cost confidence are distinct; absent evidence stays unknown. Rollups are projections by mission, template, schedule, agent, model, date, domain, and repository. Deterministic limits warn at 80%, require approval to raise a soft limit, and prevent new execution after a hard limit without interrupting an in-flight write.

## Read models and retention

The operations dashboard reads projections for active/attention missions, approvals, failures, agents, workers, jobs, schedules, usage, security, provider-confirmed PRs, and recent outcomes. Safe mission search covers projected metadata only; raw prompts, logs, and artifact bodies are excluded. Saved filters are workspace-scoped.

Domain events, approval/policy/security decisions, outcomes, and publication evidence are indefinite. Execution logs, heartbeats, delivery attempts, notification deliveries, worktrees, temporary artifacts, and completed jobs have configurable retention. Anything referenced by an open approval or unresolved failure is retained.

## Production topology and recovery

Start PostgreSQL, migrations, web, generic worker, scheduler, notification worker, remote-delivery worker, Hermes, Codex, then action worker. Use TLS, secure cookies, encrypted database/artifacts/backups, restricted database/worker networks, repository allowlists, secret-provider references and rotation, log redaction, rate limits, dependency scanning, isolated production configuration, and explicit owner provisioning.

PostgreSQL requires encrypted daily backups plus point-in-time recovery. Artifact storage requires versioned encrypted replication. Secret-provider recovery restores references and rotates credentials rather than exporting plaintext. After restore: stop workers, restore database/artifacts, migrate, rebuild projections, verify equality, start workers in order, and observe scheduler missed-run policy. Validate restore in staging with a recent backup; never overwrite production during a drill.

## Backup, restore, and first deployment runbook

PostgreSQL receives encrypted daily base backups with continuous WAL archiving and a documented recovery-point target. Retain an independently verified backup generation. Artifact storage uses versioning, encryption, and cross-failure-domain replication. Secret-provider recovery restores opaque references and rotates credentials; plaintext secrets are never exported into a database backup. GitHub recovery provisions a new least-privilege application credential and revalidates repository registrations.

Restore into isolated staging in this order: PostgreSQL, artifact metadata and objects, secret-provider references, migrations, projection rebuild, projection verification, `phase5:restore:validate`, then workers in the documented startup order. Keep the scheduler stopped until next-run state is inspected. Acceptance requires current migrations, zero projection discrepancies, resolvable artifact references, coherent schedule times, no duplicate run keys, and healthy workers.

The first production deployment remains a Node 22 modular monolith: a TLS-terminated web process plus independently scalable generic, Codex, action, remote-delivery, Hermes, scheduler, and notification workers backed by PostgreSQL 16 and durable artifact storage. Configuration includes database, session/auth, public origin, artifact provider, registered repositories, secret-provider references, GitHub application credentials, worker heartbeat identity, and channel destination references. Use secure cookies, private database networking, encrypted volumes/backups, redacted structured logs, repository allowlists, and provider monitoring.

Deploy migrations before application processes, then start web, generic worker, scheduler, notification worker, remote delivery, Hermes, Codex, and action worker. Readiness is calculated from database/runtime/provider facts. Rollback stops workers first and restores the prior compatible image; migrations are repaired forward after their compatibility window rather than destructively reversed. Canonical events and idempotency records must remain intact.

Retention cleanup is bounded, restart-safe, and audited in `retention_runs`. It may remove old completed jobs and successful delivery attempts. Canonical events, outcomes, approvals, policy/security evidence, schedule-run results, usage records, open failures, open-approval evidence, and open-PR artifacts remain protected.
