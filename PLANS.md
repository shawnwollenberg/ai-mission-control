# Mission Control — Production Readiness Execution Plan

## Pending release — R_2026_07_30_PUBLICATION_RECONCILIATION_UX

The narrowly scoped publication-reconciliation and mission-filter UX change is documented in
`docs/release/R_2026_07_30_PUBLICATION_RECONCILIATION_UX.md`. It is security-sensitive because it
advances provider-evidenced action state. Human approval remains pending; implementation and validation do not
authorize commit, push, merge, or deployment.

The long-term product direction is maintained in `docs/INTERNAL_PRODUCT_ENGINEERING_ROADMAP.md`. It guides architecture and phase sequencing but does not authorize implementation or expand agent authority; the approved boundaries in this plan remain controlling.

**Status:** Phase 6 deployed; Mission Agent 0.6.3 compatibility fixes deployed — 2026-07-21

**Planning date:** 2026-07-18

**Operating rule:** Deliver one reviewable vertical slice per phase and stop at every phase boundary

## Release R-2026-08-04-CONSENSUS-CLAUDE — Consensus planning and Claude Code provider

**Classification:** Security-sensitive application release; Project Brain integration requires dedicated review

**Review status:** Implementation requested on 2026-08-04. After the consolidated engineering review and successful authenticated Runtime-v6 acceptance, the human operator authorized the exact reviewed release scope through commit, push, protected-branch pull request/CI, merge, established production deployment, additive migrations, and smoke verification on 2026-08-13. The controlling release record is `docs/release/R_2026_08_13_RUNTIME_V6_CONSENSUS.md`. No credential value may be read or exposed, and this authorization does not extend to unrelated releases or grant agents production authority.

**Authenticated release gate (2026-08-13):** Exact candidate `c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494` completed the governed real-provider workflow under disposable registry `a5879b50d755b76c16555cd70a1cb3c43abd2cc4b96cce33820b39d9a4b46c7d`. All 123 requirements passed, including the four authenticated diagnostics. Final replay was equal with zero discrepancies, secrets were clean, independent review reported 0 HIGH / 0 MEDIUM, and cleanup/host reconciliation found zero run-owned survivors. The release matrix passed 201 unit, 97 integration, and 2 browser E2E tests, production build/static gates, migrations current, and disposable migration 0031 rollback/reapply. Production was not contacted by acceptance.

**Current gate result (2026-08-04):** The forward port is based on authoritative production commit `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`. The operator approved the exact packet below solely for disposable acceptance, and that artifact was added to an expiring local registry. Distinct authenticated Claude Code 2.1.221 and Codex 0.146.0 agents registered with verified artifact and runtime bindings. The version contract correctly rejected a Codex 0.144.6 heartbeat without fallback, and unsupported model, expired attestation, and altered runtime-binding adversarial checks failed closed. The governed real workflow did not pass: Codex `gpt-5.6-sol` could not initialize its in-process app-server client inside the Mission Agent sandbox, and Claude Code `claude-fable-5` exited inside that sandbox without accepted structured output. Direct schema-constrained diagnostics outside the outer Mission Agent sandbox accepted both exact model identifiers, but do not satisfy governed acceptance. No synthesis, verdict, approval, child mission, or executor was reached. Projection replay for the failed disposable workspace was equal with zero discrepancies. Repeated independent review reports two unresolved high-severity runtime blockers and no authorization to alter the approved artifact. Any sandbox or artifact correction requires new bytes, new checksums, new exact approval, and a complete fresh acceptance. This record does not approve, sign, commit, publish, or authorize production use of the candidate.

**Superseding development investigation (2026-08-04):** The approved packet above remains frozen and is permanently labeled **NO-GO — provider sandbox incompatibility**. A separate unapproved source revision proposes four provider/operation-specific macOS profiles, durable redacted diagnostics, complete repository-state binding, fail-fast concurrent output fencing, and separate auxiliary-model provenance. Corrected disposable discovery passes brokered Claude authentication/planning, isolated Codex authentication/planning, exact README-only implementation with Claude `claude-fable-5` and Codex `gpt-5.6-luna`, and process-group cancellation/timeout cleanup. Evidence is in `docs/evidence/CONSENSUS_PROVIDER_RUNTIME_PROFILE_DISCOVERY_2026-08-04.md`. This investigation does not alter the approved packet, registry, or production and does not authorize a rebuild until the fresh independent review reports zero unresolved high-severity findings.

**Runtime-v2 acceptance disposition (2026-08-05):** The later unsigned runtime-v2 packet is also permanently **NO-GO**. Real consensus execution exposed divergent live/replay objection identity and ten expired raw lease bearer tokens in the disposable receipt table; implementation and approval did not proceed. Its database and local evidence remain retained under the bounded procedure in `docs/evidence/MISSION_AGENT_080_RUNTIME_V2_ACCEPTANCE_NO_GO_2026-08-05.md`. Corrected development source introduces canonical objection IDs, event-only projection input, strict secret-free receipt v2 structures, ephemeral-only lease tokens, exact lifecycle profile/model binding, and successful-attempt provider diagnostics. Any rebuilt artifact is a new unapproved packet; it may not enter a registry or invoke a real provider until a human approves every new exact checksum and assignment.

**Controlling design:** `docs/CONSENSUS_PLAN_AND_CLAUDE_CODE_IMPLEMENTATION.md`

### Exact scope

- First-class `claude_code` Mission Agent provider metadata, capability advertisement, compatibility checks, onboarding, registry presentation, and governed local adapter boundary.
- Explicit `planner_a`, `planner_b`, `synthesizer`, `executor`, and optional `implementation_reviewer` agent/provider/model assignments backed by immutable, expiring, queryable capability attestations. No automatic model routing, fallback selection, or cost optimization is introduced.
- Planning-only `CONSENSUS_PLAN` missions with exactly two role-specific planners, one immutable repository snapshot and Project Brain context pack, server-enforced proposal withholding, one critique round, one revision round, deterministic bounded synthesis, immutable canonical plan hashing, exact-plan verdicts, explicit consensus decision, and mandatory human approval.
- Idempotent creation of one separate existing governed Repository Change Mission after approval, with exact parent, repository snapshot, context, canonical artifact/hash, human receipt, selected executor/model, budget, acceptance, validation, and rollback bindings.
- Additive normalized migrations, canonical events, rebuildable projections, artifact/receipt/cost provenance, stale/retry/lease/fencing recovery, UI/history/approval surfaces, and documentation/tests.
- Governed Project Brain context-pack and proposed-learning integration only. No automatic knowledge promotion, curation, confirmation, or authority change.

### Permanent and phase-specific prohibitions

- Planning cannot mutate repositories or execute plan-authored commands.
- Consensus never bypasses human approval or implementation-time policy.
- The one consensus approval binds the exact preferred executor/model and explicitly authorizes only an isolated worktree, repository write, declared validation, and one local commit for the hash-bound child. It prohibits push, pull-request creation, merge, and deployment. Ordinary non-consensus Change Missions retain their existing separate `repository.modify` approval path.
- Claude Code never bypasses Mission Agent authentication, leases, fencing, capabilities, resource grants, command policy, artifact validation, or receipts.
- No automatic push, pull request, merge, deployment, production remediation, infrastructure/database/credential mutation, secret access, wallet signing, transaction submission, or asset movement.
- Existing immutable Mission Agent artifacts are never overwritten.

### Acceptance and release gate

Production readiness requires all automated gates, projection rebuild equality, migration/rollback verification, threat-focused workspace/auth/replay/fencing tests, and a complete disposable-repository acceptance using one real Codex and one real Claude Code runtime with operator-provided local credentials. Any unavailable real-runtime step remains an explicit blocker to a production-readiness claim.

Mission Agent 0.8.0 must be reproducibly built and presented as an unsigned candidate with its exact artifact and capability-manifest checksums, source-base lineage, source-template checksum, provider/model behavior, permissions, isolation, evidence requirements, and limitations. Explicit human approval of that exact checksum may authorize only its addition to the local disposable acceptance registry. It does not authorize signing, publication, production onboarding, migration, or deployment. After that narrow approval, complete real Codex/Claude acceptance and adversarial testing must pass, independent review must repeat with zero unresolved high findings, and only then may the already-authorized logical local commits be considered. Production onboarding continues to distribute signed 0.7.2 and must not advertise consensus capability until a later exact production release approval and signing ceremony.

Before a local commit, attach the reviewed diff, exact migration and artifact checksums, complete validation evidence, credential/secret scan, rollback rehearsal, and disposable acceptance result; the operator's instruction authorizes that local commit only if every requested gate is complete. Push, merge, Mission Agent publication, production migration, or deployment additionally require actual human production approval for the exact final commit and release scope. Codex cannot supply that production approval.

### Unsigned Mission Agent 0.8.0 local-acceptance approval packet

**Approval status:** Approved and exercised only for the disposable local acceptance performed on 2026-08-04. The exact artifact was added to an expiring local registry and remains unsigned and unauthorized for commit, publication, or production. Acceptance failed at the governed provider sandbox boundary; the approval does not authorize changing or retrying modified bytes.

- Artifact: `public/mission-agent-0.8.0.mjs`
- Artifact SHA-256: `52a2a20f8058351ecd91ed431dbc65a107c5e4489c40b938cc4a3e10a2fc2dbd`
- Artifact byte length: `203173`
- Artifact metadata SHA-256: `fa5ca6f83c675b96b137b82ba5447fa106efb347852d23b240f594be6a667200`
- Capability manifest: `public/mission-agent-0.8.0.mjs.capabilities.json`
- Capability-manifest SHA-256: `52f9524747e94bed8298e37e382a63c7eee20a3cfc083bb1d03c74797c05fd01`
- Authoritative source base: `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`
- Uncommitted source-template SHA-256: `896a29247a486479ca390c91d358135537541d05c9a49af19e9b6541a5bf0258`
- Build-script SHA-256: `601b03d980a1463fc535e40e880fd614f375f5e34ebf8a6ea4a0c2ea093ed080`
- Provider-runtime catalog file SHA-256: `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206`
- Provider-runtime catalog canonical SHA-256: `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3`
- Migration 0029 SHA-256: `4db91639bc55f631403c887e3869e5ef7a65c4cde68756cb1d0ca0efa108aa8f`
- Destructive disposable rollback SHA-256: `3e54f7743feecacb14b8097f50b0fa3dffeea5e98f50b9717bff1dc13e306e2f`
- Installed provider evidence: Codex CLI `0.146.0`; Claude Code `2.1.221`; both accept an exact `--model` argument; neither provides reliable complete enumeration or independently verifiable actual-model identity for every invocation.
- Providers: `codex`, `claude_code`.
- Explicit roles: `planner_a`, `planner_b`, `synthesizer`, `executor`, `implementation_reviewer`; automatic implementation review remains disabled.
- Model source: reliable provider discovery when available, otherwise an explicit validated versioned operator allowlist included in the immutable expiring attestation. No marketing-name enums, automatic routing, fallback selection, or cost optimization.
- Runtime guarantee: the assigned provider model identifier is validated, recorded, and passed as the exact `--model` argument on every invocation; Claude fallback-model is not enabled; a detectable model mismatch fails. Actual identity is declared `unverifiable` when the provider cannot prove it.
- Provider runtime binding: consensus-scoped contract `provider-runtime-requirements/1` declares exact executable/supported CLI version/auth probe, host, isolation/network/temp/credential scope, repository access, model selection/fallback, structured output, clean-worktree, redaction, and consensus eligibility for `codex`, `claude_code`, `hermes`, `generic`, and `mock`. Probe-derived heartbeat readiness and participant assignments bind its exact version/scope/provider/requirement hash; the UI does not present that local probe as provider attestation.
- Planning permissions: OS-sandboxed no-repository-access provider execution, no provider tools or shell, clean registered planning worktree required, writes limited to an invocation-private directory. Codex receives outbound network plus local-only IPC required by its app-server runtime; Claude receives outbound network. No unrestricted inbound network is allowed.
- Implementation permissions: OS-sandboxed writes only to the exact isolated worktree and provider-private runtime; Codex home or Claude home plus service-mediated Keychain access are narrow read-only credential exceptions; unrelated home directories, raw Keychain-directory access, repositories, volumes, temporary directories, shell tools, push, PR, merge, deployment, signing, and transaction actions remain denied.
- Required success evidence: implementation plan, patch, validation results, summary, exact commits/assignment/agent/provider/model/lease/fence bindings, and one immutable authenticated validation receipt.

The exact approval requested at this gate is: **approve only artifact SHA-256 `52a2a20f8058351ecd91ed431dbc65a107c5e4489c40b938cc4a3e10a2fc2dbd` (203173 bytes), artifact-metadata SHA-256 `fa5ca6f83c675b96b137b82ba5447fa106efb347852d23b240f594be6a667200`, capability-manifest SHA-256 `52f9524747e94bed8298e37e382a63c7eee20a3cfc083bb1d03c74797c05fd01`, authoritative source base `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`, uncommitted source-template SHA-256 `896a29247a486479ca390c91d358135537541d05c9a49af19e9b6541a5bf0258`, build-script SHA-256 `601b03d980a1463fc535e40e880fd614f375f5e34ebf8a6ea4a0c2ea093ed080`, provider-runtime catalog file SHA-256 `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206`, and canonical catalog SHA-256 `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3` for addition to the disposable local acceptance registry and subsequent real Codex/Claude acceptance, adversarial testing, and independent review.** This approval does not authorize signing, committing, staging, pushing, opening a pull request, merging, publishing, production access, or deployment.

### Rollback

Disable new consensus/Claude assignment eligibility, stop new read-only planner jobs, cancel or drain active leases through the signed protocol, restore prior compatible application and Mission Agent artifacts, retain all additive schema and canonical history, rebuild and verify projections, and repair forward. No destructive down migration or history deletion is authorized.

## Release R-2026-07-29 — Additional Mission Agent repository management

**Classification:** Security-sensitive application release

**Review status:** Implementation and release record reviewed by Codex on 2026-07-29; **human approval pending**. This record does not authorize commit, push, merge, or deployment. Approval must be recorded through the repository's existing human approval mechanism for this exact release.

### Classification evidence

- The visible product change is bounded repository-management guidance and header layout.
- The registration path is not a browser-to-GitHub credential flow. A locally installed Mission Agent validates a Git repository and submits a signed protocol message.
- The message's workspace and agent identities are derived from the authenticated Mission Agent credential, not accepted from browser-supplied workspace identifiers.
- The implementation changes repository identity and duplicate handling in the Mission Agent/runtime registration path.
- The path reads and stores repository remote identity. It therefore touches tenant isolation, authorization, agent protocol/runtime behavior, and credential-safety boundaries and cannot be classified as routine.
- It changes no deployment infrastructure, IAM, secret provider, signing authority, database schema, or destructive production capability, so it is not an infrastructure/runtime release.

### User problem and intended behavior

An authenticated user with a connected Mission Agent can see registered repositories but lacks a clear way to add another one. The repository count and `Run Demo` link also render without adequate visual separation. Re-registering the same repository after its current commit changes can create a misleading duplicate.

The intended behavior is:

1. The application clearly explains that another repository is added on the computer running Mission Agent with `mission-agent repository add /absolute/path/to/repository`.
2. The repository header clearly separates the connection count, add-repository action, and demo action.
3. Mission-created `mission/*` worktrees are identified as working copies rather than new repository connections.
4. A repository identity remains stable across ordinary commit changes.
5. Re-registering the same remote repository converges on one active workspace repository and preserves every existing authorized Mission Agent association.
6. A successfully registered repository appears in the authenticated workspace and can be selected for a subsequent mission.

### Exact scope

- Repository dashboard presentation and responsive styles in `app/first-mission-form.tsx` and `app/globals.css`.
- Stable repository fingerprint derivation in the new immutable `mission-agent-0.6.7.mjs` distribution. The previously published `mission-agent-0.6.6.mjs` remains byte-for-byte unchanged.
- Workspace-scoped duplicate matching by stable fingerprint or exact validated remote identity.
- Preservation of existing agent associations during duplicate registration.
- Server-side rejection of malformed or credential-bearing repository remote identities.
- One database transaction for repository persistence, agent association, resource grant, and durable registration audit recording.
- Focused integration and Mission Agent regression tests for repository registration.
- Release-governance documentation in this plan and `AGENTS.md`.

### Explicit non-goals

- No browser form that accepts a repository URL or local path.
- No GitHub OAuth, GitHub App installation, token collection, clone operation, or provider-side repository existence check.
- No new credential storage or credential-provider behavior.
- No repository deletion, automatic cleanup of historical duplicates, or mutation of previously registered repositories during rollout.
- No change to mission, task, execution, approval, policy, action-request, event, projection, merge, deployment, infrastructure, secret, signing, wallet, or asset-movement authority.
- No automatic Mission Agent upgrade and no expansion of supported remote commands.

### Authorization and workspace isolation requirements

- Only a valid signed Mission Agent protocol credential may call the repository registration endpoint.
- The server derives `workspace_id` and `agent_id` from the authenticated credential.
- Envelope workspace and agent identifiers must match the authenticated credential; caller-supplied alternate workspace identifiers are rejected before registration.
- Repository lookup, insert, update, permissions, display, and mission launch remain scoped by `workspace_id`.
- A Mission Agent from workspace A cannot register, update, view, grant, or launch a repository in workspace B.
- Browser mission launch requires the authenticated session workspace and a repository/agent association in that same workspace.

### Duplicate and invalid repository handling

- For remotes, identity is derived from normalized remote identity and does not include the mutable current commit.
- For local repositories without a remote, identity is derived from root commit identity plus repository basename, not current `HEAD`.
- Same-workspace registration by stable fingerprint or exact validated remote reuses the existing active repository record and updates observed commit metadata.
- Duplicate registration merges the registering agent into `allowed_agent_ids`; it must not remove an existing agent association.
- Invalid names, fingerprints, branches, malformed remotes, control characters, unsupported remote schemes, and embedded remote credentials are rejected before an active repository row is created.
- No automatic destructive deduplication is authorized. Existing historical duplicates may only be disassociated through the existing explicit Mission Agent remove command after human review.

### Credential and secret-handling requirements

- The browser receives only the static local command template and safe repository metadata; it never receives Mission Agent secrets, GitHub tokens, credential verifiers, or credential-bearing URLs.
- Mission Agent credentials remain in the existing local protected store and signed request headers.
- Registration payloads contain repository metadata only. Git credentials are neither required nor accepted.
- The server rejects remote URLs containing username/password userinfo rather than persisting or returning them.
- Protocol security logs record bounded reason codes and request paths only; raw authorization headers, signatures, request bodies, remote credentials, and secrets are prohibited.
- Private-repository authentication remains local to Git/Mission Agent and is outside this release.

### Audit-event expectations

- Every registration request remains authenticated, rate-limited, replay-protected, and represented by an idempotent protocol receipt containing the safe acknowledgement.
- Authentication, identity, replay, signature, and validation failures produce bounded protocol security evidence without request bodies or credentials.
- Repository `created_at`, `updated_at`, observed commit, active association, resource grant, protocol receipt, and the immutable `repository_registration_audit` row provide queryable authoritative operational evidence. The audit row is written in the same database transaction as the state it describes.
- This narrow release relies on those authoritative records because repository registration is not currently a canonical event-sourced aggregate. It does not claim that the canonical event architecture gap is resolved.
- **Named follow-up — Canonical repository lifecycle events:** introduce versioned immutable `repository.registered`, `repository.registration_refreshed`, and `repository.disassociated` events; transactionally project active repositories, grants, and agent associations; prove idempotent replay produces an identical workspace-isolated projection; define migration/backfill and protocol compatibility; test concurrent registration, failure recovery, removal, replay, and rollback. This requires its own reviewed production phase.

### Database migration impact

Migration `0025_repository_registration_audit.sql` adds only the `repository_registration_audit` table, its foreign keys, idempotency key, action constraint, and repository index. It does not rewrite or delete repository data. The existing partial unique index on `(workspace_id, repository_fingerprint)` remains authoritative for active fingerprint duplicates. Existing repository rows, IDs, mission references, agent associations, permissions, and disabled records remain in place. Application rollback leaves the additive table in place; no destructive down migration is authorized.

### Acceptance criteria

1. A Mission Agent can add a valid Git repository only inside the workspace bound to its authenticated credential.
2. Manipulating envelope or application workspace/agent identifiers cannot register a repository in another workspace.
3. Re-registering the same remote with a changed commit/fingerprint returns the existing repository ID, leaves one active matching row, updates observed evidence, and preserves existing agent access.
4. Invalid and credential-bearing remotes create no active repository row and persist/return/log no supplied credential.
5. A local Git validation failure occurs before the Mission Agent sends registration. Server-side invalid remote validation occurs before an active repository row is written. Because no provider-side GitHub validation is added, the UI must not claim that GitHub access was validated.
6. A newly registered repository is visible to the account's active Mission Agent and can launch a repository mission.
7. Existing repositories, agents, credentials, permissions, and mission paths continue working.
8. Application rollback leaves the additive audit table in place and deletes no registered repository.
9. Header actions are visually distinct at desktop and mobile widths, and the add-repository instructions are understandable and keyboard accessible.
10. Typecheck, lint, formatting check, unit tests, relevant integration tests, production build, and manual authenticated smoke checks pass.

### Required automated validation

- Unit/Mission Agent tests for stable repository identity, secret-safe output, connection preservation, and current command behavior.
- Integration tests for workspace binding, manipulated workspace rejection, duplicate convergence, multiple-agent association preservation, invalid input, credential-bearing remote rejection, mission launchability, existing-record preservation, and failed-registration rollback.
- Existing authentication, remote-agent protocol, Mission Agent pull, repository health, policy, and durable browser tests relevant to the affected paths.
- Full `npm test`, `npm run test:integration`, `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm run build`.
- `git diff --check`, immutable artifact checksum verification, transactional failure-injection and concurrency tests, and migration status showing no pending migration.

### Required manual validation

1. Sign in to a nonproduction workspace with an active Mission Agent.
2. Confirm `Repositories`, `<n> connected`, `Add repository`, and `Run Demo` render as separate controls at desktop and narrow viewport widths.
3. Expand `Add repository`, copy the command, and verify the copied text contains no account-specific or secret value.
4. From a real local noncritical Git repository, run the displayed command and confirm exactly one repository appears.
5. Re-run after a new local commit and confirm the same repository entry remains.
6. Launch a read-only analysis mission for the repository and confirm assignment and artifact behavior.
7. Inspect browser responses and application logs for secret values and misleading GitHub-validation claims.
8. Verify an existing repository and agent can still launch a mission.

### Production rollout

1. Obtain human approval recorded for `Release R-2026-07-29` after all required evidence is attached.
2. Record the exact release commit and Mission Agent artifact checksum.
3. Build the production artifact from that reviewed commit.
4. Deploy the application through the existing Phase 6 controlled deployment procedure without infrastructure changes.
5. Verify health/readiness and schema health before enabling traffic.
6. Perform the post-deployment checks below using a noncritical repository.
7. Do not automatically upgrade local Mission Agents; publish/update the current artifact only through the existing bounded update mechanism after application compatibility is confirmed.

### Rollback

1. Roll back the application to the prior known-good application artifact using the existing Phase 6 procedure.
2. Restore the prior Mission Agent download manifest/artifact only if the new artifact was published and its checksum/version was recorded.
3. Do not run a down migration. Leave the additive audit table in place for forward compatibility and retained evidence.
4. Do not delete, disable, rewrite, or deduplicate repository rows, repository permissions, agent connections, missions, protocol receipts, or events.
5. Confirm pre-existing and newly registered repositories remain queryable after rollback. The prior application can continue using their stored IDs and metadata.

### Post-deployment verification

- Authentication, application health, worker readiness, and schema health are green.
- Repository header layout and instructions match the reviewed UI.
- A valid registration remains workspace-scoped and creates/reuses exactly one active repository.
- A credential-bearing or malformed test remote is rejected without a row or secret-bearing log entry.
- The repository appears for the correct account, launches a read-only mission, and is absent from another workspace.
- Existing repository and agent smoke missions remain functional.
- Error rates, protocol security events, registration rate limits, and duplicate counts show no unexpected increase.

### Known and residual risks

- Existing historical duplicate rows are not automatically merged or deleted; manual disassociation remains necessary.
- Exact remote-string matching is a compatibility bridge. Semantically equivalent SSH and HTTPS remotes may remain separate unless their stable client fingerprint matches.
- Registration proves a real local Git repository and records its remote identity; it does not prove GitHub provider access or repository existence through a GitHub API.
- Repository registry changes are not yet canonical domain events and cannot be fully rebuilt solely from the event log.
- The durable registration audit is authoritative operational evidence but is not yet a replayable canonical aggregate.
- The dependency audit still reports 11 high-severity package findings: nine development-tool packages affected through glob expansion and two production package findings representing the optional Sharp/libvips image-processing path. The deployed application does not accept attacker-controlled image inputs or use `next/image`, but the production lockfile still contains Sharp 0.34.5.
- Canonical repository lifecycle events remain a separately reviewed architecture follow-up.

### Remediation evidence — 2026-07-29

**Immutable Mission Agent artifact**

- Previously published `public/mission-agent-0.6.6.mjs`: 57,625 bytes; SHA-256 `eb77e55001ab140dc09e4dde798d1ad2408452f3760c9de4a9a93e41d2e6dc76`; restored exactly and excluded from this release diff.
- New artifact `public/mission-agent-0.6.7.mjs`: 57,798 bytes; SHA-256 `0a9b08392d436521edfc0a7bef25f9cd418e9eb2c9f6b2d12893d2f6b93ef6b6`.
- Supported runtime: Node `>=22.20.0 <23`; release validation used Node `v22.20.0`.
- `public/mission-agent-latest.json`, onboarding download/checksum, tests, and end-to-end paths point to `0.6.7`.
- Compatibility expectation: existing analysis-capable agents remain accepted; the end-to-end suite connects `0.1.1`. Change missions using agents older than `0.3.1` fail with the existing explicit compatibility message. No automatic client upgrade occurs.

**Atomicity guarantees**

- Repository insert/update, locked agent-association merge, repository resource grant, and durable registration audit insert execute in one PostgreSQL transaction.
- An advisory transaction lock serializes duplicate identity registration within a workspace; repository and agent rows are also locked for mutation.
- Failures injected after repository persistence, grant creation, and audit creation roll the entire transaction back, leaving no repository, grant, audit row, or partial agent association.
- Idempotent and concurrent retries converge on one active repository and union all previously authorized agents. The registration audit protocol-message uniqueness constraint prevents duplicate audit effects for one message.
- Local Git inspection is preparation performed by Mission Agent before the signed request. It has no database side effect and therefore requires no database compensation. No provider-side GitHub operation exists in this release.

**End-to-end cause findings**

- The lifecycle remained `running` because the worker correctly rejected Node 20 through `assertSupportedNodeVersion()` and exited. Under the declared Node 22.20 runtime, the same lifecycle reaches `completed`; no lifecycle assertion was weakened.
- The onboarding failure was a stale hard-coded `mission-agent-0.5.0.mjs` expectation. Application metadata already identifies the current artifact; the test now asserts the new immutable `0.6.7` path and checksum.

**Authenticated disposable-browser evidence**

- A disposable nonproduction account and workspace were created locally, authenticated, and connected to Mission Agent `0.6.7`.
- A valid existing repository appeared once; a second valid repository was added and appeared once while the first remained unchanged.
- Repeating registration retained exactly two repository records. Restarting the application and refreshing the browser retained the authenticated view and both repositories.
- After refreshing agent heartbeat, a mission was launched against the new repository and displayed as a live mission.
- Malformed and credential-bearing remotes were rejected. A signed cross-workspace envelope was rejected with `Protocol identity mismatch`.
- Browser content, application logs, repository rows, audit rows, and protocol/event evidence were checked for the disposable credential marker and Mission Agent secret; none was present. Security evidence contained bounded reason codes and paths only.
- Disposable database records and local Mission Agent credentials were removed after validation. Temporary repositories were moved to the local Trash for recoverability.

**Repository hygiene and ownership**

- `.agents/` and `agent/` were both created on 2026-07-21 as local agent-skill installations. They contain 538 HyperFrames/Codex skill instructions, references, templates, assets, and helper scripts totaling approximately 7.6 MB. Their structure and content match user-level skill installations; at least one sampled `.agents` skill is byte-identical to the corresponding user-level installation. No creation-command log was retained, so the specific installer invocation cannot be proven beyond this filesystem provenance.
- Neither tree has Git history or a tracked caller. Application source, tests, package scripts, Next configuration, Render configuration, and Docker packaging do not read them. Docker explicitly packages tracked `agents/`, which is a distinct production directory.
- Exact-root rules were added to `.gitignore`, `.prettierignore`, and ESLint global ignores for `.agents/` and `agent/`. The slash-qualified Git/Prettier rules do not exclude tracked `agents/`, `remote-agent/`, or nested production paths.
- `tests/repository-hygiene.test.mjs` verifies the ownership exclusions and proves that declared production packaging/configuration includes tracked `agents/` but contains no `.agents/` or `agent/` input. The built standalone artifact was also inspected and contained zero paths from either local tree.
- Ignoring the two local trees cannot conceal a current production input because all application, worker, packaging, and deployment roots are declared elsewhere and the release check fails if those manifests begin referencing either excluded path.

**Tracked formatting disposition**

- The six failures were ordinary source/test files, not documentation, migrations, fixtures, generated artifacts, checksum-bound content, or exact-byte material. Each was formatted with the repository Prettier configuration without changing expected values or behavior:
  - `app/api/agent-protocol/v1/publications/fail/route.ts` — application route source; formatted.
  - `app/api/recommendations/[recommendationId]/change-mission/route.ts` — application route source; formatted.
  - `app/missions/[missionId]/durable-mission-console.tsx` — application UI source; formatted.
  - `app/recommendations/[recommendationId]/recommendation-actions.tsx` — application UI source; formatted.
  - `domain/action-request.ts` — domain source; formatted.
  - `tests/recommendation.test.mjs` — unit-test source; formatted.
- No tracked file required a formatting exclusion. Published Mission Agent artifacts and migration bytes were not reformatted.

**Dependency advisory classification**

- The release updated `next` and matching `eslint-config-next` from 16.2.10 to the non-breaking 16.2.12 patch. This removes the directly reported Next.js middleware, Server Action, rewrite, cache, disclosure, and image-route framework advisories present at 16.2.10.
- The final full audit still exits 1 with 11 high package findings. None was introduced by repository registration; the baseline already used the affected ESLint/CDK/Next dependency families.
- Development-only findings:
  - `eslint` 9.39.5 is direct; `@eslint/config-array` 0.21.2, `@eslint/eslintrc` 3.3.6, `minimatch` 3.1.5, and `brace-expansion` 1.1.16 are transitive through ESLint.
  - `eslint-config-next` 16.2.12 is direct; `eslint-plugin-import` 2.32.0, `eslint-plugin-jsx-a11y` 6.10.2, and `eslint-plugin-react` 7.37.5 are transitive. Their reported effect is the same vulnerable `minimatch`/`brace-expansion` chain.
  - Additional affected `brace-expansion` copies are reached through development-only TypeScript ESLint and AWS CDK. These packages run in lint, build-validation, and infrastructure-synthesis environments, not the deployed application or Mission Agent artifact. Exploitation requires an attacker to control glob patterns supplied to those trusted tools.
  - npm offers no narrow compatible resolution: its suggested ESLint 10.8.0 is a major toolchain upgrade, and its suggested `eslint-config-next` downgrade/major resolution is incompatible with the current Next toolchain. `brace-expansion` advisories currently include the latest 5.0.7. No forced fix is authorized.
- Production findings:
  - `next` 16.2.12 is direct and production-deployed. Its remaining audit finding is solely the effect of optional transitive `sharp` 0.34.5.
  - `sharp` is an optional production dependency used by Next image optimization. The advisory is fixed in Sharp 0.35.0, a 0.x minor with potential breaking behavior; Next 16.2.12 declares `^0.34.5` and does not provide a compatible patched release. npm proposes a breaking Next downgrade rather than a safe patch.
  - Mission Control has no `next/image` import, remote-image configuration, image upload, or route that supplies attacker-controlled images to Sharp. Therefore the vulnerable libvips functionality is installed but not materially reachable in the deployed architecture. It is not part of `mission-agent-0.6.7.mjs`.
- **Named follow-up — Dependency advisory remediation.** Owner: platform/dependency maintainer assigned by the human release owner. Acceptance criteria: adopt a supported Next release that permits Sharp >=0.35.0; upgrade ESLint/config/plugins to a mutually compatible chain with a non-vulnerable brace-expansion resolution; run clean install, full audit, lint, typecheck, unit/integration/E2E, production build, image-route abuse tests, and CDK synthesis; document any remaining advisory with current reachability evidence. Until then, do not add image uploads, remote image patterns, or attacker-controlled glob inputs without a new security review.

**Validation environment and current gate status**

- Runtime: `node --version` → `v22.20.0`; `npm --version` → `10.9.3`.
- Install: `npm ci` → exit 0; 409 packages installed/audited; 11 high-severity advisories reported.
- Focused repository registration: 7/7 pass, including three failure-injection boundaries and concurrent duplicate registration.
- Repository-registration concurrency test: 10/10 independent repetitions pass; every run converged on one repository, two grants, two audit rows, and the union of both agent associations. The advisory-lock key is consistently `workspace + normalized remote` for remote repositories. No stale-state, key-collision, isolation, timing, or implementation race was observed.
- The earlier mismatch was in the separate file-backed controlled-mission advancement unit test, not repository registration. Five isolated reruns and subsequent complete suites passed without changing its assertion.
- Complete unit suite: 76/76 pass, including the two new repository-hygiene checks.
- Complete integration suite: 52/52 pass.
- Complete end-to-end suite: 2/2 pass.
- Full lint, full formatting, tracked production lint, changed-file formatting, `git diff --check`, typecheck, and production build all exit 0.
- Migration command reports `pendingMigrations: 0`; finalized migration SHA-256 is `4d2ae5760c6e33f3424aa72f10b4b277a7d4647716f4e5c2fcdc171d78c7faec`.
- Immutable artifact verification exits 0: published 0.6.6 remains 57,625 bytes with its published checksum and no diff; candidate 0.6.7 remains 57,798 bytes with checksum `0a9b08392d436521edfc0a7bef25f9cd418e9eb2c9f6b2d12893d2f6b93ef6b6`.
- Full dependency audit exits 1 with the classified 11 high findings above. Production-only audit reports two package findings (`next` as the affected parent and optional `sharp`) for one unreachable image-processing advisory chain.

### Evidence required before commit, push, merge, and deployment

- **Before commit:** reviewed diff; classification evidence; all automated results; migration assessment; secret scan; manual UI/registration evidence or an explicitly recorded reason it is pending; no unrelated files included.
- **Before push:** a human-approved release record for this exact scope, exact commit intent, clean diff review, and confirmation that Mission Agent artifact version/checksum provenance is resolved.
- **Before merge:** passing protected-branch CI, human review, human approval bound to the exact commit, completed manual validation, and rollback owner/readiness.
- **Before deployment:** explicit human production authorization bound to the merged commit/artifact; immutable application and Mission Agent checksums; successful production build; rollout/rollback operator identified; health, backup, monitoring, and post-deployment checklist ready.

### Release decision

Current decision: **ready for human approval, but not authorized for commit, push, merge, publication, or deployment; human approval pending**. Repository hygiene, formatting, artifact provenance, transactional registration, browser validation, and all required functional/quality gates are complete. The remaining dependency advisories are pre-existing, classified, not materially reachable in the deployed architecture, and assigned to the named follow-up. Codex documentation and review do not constitute human approval.

## Outcome

Evolve the deployed demo into a domain-neutral operational control plane while preserving its event-derived launch, crisis, recommendation, approval, provenance, and debrief experience. Production readiness means durable state, authenticated integrations, enforceable policy, observable execution, recovery behavior, and tested audit reconstruction—not a connected UI alone.

## Non-negotiable invariants

1. Canonical events are append-only; corrections are new events.
2. UI and operational status are rebuildable projections with no independent business state.
3. Commands validate expected aggregate version, legal transition, policy, and idempotency before append.
4. External effects originate from durable outbox/job records, never an untracked web request.
5. Simulated, controlled, fallback, and live execution are visibly distinct.
6. Raw secrets, prompts, chain-of-thought, and large artifact bodies are excluded from events and logs.
7. No autonomous financial transaction execution is introduced.
8. Every phase preserves a one-command deterministic demo path and stops for review.

## Phase 0 — Audit and architecture (complete)

### Delivered

- Repository and runtime audit: `docs/PRODUCTION_GAP_ANALYSIS.md`.
- Four-plane architecture, domain model, event catalog, execution protocol, state machines, persistence proposal, threat model, and migration strategy: `docs/PRODUCTION_ARCHITECTURE.md`.
- This phased executable plan.
- Root Codex instructions updated for the production-planning gate.

### Validation evidence

- Typecheck passed.
- 8/8 automated tests passed.
- Production build passed.
- Local launch page, health endpoint, and mission creation passed.
- Production dependency audit reported zero vulnerabilities.
- Lint gate is broken and recorded as Phase 1 bootstrap work.

### Review gate — passed 2026-07-18

Approved: modular monolith, PostgreSQL authority, transactional outbox and database-backed jobs, workspace-aware schema, single-user secure Phase 1 authentication, indefinite domain-event retention, local/S3-compatible artifact abstraction, one-way DynamoDB import, and an external Codex worker boundary. Phase 2 execution dispatch remains out of scope.

## Phase 1 — Durable domain core

**Completion:** Accepted implementation evidence is recorded in `docs/PHASE_1_COMPLETION_REPORT.md`. All ten vertical slices are complete. No Phase 2 external adapter work has begun.

**Goal:** Run the existing mock demo on production-grade events, explicit state machines, and rebuildable read models.

### Reviewable vertical slices and commit boundaries

1. **Validation baseline:** Node 22 declarations, Prettier check, supported ESLint flat configuration, CI validation workflow.
2. **PostgreSQL foundation:** Docker Compose, database client, migration runner, ordered migrations, reset-safe development instructions.
3. **Workspace and authentication:** seeded default workspace/user/membership, signed secure session cookie, owner/member authorization helpers, server-side workspace enforcement.
4. **Event store:** v2 envelope, atomic multi-event append, aggregate head/version constraint, global position, command idempotency, typed concurrency conflict.
5. **State machines:** authoritative Mission and Task transitions, dependency readiness, idempotent command handlers, terminal protection.
6. **Projections:** transactional mission/task projections, query APIs, projector version/checkpoints, UI reads from projections rather than React reconstruction.
7. **Outbox and internal jobs:** event/outbox atomicity, leased database jobs, bounded retries, dead-letter state, graceful worker shutdown and health/readiness.
8. **Replay and artifacts:** resumable/restartable projection rebuild, artifact metadata and local storage provider with checksum/integrity verification.
9. **DynamoDB compatibility:** idempotent one-way import CLI, legacy envelope translation, source metadata, incompatibility report, removal plan.
10. **Demo cutover:** versioned mock template and PostgreSQL-backed existing demo, golden projection/browser regression, operational docs and Phase 1 report.

### Durable browser route migration — approved 2026-07-18

| Browser-facing path                                                       | Slice disposition                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`, `/logout`, `/api/auth/*`                                        | Migrated to PostgreSQL-backed owner authentication and server-validated sessions.                                                                                                         |
| `/` mission launch                                                        | Migrated to authenticated durable creation; retains the existing visual launch treatment.                                                                                                 |
| `GET/POST /api/missions`                                                  | One production list/create API backed by workspace-scoped projections and `CreateMission`. Legacy creation is removed.                                                                    |
| `/missions`                                                               | New durable projection-backed mission list ordered by `updated_at`.                                                                                                                       |
| `/missions/:missionId`                                                    | Migrated to PostgreSQL mission projection plus browser-safe PostgreSQL timeline. Clearly labeled `Simulated execution`.                                                                   |
| `/api/missions/:missionId/events`                                         | Migrated to authenticated, workspace-scoped safe timeline query. Raw legacy event responses are removed.                                                                                  |
| `/api/missions/:missionId/{plan,start,pause,resume,complete,fail,cancel}` | Explicit authenticated command endpoints with version checks and typed errors.                                                                                                            |
| `/api/missions/:missionId/advance`, `/approve`                            | Removed from the browser surface; browser-timer authority is prohibited.                                                                                                                  |
| Legacy `mission-console.tsx`                                              | Removed after durable detail controls replace it.                                                                                                                                         |
| JSONL/DynamoDB demo event adapters                                        | Temporarily retained only for compatibility tests and the one-way import slice; inaccessible from main production navigation. Tracked for removal after import compatibility is complete. |
| Hard-coded demo debrief and ServicePilot preview                          | Preview remains isolated demo evidence; the hard-coded mission debrief is removed from the durable mission path. A future debrief must derive from recorded events.                       |

All lifecycle activity in this slice is manual and server-authoritative. It is explicitly presented as simulated execution; no connected agent is implied.

### Schema outline

All tenant-owned tables include `workspace_id`. Domain events have no routine deletion policy.

| Table                                                     | Purpose / key constraints                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspaces`                                              | Default workspace and future isolation boundary.                                                                                                 |
| `users`, `workspace_memberships`                          | One Phase 1 user; unique membership and `owner`/`member` role.                                                                                   |
| `events`                                                  | Global `position`; unique `event_id`; unique `(workspace_id, aggregate_type, aggregate_id, aggregate_version)`; versioned JSON payload/metadata. |
| `aggregate_heads`                                         | Current version per workspace aggregate; locked during append.                                                                                   |
| `commands`                                                | Unique workspace/idempotency key with result event IDs and status.                                                                               |
| `outbox`                                                  | Effect/consumer intent committed with events; unique idempotency key.                                                                            |
| `projection_checkpoints`                                  | Projector name/version, last global position, rebuild state/error.                                                                               |
| `mission_projections`                                     | Transactional, rebuildable mission read model.                                                                                                   |
| `task_projections`, `task_dependencies`                   | Transactional, rebuildable task state and dependency graph.                                                                                      |
| `execution_projections`, `approval_projections`, `agents` | Workspace-aware Phase 1 schema foundation; execution behavior remains deferred.                                                                  |
| `jobs`, `dead_letters`                                    | Internal leased jobs, attempts, backoff, failure visibility.                                                                                     |
| `artifacts`                                               | Metadata/checksum/object reference only; large content stays outside PostgreSQL/events.                                                          |
| `webhook_deliveries`, `idempotency_records`               | Schema foundation for later authenticated adapters.                                                                                              |

### Migration order

1. Extensions/enums and identity/workspace tables.
2. Canonical events, aggregate heads, commands, and idempotency constraints.
3. Mission/task projections and dependency edges.
4. Outbox, jobs, dead letters, and projection checkpoints.
5. Agent/execution/approval/webhook projection foundations.
6. Artifact metadata.
7. Seed the default workspace, single user, membership, templates, and deterministic demo data through an idempotent seed command.

Migrations are forward-only in production. Development reset is explicit and never targets an unresolved database. Rollback is an application-version rollback plus a compatible forward migration when data has already been committed.

### Event-store API

```ts
interface ProductionEventStore {
  append(input: {
    workspaceId: string;
    aggregateType: string;
    aggregateId: string;
    expectedVersion: number;
    commandId: string;
    correlationId: string;
    causationId?: string;
    actor: { type: "human" | "agent" | "system" | "scheduler"; id: string };
    events: NewDomainEvent[];
    outbox?: NewOutboxMessage[];
  }): Promise<AppendResult>;
  readAggregate(query: AggregateQuery): Promise<DomainEvent[]>;
  readMission(query: MissionEventQuery): Promise<DomainEvent[]>;
  readAll(query: GlobalEventQuery): Promise<DomainEventPage>;
}
```

An incorrect `expectedVersion` throws a typed conflict and appends nothing. A repeated `commandId` returns the stored result. Database uniqueness is authoritative.

### Projection strategy

- Mission and Task projections are updated **transactionally** with canonical append during Phase 1.
- Outbox delivery and future operational consumers are **asynchronous**.
- Every projection is **rebuildable** by a deterministic projector from global event position zero.
- Rebuild uses a named projector version, shadow/rebuild state, checkpoints, and idempotent upserts. A failed rebuild may resume from its committed checkpoint or restart after clearing only its isolated rebuild target.
- UI query routes read projection tables. React owns presentation and ephemeral interaction state only.

### Authentication choice

Phase 1 uses one environment-configured user authenticated by a server-validated password and a signed, `HttpOnly`, `Secure` (in production), `SameSite=Lax` session cookie with bounded lifetime and key rotation support. The user belongs to one automatically seeded default workspace. Authorization helpers require an active owner/member membership on every command and query. Password and session secrets come from the secret provider/environment and never enter domain events or tables. Multi-user OIDC, invitations, SSO, and advanced RBAC are deferred.

### Artifact storage

The `ArtifactStore` port supports write, metadata lookup, authorized download reference, temporary deletion, and SHA-256 integrity verification. Local files use a configurable directory outside the repository. Production uses an S3-compatible provider. PostgreSQL stores only workspace/mission/task/execution references, provider/key, media type, byte size, checksum, provenance, and lifecycle metadata.

### Database-backed job boundary

Phase 1 jobs are internal only: projection processing/rebuild, outbox processing, and failed-job detection. Workers use leases, bounded attempts, jittered backoff, correlation IDs, dead letters, graceful shutdown, and separate liveness/readiness. No job may start Codex or another external agent during Phase 1.

### DynamoDB migration approach

Provide an explicit CLI that reads legacy mission events through the existing DynamoDB adapter, translates supported `1.0` demo events into the v2 envelope, preserves safe IDs/timestamps, adds `metadata.importSource = "dynamodb-demo-v1"`, and appends with a stable import command ID. Repeated imports are idempotent. Unsupported records are reported and skipped without partial aggregate corruption. There is no dual write or continuous synchronization. After an agreed compatibility window, retain an export and remove DynamoDB application reads/infrastructure in a separately approved migration.

### Known risks

- Introducing PostgreSQL into the current DynamoDB deployment changes operating cost and recovery procedures.
- Legacy demo event meanings are message-dependent and may not map cleanly to normalized production events.
- Transactional projectors can lengthen append latency or couple schema rollout to event rollout.
- Cookie authentication is intentionally narrow and must not become an accidental long-term identity platform.
- A local filesystem artifact provider is single-host only and must never be selected in horizontally scaled production.
- Demo pacing currently depends on browser timers and must move to deterministic mock jobs without changing the judge-facing rhythm.
- The repository currently runs under Node 20 locally; all acceptance evidence must be regenerated under Node 22.

### Phase 1 acceptance tests

1. PostgreSQL mission and projections survive web and worker restart.
2. Empty-state replay reconstructs the complete mission/task projections.
3. Repeated command ID produces no duplicate event/outbox outcome.
4. Two appends at one expected version yield one success and one typed conflict.
5. Illegal Mission/Task transitions append nothing.
6. Completing a dependency changes a blocked dependent task to ready through canonical events.
7. Workspace A cannot query or command Workspace B data.
8. Applicable events and outbox records commit or roll back together.
9. Failed projection rebuild resumes or restarts without corrupting the active projection.
10. Existing launch → recommendation → approval → debrief flow runs from PostgreSQL-backed state.
11. Terminal aggregates reject later mutation except explicitly modeled correction/audit commands.
12. Artifact write/read/download/delete/integrity behavior is workspace-authorized and checksum-verified.

### Proposed scope

1. Repair toolchain baseline: enforce Node 22, replace broken lint command, add format/lint/typecheck/test/build CI gates.
2. Add PostgreSQL migrations for events, aggregate heads, commands, outbox, projection checkpoints, jobs/dead letters, and initial projections.
3. Implement v2 event envelope, schema registry, legacy demo upcasters/projector, optimistic aggregate append, and command idempotency.
4. Implement Mission, Task, and Execution transition tables plus dependency readiness.
5. Add projection runner, checkpointing, seed command, rebuild command, and equality checks.
6. Convert the controlled Stripe flow into `demo-stripe-billing@1` using a deterministic mock adapter and controllable clock.
7. Switch the demo behind a feature flag only after golden event/projection and browser regression tests pass.

### Files/systems expected to change

Domain/application/event modules, database schema and migration tooling, event-store adapters, mock template/adapter, route command boundary, tests, CI, environment documentation, and deployment database configuration. Experience styling should not materially change.

### Compatibility and migration risks

- Legacy `1.0` demo events must remain readable.
- Existing DynamoDB mission links need an explicit retention/read-only decision.
- PostgreSQL cutover must not duplicate commands or effects.
- Projector changes can alter visible demo state; golden snapshots and browser tests are mandatory.

### Acceptance criteria

- Fresh database migration and seed complete with documented commands.
- Every task/execution transition accepts legal moves and rejects illegal moves in unit tests.
- Concurrent commands yield one aggregate version sequence and one idempotent result.
- Dropping all projections and rebuilding produces identical checksums and visible demo state.
- Process restart at every demo phase does not lose or duplicate progress.
- Full deterministic demo completes with the same truth labels and no browser-timer authority.
- Formatting, lint, typecheck, unit/integration tests, build, and dependency audit pass.

### Stop report

State what is real, mocked, incomplete, and deferred; list migrations and rollback; provide demo regression evidence; stop for review.

## Phase 2 — Real agent execution

**Goal:** Dispatch and supervise real external work through durable, authenticated adapter boundaries.

**Authorized vertical slice:** One bounded software-engineering task against a registered noncritical repository, executed by a real Codex CLI in a generated Git worktree. Local edits, declared tests, artifact collection, and a local commit are permitted. Push, PR creation, merge, deployment, destructive commands, infrastructure modification, secrets access, Hermes, public webhooks, DeFi, and multi-agent live execution are excluded. Detailed decisions: `docs/PHASE_2_CODEX_EXECUTION.md`.

### Reviewable implementation slices

1. Architecture and protocol documents.
2. Workspace-scoped agent and repository registries.
3. Execution aggregate, transactional projection, and task coordination.
4. Runtime-validated protocol 1.0.
5. Realpath repository guard, worktree manager, and safe process runner.
6. Codex adapter command-line vertical slice.
7. Leased Codex worker, operational heartbeats, recovery, cancellation, timeout, and failure classification.
8. Checksummed local artifacts and execution evidence.
9. Owner agent/repository management and live execution browser UI.
10. Restart, safety, projection replay, integration, real acceptance, and completion report.

### Phase 2 invariants

- Codex-specific logic stays in registry, adapter, worker, protocol translation, artifact, and runtime-security modules.
- The adapter never edits Mission, Task, Approval, or projection rows directly.
- Browser input references repository IDs only; paths and branches are resolved from owner-managed policy.
- Every live execution uses a unique generated branch/worktree and preserves it for review.
- Full prompts, transcripts, diffs, and logs are artifact bodies, not event payloads.
- No execution can push, merge, deploy, access secrets, or expand permissions autonomously.
- `mock` and `codex` remain visibly and operationally distinct.

### Proposed scope

1. Add agent registry, capabilities, trust, concurrency, configuration and credential references.
2. Implement adapter port plus `mock` and signed `webhook` adapters.
3. Add durable dispatch/delivery/poll/heartbeat/timeout/retry/cancel jobs with leases, backoff, and dead letters.
4. Add authenticated protocol endpoints for acceptance, heartbeat, progress, artifact, completion, failure, and cancellation.
5. Add per-agent credentials/signatures, timestamp/replay protection, schema/size validation, and execution authorization.
6. Add operational execution and delivery projections while retaining the existing Mission Log presentation.

### Acceptance criteria

- A ready task is dispatched once logically under duplicate job delivery.
- Duplicate callbacks return the original result and append no duplicate event.
- Invalid signature, stale timestamp, wrong agent/execution, schema violation, and illegal transition are rejected and audited safely.
- Stale heartbeat produces deterministic timeout/health evidence; a retry creates a new attempt.
- Pause, cancel, manual retry, and reassign survive worker and web restarts.
- Dead-lettered work is visible and recoverable by an authorized operator.
- Mock-adapter software mission succeeds end to end without arbitrary sleeps.

### Stop report

Demonstrate worker termination/recovery and callback replay tests; stop for review before policy-driven sensitive actions.

## Phase 3 — Human identity, approvals, and policy

**Goal:** Make human and agent authority enforceable and auditable.

**Authorized vertical slice:** Deterministic versioned policy, durable parameter-bound action requests and approvals, approval-gated push of the exact generated execution branch, separately approved pull-request creation, operational budgets, approval inbox, and workspace audit history. Merge, deployment, secrets, destructive production changes, infrastructure modification, and financial/blockchain actions remain permanently denied. Detailed decisions: `docs/PHASE_3_POLICY_APPROVALS.md`.

### Proposed scope

1. Add OIDC authentication, workspaces, initial roles, ownership checks, secure sessions/headers, CSRF and rate limiting.
2. Add versioned deterministic policy engine and credential-provider abstraction.
3. Add approval request, grant, deny, expire, and stale-decision behavior bound to exact action/evidence/version.
4. Build approval inbox and evidence view from projections.
5. Add software, systems, and DeFi analysis-only default policies.

### Acceptance criteria

- Cross-workspace read/command attempts fail in API and integration tests.
- UI hiding is never the enforcement boundary.
- Merge/deploy/destructive requests cannot dispatch without a valid, unexpired, parameter-bound approval.
- Approval denial and expiration append audit events and prevent action.
- Changed action parameters make an earlier approval stale.
- DeFi signing/submission is denied even when an approval is attempted.
- No credential value is stored in domain tables, events, or logs.

### Stop report

Provide threat-model test evidence and policy matrix; stop for security review.

## Phase 4 — Generic authenticated remote agents

**Goal:** Coordinate Hermes and Codex through the same domain-neutral execution authority while adding no financial, production, merge, deployment, secret, or unrestricted-command authority.

**Architecture:** `docs/PHASE_4_REMOTE_AGENTS.md` defines the trust model, signed protocol 1.0, durable delivery, callbacks, capabilities, health, artifacts, approvals, recovery, Hermes bridge, deployment shape, threat model, and migration.

### First reporting boundary

1. Owner registers Hermes and receives a credential exactly once.
2. Signed protocol messages pass schema, timestamp, nonce, message, credential, workspace, and constant-time signature validation.
3. Hermes advertises capabilities and heartbeats.
4. An execution request is committed with a durable outbox delivery.
5. Hermes separately accepts, reports progress, submits one checksummed Markdown artifact, and completes.
6. Duplicate messages are idempotent; nonce replay and changed-payload message reuse are rejected and audited.

### Remaining Phase 4 slices

1. Deterministic capability/resource/policy/concurrency assignment and health calculation.
2. Remote approval request and decision delivery for analysis/workflow decisions only.
3. Remote supervision and credential rotation UI.
4. Genuine operational-health Hermes mission and restart recovery.
5. Read-only DeFi analysis with signing/submission absent and denied.
6. Mixed Hermes analysis and Codex implementation mission with separate push and PR approvals.
7. Full security, recovery, projection rebuild, browser, and operational validation.

### Completion status

Phase 4 implementation and genuine DeFi/mixed-agent acceptance completed on 2026-07-18. Credential lifecycle, deterministic health and eligibility, separate resource grants, durable remote approvals, browser supervision, analysis-only DeFi, and a Hermes-to-Codex handoff are operational. The exact Codex commit was pushed after a separate approval. PR creation remained safely unperformed because GitHub rejected the fixture branch's unrelated history; no history rewrite or authority expansion was attempted. See `docs/PHASE_4_COMPLETION_REPORT.md` and `docs/PHASE_4_OPERATIONS.md`.

### Acceptance criteria

- At least one genuine Hermes execution and one mixed Hermes/Codex mission use the generic protocol and existing aggregates.
- HTTP acknowledgement records delivery only; an authenticated protocol message records acceptance.
- Restart and duplicate delivery/callback tests preserve one coherent execution and artifact set.
- Agent availability is calculated by Mission Control from heartbeat, delivery, failure, saturation, credential, and disablement evidence.
- All visible remote state and audit history rebuild from canonical events; operational rate/nonce/delivery records remain bounded infrastructure state.
- DeFi tasks are analysis only, and transaction signing/submission remain structurally absent and policy denied.

### Stop report

Report at the first vertical-slice boundary, then complete DeFi, mixed-agent, UI, recovery, and full validation. Stop before transaction signing, production remediation, merge, deployment, or secret access.

## Phase 5 — Scheduling and operational workflows

**Goal:** Prove the core is domain-neutral through safe templates and scheduled mission instances.

**Authorized scope:** Versioned immutable mission templates, timezone-aware one-time/recurring schedules, leased idempotent scheduler runs, durable notifications, evidence-based usage/cost, projection-backed daily operations, safe recovery controls, worker readiness, and production operations documentation. All scheduled and manual launches use the existing command, eligibility, resource, policy, approval, and audit paths. Detailed decisions: `docs/PHASE_5_OPERATIONS.md`.

### First reporting boundary

1. Publish five initial template version 1 definitions with registered-resource input validation.
2. Launch immutable mission/task snapshots from an exact template version.
3. Create one-time and recurring schedules with explicit timezone, concurrency, and missed-run policy.
4. Run a dedicated leased scheduler using deterministic run keys.
5. Complete one scheduled Hermes health report and produce an in-app notification.
6. Restart the scheduler and prove no duplicate mission or notification.
7. Rebuild and verify template, schedule, mission, and notification projections.

### First-boundary status

Completed on 2026-07-19. Five published templates, immutable version snapshots, durable one-time and recurring schedules, leased deterministic schedule runs, the genuine scheduled Hermes health report, in-app completion notification, restart idempotency, and projection rebuild equality are demonstrated. See `docs/PHASE_5_FIRST_BOUNDARY.md`.

### Proposed scope

1. Add immutable template versions for software delivery, DeFi analysis, and systems monitoring.
2. Add one-time/recurring schedules, time zones, disabled/manual modes, concurrency, and missed-run policy.
3. Add deterministic health from heartbeat, failure, critical path, approval age, budget, deadline, availability, and retry evidence.
4. Add usage/cost projections, agent heartbeat/detail, artifact viewer, and failed-job operations UI.

### Acceptance criteria

- Each schedule trigger creates a new mission instance and never mutates a permanent mission.
- Concurrent/missed runs follow configured policy under clock-controlled tests.
- DeFi analysis ends with simulation/recommendation and contains no transaction execution path.
- Monitoring mission detects a fixture anomaly, gates sensitive remediation, verifies recovery, and emits an incident debrief.
- Mission debrief values are computed exclusively from recorded evidence.
- Cost/usage totals reconcile to execution events and omit sensitive content.

### Stop report

Show all three templates on the same orchestration core; stop before broad adapter or marketplace expansion.

### Completion status

Phase 5 completed on 2026-07-19. Mission Control now provides bounded schedule concurrency/recovery, lifecycle and run-now controls, preferences and durable external notifications, evidence-classified usage/cost, deterministic budgets, worker health/readiness, dead-letter recovery, an attention-first operations dashboard, safe search and saved views, deterministic anomalies with remediation denial, bounded retention, restore validation, and production operations documentation. Full Node 22, PostgreSQL, worker restart, projection rebuild, and browser validation passed. See `docs/PHASE_5_COMPLETION_REPORT.md`.

## Phase 6 — Production launch and daily adoption

**Goal:** Deploy the existing modular monolith as the owner's daily control plane without expanding agent authority.

**Authorized topology:** Render web plus seven long-running workers, human-created Render PostgreSQL, Cloudflare R2 durable artifacts, one independent uptime monitor, and one approved external notification destination. Auto-deploy remains off; exact reviewed production commits are deployed manually. The Codex worker is isolated with temporary persistent worktrees, while durable output is copied to R2.

**Pre-provider boundary status:** Production hardening, migration safeguards, owner provisioning, object storage, readiness, security headers, durable emergency controls, Blueprint, provider checklist, environment manifest, rollout/rollback procedure, runbooks, and acceptance log are implemented. Provider resources remain untouched pending human selections in `docs/PHASE_6_PROVIDER_INPUTS.md`.

**Permanent authority boundary:** Mission Control agents cannot deploy, merge, remediate production autonomously, modify arbitrary infrastructure or secrets, sign/submit blockchain transactions, move assets, or modify DeFi positions. Git push and PR creation remain separately approval-gated.

**Next boundary:** After human provider configuration, migrate production, provision owner, verify R2, deploy web/workers, validate login/Operations/monitoring/Hermes/emergency controls, then onboard one safe repository and begin the minimum seven-day acceptance period.

## Adoption milestone — First agent to first mission

**Goal:** Remove documentation and Agent Registry from the first-run path so a new owner can reach a verified agent heartbeat and a preselected first mission without product knowledge.

**Authorized first boundary:** Guided onboarding creates a workspace-scoped remote identity and one-time credential, presents one copyable command, installs the credential locally with owner-only permissions, starts a signed protocol 1.0 heartbeat, detects that heartbeat in the browser, and advances directly to a small read-only first mission. The Agent Registry remains a post-connection management surface. The connector does not gain merge, deployment, infrastructure, secret, signing, submission, or other prohibited authority.

**Canonical events and projections:** `agent.registered`, `agent.credential_created`, `agent.heartbeat_received`, and `agent.credential_verified` remain the canonical history. The existing agent projection supplies onboarding status; the wizard owns only ephemeral selection, copy, loading, and polling state. Replaying agent events must continue to reconstruct the visible connection state.

**Acceptance criteria:**

1. A new owner chooses Codex, Hermes, Claude Code, or Generic Remote Agent without opening documentation.
2. One command stores the displayed-once credential with owner-only permissions and starts the connector heartbeat.
3. The browser observes the authenticated heartbeat and advances automatically.
4. Generic agents can reveal their prefilled endpoint, credential identifier, protocol version, and test command.
5. The next primary action is a preselected, read-only first mission; the Agent Registry is secondary.
6. Existing protocol signature, replay, workspace-isolation, capability, policy, and permanent action prohibitions remain enforced.

**Deferred from the first boundary:** A distributable npm package, OS service management, inbound work polling for machines without public callbacks, and fully automatic Codex/Hermes/Claude execution. These must be delivered before claiming that the connected agent completed the first mission.

### Pull-based Mission Agent boundary — approved 2026-07-19

Mission Agent is the outbound-only local runtime. Pull assignments use bounded long polling and durable operational leases; canonical execution events remain business truth. Codex is the first complete adapter and is restricted to read-only repository analysis. Hermes, Claude Code, and generic adapters may connect but must clearly report that local execution is not yet supported. See `docs/MISSION_AGENT_PROTOCOL.md` for the protocol, threat model, recovery semantics, and rollback.

Completion requires a fresh production user to connect behind NAT, confirm pull readiness, register a safe local repository, launch the starter analysis mission, observe live progress, receive a genuine Markdown artifact, restart without duplicate work, revoke access, and reconnect. The hackathon evidence package begins only after this acceptance succeeds.

### Repository Change Missions — approved 2026-07-20

**Goal:** Turn the proven read-only repository analysis into an approval-gated implementation workflow without expanding Mission Control's permanent authority.

**Boundary:** A user selects Change Repository, supplies an editable objective, acceptance criteria, and optional allowlisted validation commands. Codex first creates a read-only implementation plan. Mission Control then requires an explicit `repository.modify` approval before the local Mission Agent creates an isolated `mission/*` branch and Git worktree. Codex may modify only that worktree. The runtime gathers validation output and diff evidence, creates one local commit, and stops at human review.

**Permanent prohibitions:** No automatic push, pull request, merge, deployment, infrastructure or secret modification, transaction signing, or transaction submission. The registered source branch and worktree must remain unchanged.

**Canonical truth:** Existing mission, task, execution, approval, progress, artifact, and completion events remain authoritative. Worktree paths, lease tokens, and restart checkpoints are bounded operational state and cannot independently authorize or complete work.

**Acceptance:** Demonstrate the plan before approval, prove no write occurs before approval, approve the exact repository/base/objective action, produce an isolated local branch and commit, show changed files/full diff/validation evidence, preserve the original branch, and recover safely from a restarted Mission Agent.

## Mission Control 0.4 — Engineering Manager

**Controlling outcome:** Make Mission Control the best place to supervise AI software engineers.

**Approved first slice — 2026-07-20:** Recommendations are canonical, persistent, evidence-linked entities with Open, Accepted, In Progress, Completed, Stale, and Dismissed lifecycle states. Repository Analysis emits structured recommendations, repository and mission views expose them, and one action creates an idempotently linked, approval-gated Repository Change Mission inheriting objective, evidence, acceptance criteria, and allowlisted validation suggestions.

**Sequence after the first slice:** Expand versioned engineering Mission Templates, add a review-before-execution Mission Planner, project an evidence-backed Mission Graph, and deepen Repository Health.

**Architecture direction:** Build Repository Knowledge rather than private Agent Memory. Repository architecture, tooling, standards, decisions, known issues, mission history, and recommendations remain durable platform knowledge that interchangeable agents consume. Every visible recommendation, graph relationship, and health claim must cite canonical evidence and rebuild from the event log and durable artifacts.

**Authority boundary:** Version 0.4 does not weaken existing approval separation. File modification, branch push, and pull-request creation remain distinct actions; merge, deployment, infrastructure/secret modification, and transaction signing/submission remain prohibited unless separately authorized in a later phase.

**First-slice acceptance:** Recommendation projections must rebuild from canonical events; source mission, execution, artifact, and evidence remain traceable; generated validation commands pass a strict allowlist; retries cannot create duplicate missions; terminal lifecycle states cannot reopen; existing Mission Agent installations remain compatible; and no recommendation can independently authorize repository modification.

## Mission Control 0.5 — Repository Intelligence

**Controlling outcome:** Make the repository—not an individual agent—the durable, explainable system of record for what happened, why it happened, and what should happen next. Implementation authorized by the product owner on 2026-07-20.

**Priority 1 — Repository Health:** Promote Repository Health into the primary daily dashboard. A versioned deterministic scoring projection may summarize test posture, architecture, security, technical debt, documentation, dependency freshness, CI, mission outcomes, and recommendation lifecycle. Every score and subscore must expose its calculation version, freshness, confidence, contributing observations, and evidence. Unknown data lowers confidence or remains unknown; it must not silently become a failing score.

**Priority 2 — Repository Timeline:** Project repository activity as mission history rather than Git history: analyses, recommendations, accepted work, change missions, validations, approvals, commits, publication, deployments, incidents, and audits. Timeline relationships must come from canonical causation, provenance, and explicit mission links. Git commits may be evidence, but are not the timeline's source of truth.

**Priority 3 — Repository Knowledge:** Create evidence-backed pages for major components such as Authentication. Knowledge connects architecture, files, tests, risks, recommendations, decisions, ownership observations, and related missions. Model-generated summaries remain attributed observations; accepted human decisions and verified execution outcomes remain distinguishable facts.

**Priority 4 — Health trends:** Record immutable, versioned health assessments so users can compare like-for-like scores over time and see which completed recommendations changed which dimensions. A completed mission does not automatically improve health: new repository evidence and the scoring rules must justify the change.

**Priority 5 — Action templates:** Offer versioned mission templates at actionable findings so common work can begin with evidence, objective, acceptance criteria, and validation already linked. Template selection cannot bypass planning, policy, or approval boundaries.

**Semantic layer direction:** Queries such as “Why is authentication designed this way?”, “Which recommendations have been ignored for 90 days?”, and “Which components generate the most technical debt?” should traverse evidence-backed repository relationships. Semantic retrieval may locate relevant records and draft an answer, but citations must resolve to canonical events, artifacts, recommendations, decisions, and outcomes. Generated prose is never an independent source of truth.

**Approved first implementation boundary:** Mission Agent emits bounded evidence-backed observations across seven health dimensions. Mission Control validates those observations, computes versioned deterministic scores, stores immutable event-derived assessment history, and projects repository-linked missions, recommendations, health assessments, and approvals into a timeline. The authenticated home becomes repository-first. Missing inputs remain unknown and reduce confidence; mission completion alone never changes health.

**Recommended smallest slice:** One repository receives a versioned explainable health assessment after analysis, a mission-and-recommendation timeline, and a before/after trend only after an evidence-producing follow-up analysis. Repository Knowledge and natural-language semantic queries should follow after those foundations are proven.

**Authority boundary:** Repository Intelligence is read, projection, and planning capability. It grants no autonomous push, pull-request, merge, deployment, infrastructure or secret modification, transaction signing, or transaction submission authority.

## Cross-phase test matrix

## Mission Agent 0.8 runtime-v3 acceptance remediation — local candidate only

**Status:** remediation and local validation in progress; no release authority. The preserved runtime-v3 result is `NO-GO — disposable-mode trust mismatch and incomplete repository registration`. Its eight passing cancellation/timeout probes are provider lifecycle evidence only, not consensus acceptance.

**Authorized development boundary:** introduce an explicit fail-closed `disposable_acceptance` runtime mode; bind an exact short-lived non-writable registry path/hash and approved packet into readiness, events, receipts, attestations, and eligibility; reject production credentials/endpoints/databases/registry authority; require authenticated `complete_repository_state/3` registration and immutable replayable snapshots; stop on mandatory exact preflight failures; and narrow the changed-model adversarial assertion. Local tests, disposable migrations/replay, unsigned rebuild, evidence collection, and independent review are permitted. Registry addition and all real-provider execution require a new exact checksum approval.

**Permanent stop boundary:** do not stage, commit, sign, publish, push, open a pull request, merge, contact or migrate production, replace Mission Agent 0.7.2, or deploy. The transitional source base `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549` is acceptable only for local disposable testing and cannot support a production-readiness claim.

**Acceptance prerequisites:** zero unresolved high and medium independent-review findings before rebuild; unit/integration/browser/migration rollback-forward/replay/secret-scan/typecheck/lint/format/syntax/build/audit/diff gates; and a new packet containing the artifact, metadata, capability manifest, provider catalogs, source template, build/discovery/acceptance harnesses, test fixture, migration/rollback, runtime-mode definition, disposable-registry schema, repository-snapshot schema, results, replay evidence, scans, review, and runtime-v3 differences.

**Runtime-v4 local packet (2026-08-05):** Remediation and local validation are complete. Final independent review reports zero high, zero medium, and one low dev-toolchain-only dependency advisory; the production dependency audit is clean. The exact candidate gate passes 8/8, full units 196/196, serial integration 93/93, consensus integration 20/20, and the remaining required local gates pass. The unsigned packet, proposed short-lived registry bytes, checksums, runtime bindings, results, replay/scanning evidence, and runtime-v3 differences are recorded in `docs/evidence/MISSION_AGENT_080_RUNTIME_V4_LOCAL_VALIDATION_2026-08-05.md`. Runtime-v4 is awaiting a new exact disposable-registry approval. It has not been added to a registry and no runtime-v4 real provider execution has occurred. This is not a production-readiness or release authorization.

**Runtime-v4 final disposition (2026-08-05):** `NO-GO — disposable repository carried prohibited push authority`. The mandatory preflight reported `ACCEPTANCE SETUP FAILURE: repository_prohibited_authority` and stopped before any runtime-v4 provider invocation. Its packet and approval may not be reused.

**Runtime-v5 repository-authority remediation (2026-08-05):** Local development and validation only; no registry or provider authority. The additive `repository-authority/1` model separates read, isolated-worktree write, Mission Agent local commit, provider-direct commit, push, PR, publication, deployment, and infrastructure mutation. An authenticated owner command, canonical event, replayable projection, and immutable receipt bind the narrow disposable profile. Mission creation, assignments and renewals, approval, child creation, mutation, local commit, and terminal success fail closed on rebinding. Existing repository rows retain their legacy permissions through compatibility mapping; production permissions are not retroactively revoked. A new unsigned packet and proposed inactive registry require zero unresolved high/medium review findings and fresh exact human approval before registry addition or real-provider execution.

**Runtime-v5 local packet (2026-08-05):** Remediation, exact-source binding, and local validation are complete. Independent review reports zero unresolved high and zero unresolved medium findings. Exact candidate units pass 197/197, serial integration passes 95/95, consensus integration passes 22/22, browser acceptance passes 2/2, both migrations roll back and reapply with zero pending, and build/static/security gates pass with the documented low residuals. The complete unsigned packet and inactive 23-hour registry proposal are recorded in `docs/evidence/MISSION_AGENT_080_RUNTIME_V5_LOCAL_VALIDATION_2026-08-05.md`. No registry addition or real-provider invocation has occurred. Fresh exact human approval is required; this is not production readiness or release authority.

## Routine governed release — Mission archive filters and repository overview

**Release:** `R_2026_07_30_REPOSITORY_OVERVIEW_UI`

**Status:** Deployed and verified on 2026-07-30

**Production base:** `a4b873c540c1da6a271571e47d523285d4c129dc`

This routine application release may change only authenticated navigation, the mission archive filter presentation, a
workspace-scoped repository overview, confidence-score disclosure, a link target on the existing repository evidence
section, focused UI tests, and release documentation. It does not change mission search semantics, repository
registration commands, repository identity, health scoring, authorization, Project Brain, Mission Agent, database
schema, signing, release authority, or infrastructure.

Acceptance requires the search field to remain unchanged; Status, Origin, and Cost to share one collapsible row; all
active repositories to appear only for the authenticated workspace; each repository to link to its existing detail
page; Add repository to present the governed Mission Agent registration path; score disclosure to show only canonical
assessment dimensions and confidence; responsive browser validation; and all current release gates. Rollback is
application-only and must preserve every repository, assessment, recommendation, mission, event, receipt, grant, agent,
and Project Brain record. Detailed evidence is recorded in
`docs/release/R_2026_07_30_REPOSITORY_OVERVIEW_UI.md`.

## Mission Control 0.5 — Delivery Authority Expansion

**Approved first boundary:** `Publish for Review` combines the exact approved mission-branch push and evidence-rich pull-request creation into one human approval. The binding includes repository/remote identity, base branch/commit, mission branch, local commit, diff evidence, objective, acceptance criteria, validation evidence, and action hash. Any mismatch stops publication; force push and protected-branch push are prohibited.

**Execution topology:** Mission Agent 0.6 performs only the exact commit push from its retained isolated worktree over its signed outbound pull channel. Mission Control keeps provider credentials server-side, creates/confirms the pull request, and records branch, PR number/URL, head SHA, and evidence checksum in the event-backed action result.

**Still disabled:** Merge, deployment, infrastructure/secret modification, transaction signing/submission, CI/review bypass, and any additional repository modification. Review agents may recommend a merge but cannot authorize it. Merge and deployment schemas are documented architecture only.

**Acceptance:** Use a disposable GitHub repository to prove one approval, exact branch/commit publication, complete PR evidence, stale/mismatched approval invalidation, no-force/no-default-branch enforcement, retry/restart idempotency, and projection rebuild.

## Mission Control 0.7 — Review and Merge

**0.6 gate completed — 2026-07-21:** Production accepted repository registration, analysis, health, recommendations, recommendation-linked change, planning, write approval, isolated implementation, validation, exact local commit, separately approved publication, exact GitHub PR head verification, restart recovery, and full projection equality. Evidence and friction are recorded in `docs/MISSION_CONTROL_0_6_PRODUCTION_ACCEPTANCE.md`.

**Authorized 0.7 boundary:** Add independent exact-revision PR review, first-class findings, idempotent finding-linked fix missions, controlled incremental PR updates, fail-closed CI/policy/readiness verification, and one separate exact approval-bound merge. Any revision or readiness change invalidates approval. Deployment, force operations, protection/admin bypass, default-branch writes, infrastructure/secrets, and transactions remain denied.

**Design:** `docs/MISSION_CONTROL_0_7_REVIEW_AND_MERGE.md` is controlling for aggregate boundaries, role separation, stale semantics, merge binding, provider credentials, recovery, and intentionally unsupported behavior.

## Cross-phase test matrix

## Routine governed release — Project Brain mission controls layout

**Release:** `R_2026_07_30_PROJECT_BRAIN_CONTROLS_UI`

**Status:** Human approved for commit, push, merge, and deployment on 2026-07-30

**Production base:** `a4ea9abec3248224e2be60e2057df1f45e55bdb0`

This release may change only the mission-page Project Brain control markup and its presentation styles. It groups the
existing server actions into a centered, responsive control panel without changing Project Brain operations, approval
requirements, event authority, repository permissions, Mission Agent, Project Brain worker, database schema, signing,
or deployment infrastructure. Acceptance requires formatting, lint, typecheck, production build, focused Project Brain
tests, complete current test gates, responsive rendered-page validation, and a web-only rollout with application-only
rollback. Detailed evidence is recorded in `docs/release/R_2026_07_30_PROJECT_BRAIN_CONTROLS_UI.md`.

- Unit: transitions, dependency resolution, policy, health, retry classification, schemas, serialization.
- Integration: append/projection, command idempotency, dispatch/outbox, callback auth/replay, approvals, rebuild.
- End to end: success, retry, heartbeat timeout, approve, deny, reassign, DeFi stop boundary, scheduled monitoring run.
- Operational: web/worker termination, expired lease, dead letter/recovery, migration rollback, backup/restore, projection shadow rebuild.
- Experience: golden demo at target viewport, accessibility, refresh at each phase, truth-label/provenance checks.

Tests use controllable clocks and deterministic adapters; arbitrary sleeps are prohibited.

## Phase working method

Before each phase, present exact scope, files/systems, migrations, compatibility risks, and rollback. Implement the smallest complete vertical slice, run every relevant gate, report real/mocked/incomplete/deferred behavior, make one reviewable phase commit only when requested, and stop for approval. Architectural changes update the source-of-truth documents in the same phase.
