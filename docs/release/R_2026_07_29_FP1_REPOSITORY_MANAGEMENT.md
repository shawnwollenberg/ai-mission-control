# Release R-2026-07-29-FP1 — Repository management forward port

**Status:** CI remediation complete locally; renewed human approval pending

**Human approval:** the prior approval was invalidated by failed GitHub validation; no renewed approval has been granted
**Production base:** `046c40e7747f3e5b72c600064d9402936abf238a` (`origin/production`, fetched 2026-07-29)  
**Classification:** security-sensitive application release  
**Release commit:** `f81ca321339db253eff54c958af19bd57a11e190`
**Release authority:** investigation, test-harness remediation, validation, push to the existing PR branch, and an evidence commit are authorized; merge, deployment, migration application, Mission Agent publication/signing, production mutation, and scope expansion remain prohibited

## Behavioral gap analysis

### Stale release intent

The stale release intended to add an obvious add-repository instruction to the
dashboard, distinguish registrations from `mission/*` working copies, reject
unsafe remotes, and make duplicate repository registration atomic,
workspace-isolated, auditable, and retry-safe. Its unsigned Mission Agent 0.6.7,
stale fingerprint algorithm, standalone audit migration, and dependency state
are not forward-ported.

### Current production support

Production already has signed Mission Agent 0.7.2, Manifest v3 under Release
Authority v2, `mission-agent repository add`, live configuration refresh,
stable-v2 repository identity, governed legacy identity migration, Project
Brain remote execution, repository grants, workspace-scoped signed protocol
credentials, and migrations through `0028_repository_identity_migration.sql`.

### Remaining behavioral gaps

1. The dashboard does not give users an obvious add-repository action or
   explain that `mission/*` directories are working copies.
2. Mission Agent 0.7.2 submits stable-v2 for a new repository, but the
   production server stable-v2 branch only updates a repository that already
   completed governed migration. Fresh `repository add` therefore cannot
   create a new stable-v2 registration.
3. Legacy registration mutates the repository, identity, grant, and protocol
   receipt separately and has no canonical registration event.
4. Concurrent duplicates can reject a second authorized agent instead of
   preserving the union of associations and grants.
5. URL userinfo is not rejected before persistence.
6. Production test assertions referenced obsolete Mission Agent versions and
   the pull-assignment claim joined repositories through a removed
   `payload.repositoryId` field.

### Required redesign

Fresh stable-v2 registration is authenticated by the existing workspace-bound
agent credential. Mission Control independently derives and compares the
canonical identity. The initial registration cannot require a prior 0.7.2
heartbeat because the signed 0.7.2 `connect` sequence registers repositories
before sending its heartbeat. Artifact identity remains independently
fail-closed when subsequently advertised; no signer or trust rule is weakened.

Registration uses a deterministic workspace/fingerprint repository ID and a
canonical `repository.registered` or `repository.registration_refreshed` event.
The event append transaction also projects the repository, stable identity,
agent association, and read grant. Conflicting aggregate versions retry and
converge. Existing grants are unioned, Project Brain state is untouched, and a
matching legacy repository still requires governed migration.

The protocol receipt is prepared by authentication before the transaction and
completed after commit. It cannot join the event-store transaction. If receipt
completion fails, the route releases only the still-processing receipt; a
signed retry uses the deterministic command and repository IDs and returns the
already committed repository without duplicating state.

## Scope

- Add dashboard guidance for adding another repository and clarify repository
  count, `Run Demo`, and `mission/*` working-copy behavior.
- Support fresh stable-v2 repository registration using current protocol v2.
- Add canonical immutable registration/refresh events and transactional
  projections.
- Preserve all existing agent associations and resource-grant permissions
  across duplicate and concurrent requests.
- Reject malformed and credential-bearing remotes before persistence.
- Recognize the exact signed 0.7.2 heartbeat identity without coupling checksum
  verification to Project Brain installation.
- Repair stale release tests so current 0.7.2 and historical signed 0.6.8
  evidence are tested independently.

## Non-goals

- No Mission Agent build, modification, signing, publication, or manifest
  update.
- No package or lockfile change.
- No migration, repository removal redesign, Project Brain mutation, GitHub
  credential transport, clone operation, push, merge, or deployment authority.
- No bypass of governed legacy-v1 migration.
- No resolution claim for the pre-existing full-format, integration, or
  lifecycle E2E failures until their causes are fixed and the gates rerun.

## Authorization, isolation, identity, and secrets

- The route ignores browser/workspace IDs; workspace and agent IDs come only
  from the authenticated signed agent credential.
- Every lookup, deterministic ID, aggregate, event, repository, identity, and
  grant is workspace-scoped.
- Protocol v2 identity is recomputed server-side from the exact repository name
  and selected canonical remote.
- HTTPS/HTTP userinfo and URL passwords are rejected. SSH usernames remain
  valid; SSH passwords are rejected.
- Raw remote URLs, local paths, tokens, credentials, signatures, and protocol
  secrets are absent from canonical event payloads. Only the credential-free
  canonical remote is recorded.
- Registration grants read only. It does not expand write, commit, push, pull
  request, merge, deployment, Project Brain, or agent execution authority.

## Audit and event expectations

`repository.registered` is the canonical initial event and
`repository.registration_refreshed` is the canonical idempotent/association
refresh event. Both identify workspace aggregate, repository, authenticated
agent, stable fingerprint, canonical remote, branch, and observed commit. The
existing protocol security audit records rejected requests. Event replay must
rebuild repository, identity, association, and grant state.

## Mission Agent, signer, and Project Brain compatibility

The release must leave these production files byte-identical to the base:

- `public/mission-agent-0.7.2.mjs`
- `public/mission-agent-latest.json`
- `release/mission-agent-0.7.2/signed-manifest-v3.json`

Expected 0.7.2 artifact: 148,063 bytes, SHA-256
`108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`,
Node 22, identity protocol 2, signing key
`mission-agent-release-2026-01`, fingerprint
`ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b`.

Historical 0.6.8 remains 117,277 bytes with SHA-256
`e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d`.
Project Brain flags, bindings, records, grants, and capability checks are
preserved and never initialized or changed by registration.

## Migration impact

No migration is proposed. Current production head `0028` already contains the
required repositories, identities, grants, commands, aggregate heads, and
events. A clean disposable database migrated through `0028`; a second migration
run reported zero pending migrations.

## Acceptance criteria

1. Own-workspace stable-v2 registration creates exactly one active repository,
   identity, read grant, and canonical event.
2. Manipulated workspace IDs cannot cross the credential boundary.
3. Duplicate and concurrent attempts converge without losing agents or grant
   permissions.
4. Failures after repository, identity, or grant projection roll back all
   database-backed registration state.
5. Malformed and credential-bearing remotes persist no secret or partial state.
6. A new repository can launch a mission; existing repositories, legacy
   migration, agents, grants, and Project Brain remain compatible.
7. Event replay reconstructs the complete registration projection.
8. Signed 0.7.2 and historical immutable artifacts remain exact and verified.
9. All repository-required gates and authenticated browser validation pass.

## Validation evidence (Node v22.20.0, npm 10.9.3)

| Gate                            | Result                   | Evidence                                                               |
| ------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| Clean install                   | Pass                     | `npm ci`; 412 packages installed                                       |
| Focused identity/artifact tests | Pass                     | 39/39                                                                  |
| Forward-port integration tests  | Pass                     | 7/7                                                                    |
| Failure injection               | Pass                     | all three transition points                                            |
| Concurrent duplicate repetition | Pass                     | 10/10 consecutive runs                                                 |
| Unit suite                      | Pass                     | 162/162, including 12/12 KMS release-signer tests                      |
| Full integration suite          | Pass                     | 65/65                                                                  |
| E2E suite                       | Pass                     | 2/2; signed 0.7.2 execution `succeeded` and mission `completed`        |
| Full lint                       | Pass                     | zero warnings                                                          |
| Full formatting                 | Pass                     | ordinary files formatted; four exact-byte manifests narrowly excluded  |
| Typecheck                       | Pass                     | `tsc --noEmit`                                                         |
| Production build                | Pass                     | Next.js production build                                               |
| Migration status                | Pass                     | current head, zero pending                                             |
| Artifact immutability           | Pass                     | base diff clean; checksums and sizes match                             |
| Dependency audit                | Residual, non-production | full audit: 9 high development-tool findings; production-only audit: 0 |
| `git diff --check`              | Pass                     | no whitespace errors                                                   |

## PR #7 CI signing-test remediation

GitHub Actions run `30472824941`, job `90647047917`, failed seven of 160 unit
tests. In every failure, `signReleaseWithKms` was invoked with in-memory mock
KMS/STS clients while GitHub supplied `CI=true`; `APP_ENV` and `NODE_ENV` were
unset. The production guard correctly rejected before manifest, artifact,
authority, KMS-shape, principal, signature, or verification logic:
`Human-authorized KMS signing is disabled in production and CI`.

Failure classification:

1. `AWS KMS Ed25519 RAW conformance yields DER SPKI fingerprint, raw signature,
and complete receipt` intended signer-contract and verification coverage.
2. `production signing adapter signs exact canonical Manifest v3 bytes`
   intended canonical-input and signer-contract coverage.
3. `signer fails before KMS Sign for modified artifact, identity confirmations,
and human confirmation` intended pre-effect policy rejection coverage.
4. `modified artifact bytes fail closed before signing` intended artifact
   integrity rejection coverage.
5. `wrong KMS key shape, usage, algorithm, public key, and disabled state fail
closed` intended signer/KMS policy validation coverage.
6. `unauthorized AWS principal and incomplete activation evidence fail before
KMS Sign` intended release-authorization rejection coverage.
7. `wrong public key and KMS verification failure do not produce outputs`
   intended public-key binding and signature-verification failure coverage.

The first incorrect transition was test construction: mocks were injected but
were not explicitly authorized as unit-test doubles. No real KMS call occurred,
and this did not expose a production signing regression.

The remediation adds `createTestOnlyKmsSigningDependencies`. It creates an
internally branded dependency object only when `NODE_ENV=test`, rejects actual
AWS SDK KMS/STS clients, and cannot be forged without the module-private
symbol. `signReleaseWithKms` permits the injected fake in tests while retaining
the original production/CI rejection for every unbranded call. Mock receipts
carry `evidenceEnvironment: test-only-mock`; production receipts remain
unchanged. Tests prove CI and production reject missing injection, construction
fails outside tests, real AWS clients are refused, mock evidence is visibly
non-production, and no secret/credential material enters receipts.

This changes only the test seam and receipt marking for explicitly injected
unit-test doubles. Production release-authority behavior, configuration, AWS
clients, signing guard, key identity, signing algorithm, and release artifacts
are unchanged. Renewed human approval remains pending.

The same CI-order local run exposed a separate E2E fixture-isolation defect.
The onboarding test used the fixed remote
`https://github.com/example/mission-control.git` after the integration suite.
Repository identity v2 correctly deduplicated that identity against state left
in the shared disposable database, allowing a one-shot test agent to encounter
an earlier assignment before the new mission. The fixture now creates a unique
remote and an exactly matching local repository name for every run. This
preserves production deduplication and all terminal-state assertions; the test
passes on the previously contaminated CI-order database.

Local remediation validation used Node `v22.20.0` and npm `10.9.3`: clean
`npm ci`; format, lint, typecheck, 162 unit, 65 integration, production build,
and 2 E2E tests all passed. Migration status reports zero pending migrations;
the repository concurrency case passed 10/10 consecutive runs; and
`git diff --check` passed. The signed Mission Agent 0.7.2 remains exactly
148,063 bytes with SHA-256
`108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`;
its artifact, signature, and manifest have no diff.

The narrowly scoped remediation commit is
`5c377617f3407558ce5c1b941b201b17c5916be8`. GitHub Actions validation run
`30479861095`, job `90670803340`, passed in 1 minute 44 seconds. The
authoritative run passed checkout, declared-runtime verification, clean
install, migration and seed, full formatting, full lint, typecheck, 162 unit
tests, 65 integration tests, production build, and 2 E2E tests. The evidence
commit containing this result is intentionally documentation-only; its exact
branch-head SHA and follow-up CI run are reported with the release handoff
because a commit cannot contain its own SHA.

The reviewed repository-management behavior did not change in this
remediation. Mission Agent 0.7.2 bytes, signature, manifest, size, and SHA-256
remain unchanged, and the production/CI real-signing guard remains intact.
Renewed human approval remains pending.

The audit findings are in ESLint/CDK dependency paths: direct development
dependencies `eslint` and `eslint-config-next`; transitive
`@eslint/config-array`, `@eslint/eslintrc`, `eslint-plugin-import`,
`eslint-plugin-jsx-a11y`, `eslint-plugin-react`, `minimatch`, and
`brace-expansion`. The underlying advisories are brace-expansion denial of
service through adversarial glob expansion. They are not bundled into the
deployed Next.js runtime or Mission Agent artifact and were already present in
the production base. npm proposes major or otherwise incompatible toolchain
changes; no lockfile change is included. Follow-up owner: platform/tooling.
Acceptance: upgrade compatible ESLint/Next/CDK dependency paths, obtain a
zero-high audit or documented upstream exception, and rerun lint, build, and
artifact reproducibility checks.

## Root cause and remediation of the four failed tests

1. `configured owner authenticates and an invalid password is rejected`
   expected an owner session but received `undefined`. Its database preparation
   depended on an externally seeded password hash that did not match the
   asserted password. This stale, non-isolated fixture now seeds its own bcrypt
   credential and still verifies that idempotent seeding cannot replace it.
2. `pull-ready Mission Agent claims, renews, validates, and releases one durable
assignment` expected an available assignment to become leased but received
   no claim. The first incorrect transition was claim selection:
   `pull_assignments.payload` now contains `allowedResources`, while the query
   still required obsolete `payload.repositoryId`. The authoritative join now
   uses `execution_projections.repository_id`.
3. `change mission assignment carries bounded write approval, validation,
evidence, and permanent prohibitions` expected execution creation but
   reported `Remote agent is ineligible`. It shared the claim defect: the prior
   unclaimable execution remained active and consumed agent concurrency.
   Correct claim resolution fixes the failure without weakening eligibility.
4. `guided onboarding connects Mission Agent and completes a pulled
repository-analysis mission` expected mission `completed` and execution
   `succeeded`; it observed mission `running` and execution `requested`. It
   shared the obsolete claim join. Its 0.1.1 fixture also predates the durable
   execution lifecycle and could complete task/mission state while leaving the
   execution requested. Agents older than 0.3.1 are now rejected before mission
   or execution creation. The success path uses exact signed 0.7.2.

## Authenticated browser validation

The disposable authenticated E2E signed in, preserved a durable mission through
restart, served and ran the exact signed 0.7.2 artifact, registered a stable-v2
repository, claimed its assignment, uploaded analysis, recommendations, and
health evidence, and reached execution `succeeded` and mission `completed`.
Focused integration tests cover duplicate, concurrent, malformed,
credential-bearing, and cross-workspace registration. No production system or
retained credential was used.

## Formatting disposition

The six ordinary pre-existing failures were safely formatted:

- `app/api/agent-protocol/v1/publications/fail/route.ts`
- `app/api/recommendations/[recommendationId]/change-mission/route.ts`
- `app/missions/[missionId]/durable-mission-console.tsx`
- `app/recommendations/[recommendationId]/recommendation-actions.tsx`
- `domain/action-request.ts`
- `tests/recommendation.test.mjs`

Four exact-byte canonical release inputs were not modified and are explicitly
listed in `.prettierignore`: `public/mission-agent-latest.json`, both 0.7.0
unsigned Manifest v2 records, and the signed 0.7.2 Manifest v3 record. The full
format check passes without excluding application source, tests, or
documentation.

## Rollout

After a new human approval only:

1. Reconfirm the exact base/approved diff and signed-artifact immutability.
2. Run migrations in status-only mode; no schema application is expected.
3. Deploy the application using the existing governed application-release
   process; do not publish an agent.
4. In one disposable production workspace, register one stable-v2 repository,
   retry it, launch an analysis mission, and inspect canonical events/grants.
5. Expand only after workspace isolation, logs, audit data, Project Brain, and
   existing-agent health remain clean.

## Rollback

Roll back application code to the exact prior production version. Do not run a
down migration and do not delete repositories, identities, grants, agents,
missions, events, receipts, or Brain records. Newly created rows/events are
forward-compatible with current tables and remain durable. Verify older
application reads remain safe before rollback authorization.

## Post-deployment verification

- Repository appears exactly once after refresh and restart.
- Existing repositories, grants, agents, and Brain records are unchanged.
- Duplicate retry returns the same repository and preserves all associations.
- Cross-workspace and credential-bearing attempts are rejected without secret
  material in UI, logs, records, events, receipts, or audit data.
- A new-repository mission reaches completed.
- Signed 0.7.2 selection, checksum, signature, signer identity, and updater
  behavior remain exact.

## Reviewed diff boundary and residual risks

The reviewed boundary is limited to repository registration UI/protocol,
canonical registration transaction/projection, artifact capability
recognition, durable pull assignment selection, minimum compatible execution
version, formatting-only repairs, exact-manifest exclusions, tests, and this
release record. It contains no Mission Agent artifact, signed manifest,
migration, Project Brain implementation, dependency, lockfile, infrastructure,
signing, or deployment change.

Exact reviewed paths:

- `.prettierignore`
- `app/api/agent-protocol/v1/publications/fail/route.ts`
- `app/api/agent-protocol/v1/repositories/route.ts`
- `app/api/recommendations/[recommendationId]/change-mission/route.ts`
- `app/first-mission-form.tsx`
- `app/globals.css`
- `app/missions/[missionId]/durable-mission-console.tsx`
- `app/recommendations/[recommendationId]/recommendation-actions.tsx`
- `application/mission-agent-capability-projector.ts`
- `application/onboarding-mission.ts`
- `application/pull-assignments.ts`
- `application/registry.ts`
- `application/remote-agent-messages.ts`
- `application/repository-identity.ts`
- `domain/action-request.ts`
- `integrations/mission-agent/artifact-manifest.ts`
- `integrations/mission-agent/kms-release-signer.ts`
- `tests/authentication.integration.test.mjs`
- `tests/durable-browser.e2e.test.mjs`
- `tests/fixtures/mission-agent-0.6.8-manifest.json`
- `tests/mission-agent-070.test.mjs`
- `tests/mission-agent-artifact.test.mjs`
- `tests/mission-agent-pull.integration.test.mjs`
- `tests/kms-release-signer.test.mjs`
- `tests/project-brain-packaging.test.mjs`
- `tests/recommendation.test.mjs`
- `tests/release-authority-v2.test.mjs`
- `tests/repository-identity.test.mjs`
- `tests/repository-management-forward-port.integration.test.mjs`
- `docs/release/R_2026_07_29_FP1_REPOSITORY_MANAGEMENT.md`

The remaining nine high audit findings are development/build-tool
denial-of-service advisories in ESLint/CDK dependency paths. The production-only
audit has zero findings. Their remediation requires toolchain upgrades and
remains the named platform/tooling follow-up above.

Rollback is code-only: no migration exists, and repositories, identities,
grants, commands, events, missions, receipts, and Brain records remain durable.
Existing repository/grant and Project Brain preservation pass integration
coverage. Before merge or deployment, the repository release mechanism must
contain a new explicit human approval bound to this release ID, base SHA, exact
remediated diff, final GitHub CI evidence, rollout, and rollback.

**Approval disposition: Renewed human approval pending.**
