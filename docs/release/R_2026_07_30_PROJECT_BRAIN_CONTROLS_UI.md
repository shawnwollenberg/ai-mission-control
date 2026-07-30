# R_2026_07_30_PROJECT_BRAIN_CONTROLS_UI

**Status:** Human approved for commit, push, merge, and deployment  
**Classification:** Routine governed application release  
**Production base:** `a4ea9abec3248224e2be60e2057df1f45e55bdb0`  
**Human approval:** Granted by Shawn Wollenberg on 2026-07-30 after review of the two-file product diff

## Problem and intended behavior

The Project Brain controls below a mission are rendered as unrelated forms against the left edge of the page. The six
buttons have no visual hierarchy, shared container, responsive layout, or explanation of their relationship.

The controls must align with the mission console, separate setup/context operations from mission-lifecycle operations,
use consistent action sizing, identify the read-only preview, and collapse cleanly on narrow screens.

## Scope and non-goals

Scope is limited to presentation markup in `app/missions/[missionId]/page.tsx`, presentation rules in
`app/globals.css`, and this governed release evidence. Existing server actions, operation values, approval checks,
idempotency, event recording, Project Brain projections, repository permissions, and worker behavior remain unchanged.

This release does not change Project Brain authority or state, Mission Agent, repository management, command policy,
authentication, workspace isolation, credentials, signing, KMS, database schema, migrations, workers, or
infrastructure.

## Acceptance and validation

- The control area uses the same centered maximum width as the mission console.
- Setup/context and lifecycle operations are visibly and accessibly grouped.
- Every existing form action and operation value is preserved.
- The read-only preview is visually secondary.
- The layout becomes one column at the existing mobile breakpoint.
- Formatting, lint, typecheck, production build, focused Project Brain tests, complete required suites, and
  `git diff --check` pass under Node 22.20.0 and npm 10.9.3.
- A rendered mission page is inspected at desktop and narrow widths.

## Rollout and rollback

Build one immutable ARM64 web image from the reviewed merge SHA. Replace only `mission-control-web`; do not restart or
replace Mission Agent, generic/action/Project Brain workers, PostgreSQL, or Caddy. Verify health, readiness, deployed
image identity, zero pending migrations, rendered control labels, unchanged Project Brain behavior, and secret-free
logs.

Rollback recreates only `mission-control-web` from the immediately preceding immutable image. Do not delete or rewrite
missions, repositories, Project Brain operations or artifacts, events, approvals, commands, receipts, or audit records.

## Evidence

- Reviewed product diff: `app/missions/[missionId]/page.tsx`, `app/globals.css`.
- Documentation: `PLANS.md`, this release record.
- Node: `v22.20.0`.
- npm: `10.9.3`.
- Formatting, lint, typecheck, production build, and `git diff --check`: passed.
- Focused Project Brain unit tests: `36/36` passed.
- Complete unit suite: `166/166` passed. The first container-only run mounted the worktree at `/app` without its
  linked Git metadata and produced one expected harness failure; the authoritative rerun mounted the worktree and Git
  metadata at their real paths and passed without changing the test.
- Complete integration suite: `73/73` passed against PostgreSQL 16.4.
- Complete E2E suite: `2/2` passed.
- Migration validation: migrations `0001` through `0028` applied in the disposable database; zero pending.
- Authenticated production-build render: the mission page emitted the two group headings and all six preserved action
  labels. Responsive behavior is supplied by the existing `820px` breakpoint and the reviewed one-column rule.
- Mission Agent 0.7.2, Project Brain worker inputs, operation handlers, approval logic, event logic, database schema,
  and migrations are unchanged.
- Deployment evidence: pending the governed merge and web-only rollout.
