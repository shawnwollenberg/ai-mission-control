# R-2026-08-29 — V2 dashboard readability and automatic refresh

**Classification:** Routine governed application release

**Human authorization:** Approved by the owner on 2026-08-29 after Mission Control V2 Issues #36 and #37, with the
explicit instruction: “Once you complete the 2nd mission please commit, push and deploy.”

## Exact scope

- Give every V2 Mission card an explicit accessible light-surface foreground and link color while preserving the
  existing state-color indicator and responsive layout.
- Refresh `/v2` every 10 seconds while visible, pause polling while hidden, refresh immediately on visibility return,
  clean up scheduling on unmount, and display a subtle accessible freshness message.
- Make the dashboard read path reconstruct presentation directly from GitHub Issue data with label enforcement
  disabled so initial loads and automatic refreshes cannot repair labels or perform another GitHub mutation.
- Add focused contrast, rendered-card, scheduler lifecycle, dashboard integration, and fail-on-mutation regression
  coverage. Update the V2 vertical-slice documentation.

This release does not change authentication, authorization, provider or worker authority, routing transitions,
canonical GitHub reconciliation semantics, credentials, migrations, infrastructure, V1 behavior, or production data.
It does not include the temporary Architect evidence-guard experiment rejected during Issue #37 review.

## Acceptance criteria

1. Completed and active V2 cards render readable text and links with a minimum tested 4.5:1 contrast ratio.
2. Mission, actor, CTO Inbox, and local-worker presentation refresh without a manual browser reload within 10 seconds
   while the page remains visible.
3. Hidden pages do not retain the refresh timer; returning to visibility refreshes once and safely resumes scheduling.
4. Dashboard reads never invoke `addComment`, `updateIssue`, label repair, or another canonical mutation, including
   when stored labels differ from derived state.
5. V2 tests, TypeScript, lint, formatting/diff checks, production build, and dependency audit pass.
6. V1 health and readiness remain green after deployment; `/v2` remains authenticated and worker endpoints continue
   rejecting unauthorized calls.

## Rollout

Build and publish one immutable ARM64 image from the exact release commit. Back up PostgreSQL and retain the currently
running web container as the rollback point. Replace only the web container using the existing production environment,
V2 configuration, runtime volume, network, and digest-pinned procedure. No migration is required. Verify public V1
health/readiness, authenticated-route protection, worker rejection, current migration count, local-worker presence,
and the deployed image digest.

## Rollback

Stop and retain the new web container, restore the immediately preceding digest-pinned web container, and verify V1
health/readiness. No database rollback is required because this release has no schema or data mutation. GitHub Mission
Issues and the local worker binding file remain intact.

## Risks and controls

- Ten-second visible-page refresh adds bounded GitHub reads. Visibility pausing limits idle traffic.
- `router.refresh()` rerenders server data but does not itself mutate; instrumented tests fail if the dashboard read
  path reaches either GitHub mutation method.
- Accessible colors are centralized and rendering-level tests prove the card component consumes them.
- Deployment changes only the web image and preserves the known-good prior container for immediate rollback.
