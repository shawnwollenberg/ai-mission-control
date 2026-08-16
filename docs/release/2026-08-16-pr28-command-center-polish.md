# R-2026-08-16 — PR #28 command-center presentation release

**Classification:** Routine governed application release

**Human owner approval:** `APPROVED`

**Approval date:** `2026-08-16`

The human owner explicitly authorizes the exact release scope in this record:
creation of the release record and release commit, push, protected PR and
normal CI, merge through branch protections, and production promotion of the
merged PR #28 web image through the existing SSM/Docker procedure. No
additional chat approval is required for routine actions within this exact
scope after this record is committed.

## Exact authorized release

This authorization covers only the already-merged PR #28:

- merged source commit `d5d9c63dcfec8868b5c891f752cfe835a3fe67e6`;
- source commit used to build the image `a185d0721a2be63eca721bc9e0b085cd5677c765`;
- the merged tree is identical to the `a185d07` image source tree;
- ECR image tag `a185d07`;
- immutable image digest
  `sha256:dc2d029df9680f0d40de541c82b1e8968641e0c515e3ee4e8e80a6cf2d9be76b`.

The exact committed diff is authoritative. Its descriptive scope is:

- humanized Mission Control home and mission launch language;
- a three-stage Intent → Scope → Review mission launch experience;
- repository-level Analyze, Change, and Consensus mission entry points;
- repository context carried into the selected launch flow;
- readable stale-agent, approval, recommendation, and recent-mission home states;
- clearer Consensus planning roles and approval-bound review language;
- mission-console stages, human-readable evidence, and decision-focused approval UI;
- recommendation review before creating a Change Mission, including editable
  objective, acceptance criteria, and validation instructions;
- the corresponding existing authenticated recommendation Change Mission route
  accepting those reviewed human inputs while preserving its existing
  workspace identity, mutation-origin, stable command identity, source
  recommendation, and canonical launch-command path;
- onboarding labels that distinguish runnable providers from connect-only
  adapters;
- repository layout and mission-action presentation improvements;
- associated presentation tests and production-workspace-mode tests.

Changed paths in the authoritative PR #28 diff are:

```text
app/api/recommendations/[recommendationId]/change-mission/route.ts
app/first-mission-form.tsx
app/globals.css
app/missions/[missionId]/consensus-plan-console.tsx
app/missions/[missionId]/durable-mission-console.tsx
app/onboarding/wizard.tsx
app/page.tsx
app/recommendations/[recommendationId]/page.tsx
app/recommendations/[recommendationId]/recommendation-actions.tsx
app/repositories/[repositoryId]/page.tsx
app/repositories/page.tsx
tests/onboarding-connection.test.mjs
tests/production-workspace-mode.test.mjs
```

## Explicitly not authorized

This release does not authorize changes to:

- authentication, authorization, session validation, workspace or tenant isolation;
- repository authority, execution authority, Mission Agent authority, or capability-attestation semantics;
- leases, fencing, provider/model routing, agent protocol/runtime behavior, or signing;
- policy enforcement, approval semantics, destructive mutation behavior, or canonical event/projection authority;
- Consensus Plan runtime semantics or worker behavior;
- database schema, migrations, PostgreSQL, S3, Project Brain, Caddy, or other infrastructure;
- the deployment mechanism, IAM, Secrets Manager, networks, runtime versions, or CloudFormation;
- unrelated Runtime-v6 hardening, Mission Agent publication, or unrelated product features.

Only the web container may be promoted. Generic worker, action worker,
PostgreSQL, Caddy, Project Brain, and the historical unrouted canary must
remain unchanged.

## Pre-release reconciliation

Before release, the complete PR #28 diff was inspected. It is bounded to the
paths listed above. The recommendation route change is presentation-driven
input handling, not a new authority path: it retains authenticated workspace
identity, mutation-origin protection, stable recommendation-derived command
identity, source recommendation binding, and the existing
`launchFirstRepositoryMission` command layer.

The local worktree was clean at `origin/main` before this record was created.
The existing stale Codex stashes and temporary/evidence files are excluded.
No authentication, authorization, policy, execution-authority, worker,
database, migration, or deployment-infrastructure file is part of this
release. No raw secret is included in this record or the image reference.

## Acceptance criteria

1. PR #28 remains merged at the exact source and image identities recorded above.
2. Mission launch presents Intent, Scope, and Review with clear repository,
   objective, acceptance, validation, and approval-boundary language.
3. Repository cards and detail pages expose the correct Analyze, Change, and
   Consensus entry points without changing the underlying command authority.
4. Stale agents remain visible as reconnecting; approvals, recommendations,
   and recent missions remain visible as actionable context.
5. Consensus review and mission consoles present stages, evidence, and
   human approval as the primary decision surface.
6. Recommendation-created Change Missions preserve authentication, workspace
   scope, idempotency, source recommendation binding, and the existing command
   layer.
7. Production health/readiness remain green, protected routes remain protected,
   and only the web image changes.
8. No unresolved HIGH or MEDIUM release finding remains.

## Validation evidence

- PR #28 protected `validate` CI passed before merge.
- The image was built for ARM64 and pushed to ECR at the immutable digest above.
- `origin/main` was reconciled to merged SHA `d5d9c63`.
- The merged tree SHA equals the `a185d07` image source tree SHA.
- Before promotion, production `/api/health` returned `status: ok` with a
  reachable database and `/api/readiness` returned `status: ready` with no
  failed checks.
- Before promotion, SSM reported the target instance online and the current
  web container on the prior `d6af3dd` digest with zero restarts; workers,
  PostgreSQL, Caddy, and Project Brain were running with zero restarts.
- Normal repository CI remains required for this authorization-record commit.

## Rollout

Use the documented post-bootstrap SSM/Docker application-promotion procedure
on `i-0f9f584fddf6be617` in `us-east-1`:

1. Record the current web digest and green public health/readiness baseline.
2. Pull the exact ECR digest recorded above.
3. Rename the current `mission-control-web` container to
   `mission-control-web-pre-a185d07` and stop it for rollback retention.
4. Start only the new `mission-control-web` from the exact digest with the
   existing `/opt/mission-control/production.env`, `mission-control` Docker
   network, `unless-stopped` restart policy, and
   `PROJECT_BRAIN_EXECUTION_MODE=remote` setting.
5. Verify the running container image digest and zero restart count.
6. Verify public health/readiness, login and protected-route behavior, the
   read-only mission-summary route, and bounded non-destructive UI behavior.

No database migration, worker drain, worker restart, infrastructure update,
secret retrieval, or destructive mission/repository mutation is authorized.

## Rollback

If the new web container fails to start, health/readiness fails, or bounded
verification fails, stop and retain the new container, restore the old name
from `mission-control-web-pre-a185d07`, start it, and verify both public
health/readiness endpoints and protected-route behavior. Do not replace
workers, PostgreSQL, Caddy, or Project Brain. Do not run destructive database
rollback or delete retained evidence.

## Release decision

**APPROVED for the exact merged PR #28 web-only scope above.** Any additional
source, runtime, infrastructure, data, authority, or product change requires
a separate release record and human approval.
