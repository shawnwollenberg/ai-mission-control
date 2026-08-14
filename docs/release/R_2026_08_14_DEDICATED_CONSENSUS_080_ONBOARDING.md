# R-2026-08-14 — Dedicated Governed Consensus Agent onboarding

**Classification:** Security-sensitive application release

**Human authorization:** Approved in the exact operator instruction “Authorize Dedicated Mission Agent 0.8 Consensus Onboarding” on 2026-08-14.

**Production authority:** Deploy only this reviewed onboarding, compatibility-routing, governed cancellation, and smoke scope. No implementation-authority expansion.

## Scope

- Preserve Standard onboarding and Mission Agent 0.7.2 byte-for-byte.
- Add a distinct capability-oriented Governed Consensus onboarding choice for Codex and Claude Code.
- Deliver the unchanged signed Mission Agent 0.8.0 artifact (`c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494`) with exact metadata and capability-manifest verification and canonical `realpath` invocation.
- Register exact frozen profiles: Claude/Fable planning+synthesis, Codex/Sol planning, and Codex/Luna execution; fallback remains disabled.
- Keep the dedicated 0.8 runtime in a separate local home/process so it does not replace or migrate a Standard 0.7.2 agent.
- Reject Standard Analyze/Change Mission admission to Consensus-only 0.8 before mission state is created. Existing Consensus admission remains exact profile/model/capability based and cannot fall back to legacy 0.7.2.
- Cancel the stuck legacy execution only through its existing canonical cancellation command after deployment.

## Explicit non-goals

- No change to Mission Agent 0.7.2, Mission Agent 0.8.0 bytes, signatures, provider/model semantics, Consensus Plan semantics, repository/filesystem/validation authority, lease/fencing, production implementation authority, or first-mission behavior.
- No automatic upgrade, credential migration, implementation smoke, repository mutation, push, pull request, merge, deployment by an agent, or fallback.

## Acceptance criteria

1. Standard onboarding still generates the exact signed 0.7.2 command and existing Standard agents remain operational.
2. Governed Consensus onboarding registers exact 0.8 Codex/Claude profiles, verifies artifact+sidecars, invokes through canonical realpath, and reaches pull-ready capability attestation.
3. Consensus Plan admission selects only exact compatible 0.8 profiles; Standard missions reject 0.8; neither path falls back.
4. Production read-only planning authority remains least privilege and implementation remains disabled unless separately authorized.
5. The stuck legacy execution becomes canonically terminal, its assignment and lease become terminal/revoked, and no provider/resource survivor remains.
6. Focused onboarding/routing/compatibility tests, unit, integration, browser, TypeScript, ESLint, Prettier, production build, and `git diff --check` pass with independent review at 0 HIGH / 0 MEDIUM.

## Rollout

Build and deploy through the existing protected Phase 6 application procedure after CI passes. Verify health/readiness and migrations, verify a Standard 0.7.2 agent remains connected, connect separate Codex and Claude 0.8 Consensus agents, verify repository registration and exact capability attestations, then run only the previously authorized read-only production Consensus Plan smoke.

## Rollback

Restore the prior application image. Do not delete agents, credentials, repositories, missions, events, or signed artifacts. Stop only the new dedicated local 0.8 processes and disable new Consensus assignment eligibility while retaining canonical evidence. Standard 0.7.2 remains unchanged throughout.

## Risks and controls

- **Service collision:** 0.8 onboarding uses a dedicated home and does not call its default service installer, so it cannot replace the Standard launch agent.
- **Representation/identity drift:** all three immutable release files are downloaded and checked against exact approved SHA-256 values before canonical invocation.
- **Wrong mission type:** Standard admission rejects 0.8 before mission creation; Consensus admission already requires exact attested profiles/models.
- **Authority expansion:** capability/model bindings remain frozen; production implementation remains disabled for the authorized read-only repository profile.

## Post-deployment correction evidence

Production verification exposed two narrow defects inside this release's approved acceptance criteria:

- The dedicated persistent 0.8 launcher installed the verified artifact but did not copy its already-verified immutable metadata and capability sidecars into the dedicated agent home. The correction copies those exact sidecars only after checksum verification and before starting the persistent runner; any copy or permission failure prevents startup.
- Canonical mission cancellation left a never-claimed legacy pull execution in `requested` with an `available` assignment. The correction terminalizes only unclaimed, lease-free, non-Consensus pull executions through the existing execution cancellation command and completes the existing pull assignment. Consensus cancellation and all claimed/leased execution semantics remain unchanged.

The correction does not modify signed Mission Agent bytes, provider/model bindings, Consensus Plan semantics, repository/filesystem authority, lease/fencing, or production implementation authority. Rollback remains restoration of the prior application image; canonical events and registered agents are retained.
