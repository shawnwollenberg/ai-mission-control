# Mission Control UI Release Authorization — 2026-08-15

**Classification:** Routine governed application release

**Status:** Human-authorized; release validation and protected release execution in progress

**Human owner approval:** `APPROVED`

**Approval date:** 2026-08-15

## Authorization

The human owner explicitly authorizes the exact Mission Control UI release scope
described below as of 2026-08-15. The exact committed diff is authoritative over
this descriptive summary. This record is the durable repository authorization for
this release and does not authorize unrelated work.

The owner authorizes creation of the release commit, push of the release branch,
protected pull-request creation or update, normal CI execution, remediation of
CI failures caused only by this scope, merge through normal branch protections
after required checks pass, deployment through the existing documented Mission
Control production procedure, and routine rollback through the existing tested
rollback procedure if deployment verification fails.

## Exact authorized scope

- Live multi-mission switcher.
- Active mission count.
- Attention count.
- Approval, blocked, and failed indicators.
- Recent mission outcomes.
- Eight-second mission-summary polling.
- Read-only `/api/navigation/mission-summary`.
- Three-stage New Mission flow: Intent, Scope, and Review.
- Consensus execution settings moved into the advanced Review section.
- Consistent application navigation and active navigation states.
- Mission breadcrumbs.
- Mission health cards.
- Approval controls.
- Clearer repository layouts.
- Clearer agent layouts.
- General UI consistency and Mission Control polish represented by the current
  validated local diff.

Representative implementation files include:

- `app/app-navigation.tsx`
- `app/api/navigation/mission-summary/route.ts`
- `app/first-mission-form.tsx`

The current validated local diff also includes the presentation-only companion
changes in the Agents, Approvals, Missions, Repositories, mission-console, and
shared-style files. No file outside this UI release is authorized.

## Explicit exclusions

This release does not authorize changes to:

- authentication or authorization;
- repository, execution, or Mission Agent authority;
- capability-attestation semantics;
- leases or fencing;
- provider/model routing;
- Consensus Plan runtime semantics;
- production infrastructure architecture;
- database schema beyond what is already required by the exact UI diff;
- deployment mechanism;
- unrelated Runtime-v6 hardening;
- unrelated product features.

The new mission-summary route is read-only and derives display data from
workspace-scoped canonical projections. The staged launch flow preserves the
existing command endpoints, idempotency key, policy boundaries, approvals, and
mission admission behavior.

## Pre-commit reconciliation

The pre-commit working tree was inspected before authorization recording:

- Base: `main` at `4256ff3`, matching `origin/main`.
- Authorized application changes: the existing UI diff plus the new
  `app/api/navigation/mission-summary/route.ts` route.
- Existing stale Codex work remains in stash entries and is excluded.
- No temporary, local evidence, generated build, or secret files are included.
- No authentication, authorization, policy, execution-authority,
  deployment-infrastructure, migration, or Mission Agent behavior changes were
  found in the current diff.

## Acceptance criteria

1. Navigation makes New Mission, Missions, Repositories, Agents, and Approvals
   primary; secondary operational pages remain available under More.
2. The mission switcher exposes active missions, attention counts, pending
   approvals, blocked/failed signals, and recent outcomes without mutating
   canonical state.
3. Mission summaries are workspace-scoped, read-only, and refreshed every eight
   seconds in the navigation client.
4. New Mission proceeds through Intent → Scope → Review, with consensus-only
   execution settings available in Review and existing launch boundaries intact.
5. Mission, repository, agent, and approval pages use consistent hierarchy,
   alignment, labels, focus states, and obvious action buttons.
6. No unresolved HIGH or MEDIUM release finding remains.
7. TypeScript, lint, full unit suite, production build, diff checks, protected
   CI, production health/readiness, and bounded UI smoke checks pass.

## Validation record

Pre-release local validation completed before release execution:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` — 210/210 passed.
- `npm run build` — passed.
- `npm run test:e2e` — 2/2 passed locally after preserving the default analysis
  objective in the staged Intent screen.
- `git diff --check` — passed.

The repository’s normal protected CI remains required after push. Secret
scanning, format check, integration tests, E2E tests, and final diff review are
required before merge.

## Rollout and rollback

Deploy only the exact merged application SHA through the existing digest-pinned
Mission Control production procedure. This is a web/UI release; preserve
workers, PostgreSQL, Caddy, Project Brain, agents, repositories, missions, and
canonical evidence. Verify the exact deployed image digest and public health and
readiness endpoints before accepting traffic.

Rollback is application-only through the existing tested procedure: restore the
immediately preceding known-good web image/digest, preserve canonical events,
projections, approvals, missions, repositories, and agent records, and do not
run destructive database rollback files.

## Required production verification

- Public health and readiness remain green.
- Authentication works and protected routes remain protected.
- Navigation renders with active states.
- The mission switcher loads current summaries and attention indicators.
- Intent → Scope → Review works without creating test mutations.
- Consensus settings remain available in Review.
- Repository and agent layouts render correctly.
- No unexpected API errors or restart loop occurs.
- No migration mismatch occurs.

## Release decision

`APPROVED` by the human owner for the exact scope above on 2026-08-15.

No additional chat approval is required for routine actions within this exact
scope once this record is committed. Any scope mismatch, authority change,
production-state mismatch, destructive action outside the established rollback
procedure, or human authentication requirement remains a stop condition.
