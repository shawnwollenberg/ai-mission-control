# Phase 6 Operational Runbooks

These procedures preserve active work and authority boundaries. Never expose credentials in commands, tickets, or logs. Infrastructure modification, deployment, merge, secret access, signing, submission, and asset movement remain prohibited without separate authorization.

## Common incident sequence

1. Detect from the external monitor, Operations dashboard, heartbeat, dead-letter, or provider alert.
2. Stop new work at the narrowest safe boundary; preserve claimed work and artifacts.
3. Record timestamp, affected process, correlation IDs, symptoms, and owner action.
4. Diagnose configuration, dependency reachability, capacity, and the last safe deploy without printing secrets.
5. Recover through the provider's documented restart/restore path only when authorized.
6. Verify health, heartbeat freshness, idempotency, queue depth, and one bounded workflow.
7. Escalate on data loss risk, security exposure, unknown authority, repeated failure, or failed recovery.

## Process and dependency incidents

| Incident                     | Symptoms / detection                             | Immediate safe action                                                     | Recovery and verification                                                                                  |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Web offline                  | External check fails; workers may remain healthy | Pause user launches; do not stop workers blindly                          | Restart when authorized; verify TLS health, login/logout, session persistence, and dashboard               |
| Worker offline               | Stale heartbeat and rising queue age             | Stop assignments for that worker class                                    | Check configuration, dependency, disk/capacity; restart; verify one claim and no duplicate execution       |
| Scheduler offline            | Stale heartbeat; schedules overdue               | Disable schedules if duplicate risk exists                                | Restart; verify bounded missed-run handling and no duplicate schedule run                                  |
| Hermes offline               | Agent heartbeat stale; reports blocked           | Disable Hermes assignments; preserve queued work                          | Rotate/re-register only when authorized; verify heartbeat, explicit capabilities, and a read-only report   |
| Codex unavailable            | Readiness fails; worktrees or disk alarms        | Stop new Codex assignments                                                | Verify Node/Git/Codex, approved roots, disk, cancellation and upload; run one bounded task                 |
| Database unavailable         | Readiness fails; connection errors               | Pause new work; do not run migrations                                     | Verify provider status/network/pool; reconnect; confirm schema current, queues coherent, projections equal |
| Artifact storage unavailable | Upload/read failures                             | Stop artifact-producing assignments; retain recoverable local temp output | Verify endpoint/auth/capacity; retry idempotently; checksum downloaded artifact                            |
| Notification failure         | Delivery failures/dead letters                   | Keep in-app alerts; do not suppress safety events                         | Verify destination and rate limits; retry through durable job; confirm no duplicate delivery               |
| Dead-letter growth           | Count/rate alert                                 | Pause the failing job type                                                | Classify root cause; replay one item; verify idempotency before bounded batch retry                        |
| Git credential failure       | Read works but publication fails                 | Keep push/PR blocked; preserve local commit                               | Rotate scoped credential when authorized; verify read, then approval-gated push and separate PR            |

## Credential rotation

- Agent credential: disable the identity, issue a new scoped credential in the provider, update the service secret, restart only the affected process, verify the new heartbeat, then prove the old credential fails immediately.
- Owner session key: announce logout impact, generate and store a new high-entropy key through the secret provider, restart web when authorized, verify old sessions fail and new login/logout succeeds. Never log either key.

## Backup restore

Restore the selected database backup into an isolated non-production database. Apply migrations with the non-production procedure, rebuild and verify projections, validate artifacts by checksum, verify schedule next-run calculations and uniqueness, then reconnect isolated workers. Never restore over production as a test.

## Emergency procedures

- Disable schedules: use the durable owner control when available; otherwise stop only scheduler process under authorized provider access. Verify no new scheduled mission appears.
- Remote-agent revoke-all: invoke the durable owner credential revocation command, verify every old credential fails, and preserve audit evidence.
- Pause new executions: enable the durable workspace pause control when available. Existing work must remain observable and cancellable.

The workspace-wide durable pause, schedule-disable, Codex-stop, and publication-stop controls are not implemented yet; this is a launch blocker, not an operator workaround.
