# R-2026-08-13 Runtime-v6 Consensus Plan release

**Classification:** Security-sensitive application and agent-runtime release

**Human authorization:** On 2026-08-13, the human operator explicitly authorized the consolidated Runtime-v6 remediation and instructed Codex to drive the exact reviewed source through commit, push, pull request, normal protected-branch CI, merge, the established production deployment, required additive migrations, and production smoke verification. That authorization is limited to this release. It does not grant Mission Control agents any merge, deployment, infrastructure, secret, signing, or production authority.

## Exact scope

- First-class Claude Code and Codex Consensus Plan roles with two proposals, cross-critiques, revisions, canonical synthesis, exact-hash verdicts, and owner approval.
- One separately governed Codex/Luna Repository Change Mission using bounded isolated-worktree capabilities, declared validation, and a local commit only.
- Exact provider/runtime/model attestations, Mission Agent 0.8.0 lifecycle ownership, retries, process-tree cleanup, repository and filesystem authority, lease/fencing, and fail-closed authentication.
- Governed Project Brain context retrieval and proposed learning candidate creation. No automatic evaluation, curation, promotion, or Project Brain authority change.
- Additive migrations 0029 through 0031, replayable events/projections, authenticated authority-observation evidence, operator UI, runbooks, and acceptance tooling.

## Permanent exclusions

- Runtime-v6 agents cannot push, open pull requests, merge, deploy, publish packages, mutate infrastructure or secrets, or contact production.
- Consensus never bypasses owner approval, repository authority, filesystem authority, validation authority, leases, fencing, or final result acceptance.
- The disposable acceptance registry and its credentials/evidence are not release artifacts and are not committed or deployed.

## Acceptance and review evidence

- Authenticated disposable run: `fafb2b11-a405-4ba4-ab01-cd20e2f53a18`.
- Exact accepted candidate SHA-256: `c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494`.
- Exact disposable registry SHA-256: `a5879b50d755b76c16555cd70a1cb3c43abd2cc4b96cce33820b39d9a4b46c7d` (acceptance only; not shipped).
- Result: 123/123 requirements passed, including exact model argument, runtime identity honesty, provider process-tree termination, and secret redaction.
- Real workflow: Claude/Fable and Codex/Sol proposals, critiques, revisions, Claude/Fable synthesis, exact verdicts, governed approval, and a real Codex/Luna reviewable isolated-worktree implementation all passed.
- Replay covered the complete authenticated event set with `equal=true` and zero discrepancies after authoritative workspace quiescence.
- Independent review completed with 0 unresolved HIGH and 0 unresolved MEDIUM findings.
- Cleanup reconciled 336 registered resources with 336 terminal records and 323 cleanup outcomes; independent host checks found no run-owned survivor, listener, registry copy, writable root, or PostgreSQL directory.
- Production was not contacted during acceptance.

## Release validation

- TypeScript, ESLint, Prettier, syntax checks, and `git diff --check`: passed.
- Unit tests: 201/201 passed.
- Serial integration tests: 97/97 passed.
- Browser E2E: 2/2 passed.
- Production build: passed on Node 22.20.0.
- Migrations 0001-0031: applied with zero pending; migration 0031 rollback/reapply passed in a disposable PostgreSQL instance.
- Full governed mock acceptance: passed with 119 local requirements and exactly four authenticated-only deferrals before the real run.
- Production dependency audit: zero vulnerabilities. Development audit retains one known transitive `brace-expansion` advisory in tooling; it is not in the deployed dependency set and remains backlog.

## Rollout

1. Merge only after required GitHub CI passes on the exact proposed commit.
2. Verify the merged SHA, current production SHA, production health baseline, backup/rollback assumptions, and migration sequence.
3. Apply only additive migrations 0029, 0030, and 0031 through the existing production migration command.
4. Deploy the exact merged SHA through the established manual Render release procedure.
5. Verify health/readiness, migration status, login, Mission Agent compatibility, registration/heartbeat, read-only mission execution, Consensus Plan availability, Project Brain availability, and error/resource state.

## Rollback

Prefer forward-safe application rollback: stop new Consensus Plan creation, drain or cancel governed read-only turns, deploy the last known-good schema-compatible application SHA, and retain additive event/projection history. Do not run the destructive disposable rollback files in production. If the production schema or topology differs materially from the validated assumptions, stop with `PRODUCTION STATE MISMATCH`.

## Release decision

Authorized to proceed through the normal protected release path for this exact scope. This record is evidence of the human instruction; it does not let Codex approve a different release or let Mission Control deploy itself.
