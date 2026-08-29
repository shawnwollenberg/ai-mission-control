# R-2026-08-29 — V2 explicit direct Codex handoff bridge

## Classification and human authorization

This is a security-sensitive application/provider-runtime release because it binds an existing Codex Engineer thread
to canonical Mission authority and adds the CTO-owned `OWNER_AUTHENTICATION` routing capability. The product owner
explicitly authorized implementation, the two named admissions, commit, push, and deployment on 2026-08-29. Codex
does not approve the release.

## Exact scope

- Add an explicit local CLI that promotes one named Codex thread into one canonical GitHub Mission.
- Validate the specific session ID and checkout metadata, normalized GitHub origin, admitted project, and exclusive
  thread ownership before creating the Issue.
- Persist only the thread binding; place a bounded status report and binding metadata—not the transcript—in GitHub.
- Discover only Issues explicitly labeled `mc:tracked` in addition to legacy configured issue numbers.
- Add Permixa to the V2 project registry with the same bounded adapter profile.
- Model owner MFA as `OWNER_AUTHENTICATION`; this routes a request to the owner but grants the agent no credential or
  authentication capability.
- Replace the wrapper-process worker launch with a direct Node process and reconcile stale PID files against the
  worker-owned lock PID.

## Non-goals and authority boundary

No global Codex enumeration, UI scraping, private API, continuous mirroring, full transcript storage, V1 behavior,
database migration, infrastructure/IAM/secret change, permission expansion, MFA action, ACP retry, signing, wallet,
money movement, Responses adapter, or separate OpenAI API billing. GitHub remains canonical after admission.

## Acceptance

The focused suite must prove successful promotion, initial status projection, thread reuse binding, explicit tracked
discovery, duplicate rejection, checkout/repository mismatch rejection, and existing routing behavior. Full V2 tests,
typecheck, lint, formatting, production build, audit, and diff checks must pass. The two real Issues must reconstruct
cleanly, use distinct threads, and route owner authentication differently from an external provider failure.

## Rollout

Build and push an exact digest-pinned application image, retain the prior application container and database backup,
replace only the web container, verify health/readiness/auth boundaries and the `/v2` projection, then start the local
worker with the existing credential and direct-process launcher. No migration is expected.

## Rollback

Stop the new local worker, restore the previous web image/container, and retain the two GitHub Issues as durable audit
evidence. Removing `mc:tracked` hides an admitted Issue without deleting it. No database rollback is required.
