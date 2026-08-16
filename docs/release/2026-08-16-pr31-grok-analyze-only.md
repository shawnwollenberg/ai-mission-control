# R-2026-08-16 — PR #31 Grok Analyze-only release

**Classification:** Security-sensitive application release

**Human owner approval:** `APPROVED`

**Approval date:** `2026-08-16`

The human owner explicitly authorizes the exact PR #31 release described in
this record. The authorization covers creation and merge of this release
record, normal CI, and production promotion of the exact approved web image
through the existing digest-pinned SSM/Docker procedure. No rebuild or image
substitution is authorized.

## Exact release identity

- Pull request: [#31](https://github.com/shawnwollenberg/ai-mission-control/pull/31)
- PR head: `172e171`
- Merged source: `75bb17d0580e7d1b34aa95e538da9dd91f645ac0`
- ECR image tag: `75bb17d`
- Approved target image digest: `sha256:0a3bc3699892161f64bddee885942b8f00442a4cc8f319dc544bd55faaface8b`
- Current predecessor web digest: `sha256:dc2d029df9680f0d40de541c82b1e8968641e0c515e3ee4e8e80a6cf2d9be76b`
- Predecessor rollback container: `mission-control-web-pre-a185d07`

The exact merged PR #31 diff is authoritative over this summary.

## Authorized scope

Only the already-implemented Grok Analyze-only functionality in PR #31 is
authorized:

- Grok Mission Agent adapter and Standard onboarding path;
- downloadable Mission Agent 0.7.3 runtime support;
- read-only Analyze mission admission and execution;
- the exact registration and runtime metadata needed for that path; and
- UI copy and presentation needed to expose and explain the Analyze-only agent.

Grok is not a Consensus provider. Consensus onboarding returns no Grok
profile, and Grok is not eligible for Planner A, Planner B, Synthesizer, or
Executor roles. No provider fallback or automatic model routing is introduced.
The Standard runtime identity is bound by adapter `grok`, Mission Agent
version `0.7.3`, and the exact artifact identity below; it is not a governed
Consensus model assignment.

## Analyze-only authority boundary

Grok may inspect registered repository content and return analysis,
recommendations, and evidence artifacts. It must not receive repository
mutation, implementation worktree, child implementation, commit, branch,
push, pull request, merge, publication, deployment, infrastructure, arbitrary
shell, unrestricted repository filesystem write, or credential authority.

The reviewed implementation enforces the boundary by rejecting Grok
non-analysis admission before canonical mission creation, rejecting
repository-change execution unless the adapter is Codex, invoking Grok with a
read-only sandbox and read-only tools, and checking repository status and HEAD
before and after analysis. Lease renewal, heartbeat, cancellation, and signed
protocol callbacks remain limited to the existing Analyze execution lifecycle.

Existing Claude Mission Agent 0.8, Codex Mission Agent 0.8, Standard Mission
Agent 0.7.2, Consensus Plan semantics, production implementation authority,
and Project Brain authority remain unchanged.

## Explicitly not authorized

This release does not authorize changes to authentication, authorization,
tenant isolation, repository authority, execution authority beyond the exact
Analyze-only path, capability-attestation semantics beyond the exact
registration required for that path, lease/fencing semantics, provider/model
routing, Consensus Plan runtime semantics, workers, PostgreSQL, Caddy,
Project Brain, database schema or migrations, production infrastructure,
deployment architecture, secrets, signing, unrelated Runtime-v6 hardening,
or unrelated product features.

Only `mission-control-web` may be promoted. The generic worker, action worker,
Project Brain worker, PostgreSQL, Caddy, and any retained rollback containers
must remain unchanged.

## Review and acceptance gates

Focused independent review of the exact merged diff reported:

- Analyze-only admission and runtime boundary: passed;
- no Grok Consensus role or fallback path: passed;
- no repository mutation or shell/write capability in the Grok invocation:
  passed;
- authentication and mutation-origin checks remain on onboarding: passed;
- no changed authentication, authorization, worker, schema, migration,
  infrastructure, or deployment files: passed;
- high-confidence secret scan: passed;
- unresolved HIGH findings: `0`;
- unresolved MEDIUM findings: `0`.

The exact downloadable artifact was independently checked as:

- version: `0.7.3`;
- byte length: `155078`;
- SHA-256: `a4321cb88a98411941675e0a9343fc53710359f03ae4a79df0c1968accd555f4`.

Validation completed before deployment:

- protected PR #31 `validate` CI: passed;
- `npm run typecheck`: passed;
- `npm run lint`: passed;
- `npm run format:check`: passed;
- full current unit suite: `218/218` passed;
- `npm run build`: passed;
- `git diff --check`: passed;
- production dependency audit (`npm audit --omit=dev --audit-level=high`):
  zero vulnerabilities.

The full development-tree audit reports one pre-existing high advisory nested
under the development-only `aws-cdk-lib` dependency (`brace-expansion`). It
is absent from production dependencies, unchanged by PR #31, and is not a
PR31 release finding. No dependency remediation or lockfile change is part of
this release.

## Pre-release production state

Before promotion, the public health endpoint returned `status: ok` with a
reachable database and readiness returned `status: ready` with no failed
checks. The web container was running the predecessor digest above with zero
restarts. The generic worker, action worker, Project Brain worker, PostgreSQL,
and Caddy were running with their existing digests and zero restarts.

## Rollout

1. Reconfirm the predecessor container and all non-web service identities.
2. Pull only the approved target digest from ECR; do not rebuild or use the
   `75bb17d` tag as the deployment selector.
3. Rename and stop the current web container as
   `mission-control-web-pre-75bb17d` while retaining the existing predecessor
   rollback container as evidence.
4. Start only `mission-control-web` from the approved digest with the existing
   production environment file, `mission-control` network, restart policy, and
   `PROJECT_BRAIN_EXECUTION_MODE=remote` setting.
5. Verify the running image digest and zero restart count before traffic
   acceptance.

No migration, worker restart, worker replacement, secret retrieval, or
destructive mission/repository mutation is authorized.

## Production verification

Verify public health/readiness, authentication and protected routes, existing
Standard and Consensus onboarding, Grok onboarding and artifact resolution,
agent registration/heartbeat eligibility, Analyze-only admission, and
rejection of a Grok mutation mission. Confirm no existing registration is
altered, no worker restarts occur, no schema/infrastructure changes occur, and
the running web digest equals the approved target.

Run one non-destructive Grok Analyze-only smoke mission only against an
already-registered safe repository and active Grok agent. Do not create a
destructive mission or repository mutation merely to test the UI. Record the
provider adapter/version/artifact identity, mission result, repository
pre/post identity, changed paths, commits, pushes, pull requests,
deployments, and cleanup/quiescence evidence.

## Rollback

If health, readiness, authentication, protected routes, existing onboarding,
protocol behavior, or the Analyze-only boundary fails, stop the new web
container, restore the exact predecessor web container from
`mission-control-web-pre-75bb17d`, and verify health/readiness again. Do not
restart or replace any other production service and do not run a destructive
database rollback.

## Execution evidence and closure

Deployment command IDs, exact running digest, production verification,
Grok smoke evidence, mutation counters, service restart counts, and rollback
status will be appended here after the authorized cutover.
