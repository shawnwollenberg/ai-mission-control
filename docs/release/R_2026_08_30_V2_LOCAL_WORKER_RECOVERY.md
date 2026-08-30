# R-2026-08-30 — V2 local worker bounded recovery

## Classification and human authorization

This is a security-sensitive application/provider-runtime remediation because it changes provider-thread recovery
and local worker lifecycle behavior. On 2026-08-30, the product owner explicitly directed Codex to implement this fix
outside Mission Control, selected a 15- or 30-second GitHub-safe polling interval, and retained the prior instruction
to commit, push, and deploy after the second Mission Control mission. This release selects 30 seconds. Codex does not
approve the release.

## Exact scope

- Poll the hosted coordination boundary every 30 seconds, including after completed work, and refresh the visible V2
  dashboard every 30 seconds.
- Keep the worker alive across transient hosted/network failures with exponential backoff capped at five minutes.
- Record worker presence before external GitHub synchronization so a GitHub failure cannot misreport a live worker
  as offline.
- During longer coordination backoff, send a lightweight 30-second worker heartbeat that does not invoke GitHub.
- Preserve the exact provider failure code through the worker health endpoint and show failed dispatch truth on the
  dashboard.
- On definitive `PROVIDER_THREAD_UNAVAILABLE`, requeue the same idempotent dispatch and clear only that actor's stale
  thread binding for one fresh-thread attempt.
- Make recovery a separate failed-to-queued ledger transition. Enqueue remains idempotent and cannot silently conceal
  a failed dispatch. A read-only Architect failure caused by an unavailable thread, invalid output, or failed provider
  process may receive one replacement from canonical Mission context. Engineer replacement remains limited to
  definitive thread unavailability.
- If that fresh attempt also reports an unavailable thread, stop automatic recovery as
  `PROVIDER_RECOVERY_EXHAUSTED` and require operator reconciliation.
- Never recover an indeterminate dispatch, a completed dispatch whose result is awaiting GitHub reconciliation, an
  authentication/usage failure, a changed Mission envelope, or a GitHub failure through the provider path.
- Project work liveness from the exact current-revision dispatch rather than from the canonical actor label: active,
  queued, failed, and worker-offline are distinct rendered states, and an older failed revision cannot poison the
  current Mission card.
- Reclassify only the three known legacy generic failures whose original local worker logs established
  `PROVIDER_THREAD_UNAVAILABLE`, then allow the bounded mechanism to recover them.

## Non-goals and authority boundary

No new repository, permission, credential, provider, API billing, Responses adapter, command authority, GitHub write
class, database schema, infrastructure topology, V1 behavior, signing, wallet, financial, merge, or deployment
authority. Recovery cannot replay an indeterminate provider dispatch, bypass exact mission revision binding, or loop
after its single fresh-thread attempt.

## Acceptance

Focused tests must prove exact failure-code validation, idempotent requeue only for thread unavailability, terminal
behavior for recovery exhaustion, bounded read-only Architect replacement, fail-closed indeterminate outcomes,
offline truth, exact-revision dashboard status, and 30-second refresh scheduling. Full V2 tests, typecheck, lint,
formatting, production build, production dependency audit, and diff checks must pass. After rollout, health/readiness
must remain green, the local worker must remain online through more than one polling window, and the three known
missions must either progress canonically or expose an exact terminal failure without duplicate mission revisions.

## Rollout

Capture a database backup and current image digest, build and push an exact ARM64 digest-pinned image, replace only
the web container using the existing environment, network, and read-only configuration mount, and verify V1 and V2
health. Reclassify only the three identified dispatch records, then launch the existing local worker credential and
observe at least two polling windows plus canonical GitHub reconciliation.

## Rollback

Stop the local worker, restore the prior digest-pinned web container, and leave canonical GitHub Issues unchanged.
Restore the database backup only if the bounded dispatch-status remediation itself proves corrupt; otherwise preserve
dispatch audit evidence. The previous worker can remain stopped to prevent recurrence while the owner reviews state.

## Revision-4 development validation

The remediation keeps enqueue and recovery separate, centralizes the actor/failure recovery policy, extracts the
polling/backoff loop for deterministic testing, and validates the worker PID and bearer-token boundaries directly.
The dashboard now matches only the current Mission revision and actor when projecting dispatch liveness. These are
development changes only until the authorized rollout is separately executed; this record does not represent an
undeployed build as live.
