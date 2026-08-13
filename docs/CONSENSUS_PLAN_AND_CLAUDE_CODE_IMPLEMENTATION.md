# Consensus Plan and Claude Code — Implementation and Threat-Model Note

**Status:** Implementation authorized; security-sensitive production release approved in `docs/release/R_2026_08_13_RUNTIME_V6_CONSENSUS.md`
**Date:** 2026-08-04
**Authoritative production baseline:** `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`
**Release record:** `R-2026-08-04-CONSENSUS-CLAUDE` in `PLANS.md`

## Boundary

This phase adds the planning-only `CONSENSUS_PLAN` mission type and first-class `claude_code` provider support without creating another orchestrator or another trust path. Mission Control remains authoritative for mission, task, execution, approval, policy, event, artifact, usage, and projection state. Agents submit bounded facts and artifacts; they never advance consensus state directly.

The implementation mission is always a separate existing governed Repository Change Mission. The single consensus approval is an exact `repository.modify` action: it binds the canonical plan, repository snapshot/base branch/base commit, context, preferred executor/model, and permits only isolated-worktree creation, repository write, declared validation, and one local commit. It permanently prohibits push, pull-request creation, merge, and deployment. Ordinary non-consensus Change Missions retain their existing separate write-approval flow.

## Development remediation status

The original static review findings were addressed, but real-provider acceptance and the repeated independent review exposed additional release-blocking runtime, model-verification, redaction, provenance, and adversarial-harness findings. The provider-runtime contract work below is a new development revision. It is not yet accepted and is not a production-readiness claim.

The runtime-v2 disposable acceptance is also permanently **NO-GO**: canonical objection identity diverged between live application and replay, and ten expired raw lease bearer tokens were retained in disposable protocol receipts. The preserved record is `docs/evidence/MISSION_AGENT_080_RUNTIME_V2_ACCEPTANCE_NO_GO_2026-08-05.md`. Corrected source uses deterministic Mission Control objection IDs, event-only projector inputs, structurally secret-free receipt v2 records, and ephemeral-only lease tokens. Any rebuilt artifact is a new packet requiring a new exact approval.

| Finding                         | Development resolution                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate approval path         | The exact consensus grant is the only child mutation authority. It binds the deterministic child, plan, repository/snapshot, executor agent/provider/model/assignment/attestation, permission profile, execution budget, exact validation commands, effects, and prohibitions. Retries cannot request a generic second approval.                                          |
| Weak child-success evidence     | Success requires exactly one complete plan, patch, validation, and summary artifact plus base/result commits, exact execution bindings, governed validation identities, active lease/fence, and one immutable authenticated validation receipt.                                                                                                                           |
| Local credential/home isolation | macOS `sandbox-exec` denies unrelated homes, repositories, volumes, and host temporary paths. Codex gets only an assignment-private read-only symlink to exact `auth.json` bytes; Claude gets only an in-memory token brokered by exact service/account/keychain binding before sandbox entry. Both use assignment-private HOME/TMP and exact installation/runtime reads. |
| Wall-clock timeout              | Every real provider launch has an authoritative deadline, terminates the process group, revokes/fences the attempt, redacts bounded diagnostics, and rejects delayed output.                                                                                                                                                                                              |
| Cancellation semantics          | Cancellation is distinct from failure. Initial planner failure atomically fences both outputs before sibling cancellation; late progress/artifacts/success are rejected, while distinct failure/cancellation evidence and usage remain durable. Provider process groups use bounded SIGTERM/SIGKILL cleanup.                                                              |
| Continuous authorization        | Pull, claim, acknowledgement, lease renewal, message receipt, and release revalidate approval/version, current unexpired attestation, exact provider/model/role/operations, artifact/hash, repository/snapshot, permissions, local credential availability, workspace, and cancellation.                                                                                  |
| Crash-safe validation evidence  | Recovery never treats a clean descendant commit as success. Missing or invalid durable evidence moves to `recovery_review_required`; only a complete authenticated receipt can reconstruct success.                                                                                                                                                                       |
| Attestation expiry              | Immutable queryable attestations carry expiry/revocation/current status and are checked at creation, advancement, claim, renewal, message, and release.                                                                                                                                                                                                                   |
| Execution-heartbeat expiry      | Governance maintenance expires the attempt, revokes the assignment lease, and advances the bounded failure path.                                                                                                                                                                                                                                                          |
| Revision provenance             | Each revision stores queryable proposal, opposite critique, assignment, provider/model, snapshot/context, round, and prior-revision provenance with immutable checks.                                                                                                                                                                                                     |

## Existing components to reuse

- `mission` aggregate and `mission_projections` remain the parent lifecycle and archive identity.
- Existing Task and Execution aggregates represent each bounded planner or synthesizer turn. Retry creates a new Execution attempt; it never rewinds a prior result.
- `remote_http` plus pull-mode Mission Agent remains the only Claude Code registration, HMAC authentication, heartbeat, assignment, lease, callback, artifact, and receipt path.
- `agent-eligibility.ts` remains authoritative for workspace, health, protocol, capability, resource, and concurrency eligibility.
- `pull_assignments` remains operational delivery state. It is extended with a monotonically increasing fencing token so an expired claimant cannot submit a later result.
- `events`, aggregate heads, commands, transactional outbox, idempotency records, job leases, dead letters, and rebuildable projectors remain the reliability foundation.
- The existing checksummed artifact store persists immutable context packs and all planner products. Event payloads contain bounded metadata and hashes, never raw transcripts or chain-of-thought.
- Existing canonical JSON and SHA-256 helpers bind proposals, critiques, revisions, the canonical plan, verdicts, and approvals.
- Existing approval projections represent the exact-plan human gate. The approval action hash also binds base branch/commit, preferred executor/model, the exact bounded effects, and permanent prohibitions.
- Existing recommendation-to-change patterns supply idempotent parent-to-child linking. Child creation is implemented as a compensatable deterministic command series with unique parent linkage and never converts the planning mission.
- Existing usage records remain the source of provider/model/token/cost/duration accounting and gain consensus role/phase/attempt dimensions.
- Project Brain is invoked through an explicit adapter. One deterministic context pack is generated per consensus attempt, stored once as an immutable artifact, and never silently regenerated. Learning output remains a proposed candidate requiring the existing Project Brain governance path.

## Schema changes

Migration `0029_consensus_plan.sql` is additive and forward compatible from the authoritative production ledger through `0028_repository_identity_migration.sql`.

- Add conservative provider summary metadata to `agents` and immutable queryable `agent_capability_attestations`: stable provider identifier, agent version, supported mission roles/operations/models, normalized per-model capabilities, source/version, issued/expires/revoked/current state, structured-output support, Project Brain context support, repository-mutation support, and attestation hash. Existing agents receive compatible conservative defaults and cannot gain consensus eligibility without a current attestation.
- Add `mission_type`, repository/base/snapshot bindings, parent mission and approved-plan references to `mission_projections`.
- Add `fencing_token` to `pull_assignments`; each new claim increments it and every consensus response must present the active value.
- Add `consensus_plan_projections` for authoritative phase, immutable repository/context bindings, round/turn/budget limits, synthesizer, preferred executor/model, canonical artifact/hash, decision, approval, and child mission reference.
- Add `consensus_participant_assignments` with exactly one `planner_a`, `planner_b`, `synthesizer`, and `executor`, plus an optional `implementation_reviewer`. Queryable columns bind agent, provider, model, attestation ID/hash, permission-profile hash, assignment version, and assignment time. Planner identity remains distinct even when providers or hosts match.
- Add `consensus_artifacts` for normalized versioned proposal, critique, revision, canonical plan, and verdict metadata. Artifact bodies stay in the existing artifact store. Queryable columns hold round, assignment, reviewed artifact, snapshot/context/schema bindings, the generic artifact checksum, canonical hash, verdict, blocker count, and immutability state. Immutable triggers reject metadata updates.
- Add `consensus_objections` and resolution links so blockers are queryable rather than inferred from prose.
- Add unique constraints for role assignment, one artifact kind per assignment/round, verdict per assignment/hash, one active canonical plan per attempt, one approval, and one child implementation mission.
- Extend `usage_records` with mission/parent/child, participant assignment, agent/provider/model, role, planning phase, attempt, tokens/provider units, estimated/actual cost, and duration dimensions.

No existing row is deleted. Migration 0029 backfills `provider_id` and `agent_version` on existing agent rows from their current adapter/version metadata; all other additions use conservative defaults. Production rollback leaves additive tables and canonical history in place; a prior application ignores them.

## State-machine changes

The consensus aggregate uses these server-authoritative states:

```text
draft
ready
capturing_independent_proposals
proposals_complete
critique_round
revision_round
canonicalization
awaiting_final_verdicts
consensus_reached | consensus_not_reached
awaiting_human_approval
approved | rejected
implementation_mission_created
completed | failed | cancelled
```

Only command handlers may append transitions. Every command checks expected aggregate version, mission/workspace/assignment identity, role, active execution attempt, lease and fencing token, schema and size limits, immutable snapshot and context hashes, stage budget, and idempotency key.

The initial version permits exactly two planners, one proposal round, one cross-critique round, one revision round, one synthesis turn, and one verdict per planner. Neither proposal is released until both valid proposals are durable. Critiques bind the exact opposite proposal artifact. Revisions bind the critique and prior proposal. Canonicalization receives the immutable package of both proposals, critiques, and revisions. Verdict collection freezes the canonical artifact. Consensus is deterministic: both verdicts reference the same hash, neither rejects, and no unresolved blocker exists.

Budget, wall-clock, artifact, command, retry, turn, and cost exhaustion stops before starting the next phase and records `consensus_not_reached` or `failed`; it never opens an unbounded conversation.

## Agent protocol changes

Protocol `1.0` remains the transport envelope. Additive compatible assignment payload fields describe a consensus operation, schema version, phase, round, assignment role, repository snapshot, context artifact/hash, source artifact IDs, limits, selected model, and fencing token. Older Mission Agents may continue existing analysis/change behavior. They are explicitly ineligible for consensus work when their advertised operations, structured-output support, context support, or minimum Mission Agent version is missing.

Signed heartbeat and capability reports validate an immutable, expiring provider/model attestation equivalent to:

```json
{
  "provider": "claude_code",
  "agent_version": "...",
  "supported_mission_roles": ["planner", "reviewer", "executor"],
  "supported_operations": [
    "inspect_repository",
    "generate_structured_plan",
    "critique_plan",
    "revise_plan",
    "review_canonical_plan",
    "implement_change"
  ],
  "supported_models": ["provider-specific-model-id"],
  "model_capabilities": [
    {
      "model_id": "provider-specific-model-id",
      "display_name": "Operator supplied display name",
      "provider": "claude_code",
      "supported_roles": ["planner", "synthesizer", "executor"],
      "supported_operations": ["generate_structured_plan", "critique_plan", "revise_plan", "implement_change"],
      "structured_output": true,
      "repository_read": true,
      "repository_mutation": true,
      "plan_mode": true,
      "runtime_model_identity": "unverifiable"
    }
  ],
  "capability_attestation_version": 1,
  "capability_source": "operator_allowlist",
  "structured_output": true,
  "project_brain_context": true,
  "repository_mutation": true
}
```

Provider and model are separate. Core mission behavior never branches on a model marketing name. A heartbeat must exactly match the owner-approved provider version, roles, operations, models, and capability booleans; it cannot expand its profile. Unsupported schemas and missing required security fields fail clearly.

Each `consensus_participant_assignment` has queryable `participant_assignment_id`, `mission_id`, `role` (`planner_a`, `planner_b`, `synthesizer`, `executor`, or `implementation_reviewer`), `agent_id`, `provider_id`, `model_id`, capability-attestation ID/hash, permission-profile hash, assignment version, and assignment timestamp. Invocation, operation identity, lease/fence validation, receipts, events, artifacts, usage, approval, child linkage, canonical provenance, and learning candidates reuse that immutable binding. No model is silently substituted.

## Provider runtime requirement contracts

Provider capability is not inferred from a provider name. `domain/provider-runtime-requirements.json` is the versioned source of truth for every supported provider identifier. Its scope is consensus planning and the consensus-authorized child implementation; legacy non-consensus analysis remains governed by its existing assignment contract. Each provider contract declares execution mode, executable and exact supported CLI version, non-secret authentication probe, supported host platform, isolation and network behavior, credential-read scope, planning and implementation repository access, model-selection mechanism, fallback policy, structured-output mechanism, clean-worktree requirement, diagnostic-redaction policy, and consensus eligibility.

| Provider      | Execution boundary                                                                                                                                      | Required model selection                                                           | Credential boundary                                                                         | Consensus status                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `codex`       | Local `codex` CLI on macOS under operation-specific `sandbox-exec`; external TCP/UDP plus the exact mDNS resolver socket; loopback/inbound/bind denied  | exact `--model`; fallback disabled; actual runtime identity currently unverifiable | exact read-only `auth.json` reference; assignment-private HOME/TMP/CODEX_HOME               | proposed v2 profiles require fresh packet approval |
| `claude_code` | Local `claude` CLI on macOS under operation-specific `sandbox-exec`; external TCP/UDP plus the exact mDNS resolver socket; loopback/inbound/bind denied | exact `--model`; fallback disabled; actual runtime identity currently unverifiable | exact Keychain item brokered before sandbox as `CLAUDE_CODE_OAUTH_TOKEN`; isolated HOME/TMP | proposed v2 profiles require fresh packet approval |
| `hermes`      | External authenticated protocol bridge                                                                                                                  | provider-managed and not attested in this release                                  | bridge-owned plus Mission Agent protocol credential                                         | not consensus eligible                             |
| `generic`     | External authenticated protocol implementation                                                                                                          | provider-managed and not attested in this release                                  | external-agent boundary                                                                     | not consensus eligible                             |
| `mock`        | In-process test fixture                                                                                                                                 | fixture-selected and verified                                                      | no provider credential                                                                      | test-only; not consensus eligible                  |

Mission Agent hashes contract version, scope, provider ID, and the exact provider contract into every 0.8 heartbeat and reports executable, CLI version, authentication, isolation, platform, model-selection, and runtime-identity readiness without exposing credentials. Operation-specific bindings include both the PATH-resolved launcher and the exact invoked executable bytes/path; Codex invokes its bound native binary directly. Those identities are validated before any provider version, authentication, or mission subprocess. Registration fixes the owner-approved contract ID/hash; heartbeats cannot expand or replace it. Eligibility accepts only the explicitly supported CLI version and a current satisfied runtime contract, and participant assignments persist the same ID/hash so claim, lease renewal, message receipt, and release can fail closed when requirements change. The Agent Registry labels this as probe-derived heartbeat readiness, not provider-attested proof.

Changing any provider runtime requirement changes its binding hash, makes prior heartbeats and assignments stale, changes the Mission Agent capability manifest, and requires a newly built artifact plus new exact local-acceptance approval. The contract records `runtime_model_identity: unverifiable` for Codex and Claude Code; it does not manufacture provider attestation that their CLIs do not expose.

The prior 0.8.0 packet remains **NO-GO — provider sandbox incompatibility** and may not be reused. The proposed v2 profile definitions and disposable real-provider evidence are in `domain/provider-runtime-profiles.proposed.json` and `docs/evidence/CONSENSUS_PROVIDER_RUNTIME_PROFILE_DISCOVERY_2026-08-04.md`. They are development evidence, not registry, release, or production approval.

## Claude Code provider integration

Mission Agent hosts provider adapters behind one governed boundary:

```text
Mission Control
  -> signed pull Mission Agent
       -> Codex adapter
       -> Claude Code adapter
       -> Hermes adapter
```

The Claude Code adapter uses an argument array with no implicit shell, a bounded environment, server-selected operation, configured local credential reference, wall-clock timeout, cancellation, output limit, and exact `--model` selection. It never enables Claude's fallback-model option. Durable provider credentials remain local. Planning runs in a private empty directory with safe mode, no built-in tools, an empty strict MCP configuration, no browser/slash commands, and pre/post repository mutation fingerprints. Codex planning disables the shell tool and ignores user configuration/rules. Claude implementation receives only Read/Edit/Write/Glob/Grep plus a path-resolving pre-tool hook that rejects access outside the isolated worktree. Declared validation runs in an OS sandbox with network denied and writes restricted to the worktree/private runtime directories; absence of a supported sandbox fails closed.

On the acceptance host, Codex CLI `0.146.0` and Claude Code `2.1.221` expose an exact `--model` argument but no reliable complete model-enumeration interface. Mission Agent therefore uses an explicit, validated, versioned operator allowlist and includes it in the capability attestation. Marketing examples are not domain enums. The requested model is always recorded and passed exactly. Because these installed CLIs do not independently attest the actual runtime model on every result, current Codex and Claude capabilities must report `runtime_model_identity: unverifiable`; a detectable non-null mismatch is rejected, but this release does not claim cryptographic or provider-attested actual-model proof.

Every invocation records mission/workspace/repository/snapshot/context/operation/attempt/lease/fencing/model bindings and produces redacted receipts. Provider output is untrusted until strict JSON parsing, schema validation, size checks, secret scanning, binding checks, and artifact checksum verification succeed.

Long-running provider subprocesses renew the assignment lease, report execution progress, and refresh the authenticated agent heartbeat together every 25 seconds. This keeps health-based eligibility current before the coordinator releases the next bounded phase; a provider process cannot extend authority because every refresh is independently authenticated and the execution remains lease- and fence-bound.

## API and UI extension points

- Extend existing authenticated mission APIs with `POST /api/consensus-plans`, phase-specific agent submissions under the signed protocol route, exact-plan approval/rejection, idempotent child-mission creation, and workspace-scoped history queries.
- Extend the existing mission launch and detail surfaces. The detail view is a projection of canonical consensus events and artifacts and owns no business state.
- Extend onboarding and Agent Registry to display provider, models, roles, operations, compatibility, and eligibility. Agent selection is capability-based; heterogeneous providers are a recommendation, not a domain invariant.
- The approval view exposes objective, exact revision, participant/provider/model identities, all immutable planning artifacts, disagreements and blockers, usage/cost, context reference, canonical hash, executor eligibility, and budget. It never edits the canonical plan in place.

## Project Brain behavior

The adapter generates exactly one context pack for a consensus attempt and records repository SHA, deterministic selection accounting, included/omitted sources, context quality, size estimate, and checksum. Both planners receive the same artifact ID and hash. The pack cannot contain secrets, raw environment values, provider credentials, or hidden reasoning.

After a child implementation outcome, Mission Control creates a governed proposed-learning candidate containing evidence-backed outcome facts, objections, deviations, validation, cost, duration, and rollback/incident results. It does not automatically evaluate, confirm, curate, promote, or rewrite durable Project Brain knowledge.

## Failure and recovery behavior

- Duplicate submissions return the original receipt when message and checksum match; changed-payload reuse fails and is audited.
- Late responses fail when execution attempt, lease, fencing token, stage, snapshot, context, reviewed artifact, or canonical hash is stale.
- Planner disconnection leaves durable phase state resumable until the configured deadline. Permanent failure records an explicit terminal outcome or requires a new consensus mission; it never reveals the other proposal early.
- A crash after artifact storage but before canonical append is reconciled by checksum/idempotency metadata; orphan objects are non-authoritative and eligible for bounded cleanup.
- Canonical-plan creation and freeze occur in one database transaction after the immutable artifact is stored and verified.
- Human approval and child-mission creation use a unique approval/parent key and a compensatable deterministic command series. A retry returns the existing child. Worker reconciliation repairs terminal approvals, task/turn crash windows, missing child links, completed children, cancellations, and consensus timeouts without creating another mission.
- Repository snapshot drift before implementation marks the approved plan stale unless the child is explicitly bound to and checked out from the original commit.
- Provider timeout, malformed output, secret finding, output overflow, policy violation, or repository mutation during planning produces a typed failure and preserves bounded redacted evidence.
- Protocol message and assignment advisory fences remain held across receipt processing and authoritative writes; lease reclaims increment the fence and stale writers cannot race a new claimant.

## Security boundaries

- Consensus planning uses a dedicated read-only command policy. File edits, package installation, commits, pushes, branches, PRs, merges, deployment, infrastructure/database/credential mutation, wallet/signing/asset actions, arbitrary shell escape, and unapproved network calls are denied.
- Agent content is untrusted display data. Rendering is encoded; no plan text or command becomes executable through consensus.
- Workspace, repository, mission, task, execution, assignment, artifact, approval, and child references are checked server-side and constrained where practical.
- No provider credential, authorization header, signature, environment dump, raw prompt, raw transcript, chain-of-thought, or secret-like value enters events, UI, logs, database payloads, or Project Brain artifacts.
- The synthesizer cannot approve for the other planner. The executor must acknowledge the exact approved hash, and material deviations create a separate approval-bound record.
- Human approval remains mandatory even when both planners approve. Consensus is evidence, not proof of correctness.
- Consensus planning and child dispatch require a Mission Agent 0.8-or-later artifact whose checksum is verified against the human-approved signed release registry. Signed 0.7.2 remains eligible for its existing operations but is not advertised as consensus capable.

## Test plan

- Unit: provider profile parsing, eligible-agent filtering, all four artifact schemas, canonical hashing, blocker rules, exact-hash verdicts, transition authority, limit exhaustion, read-only policy, fencing, and child idempotency.
- Integration: one Codex plus one Claude registration; identical snapshot/context delivery; proposal withholding; critique/revision release; canonical freeze; verdict binding; unresolved blocker stop; exact human approval; one child mission; wrong workspace/snapshot/context/hash and stale lease/fence rejection; duplicate/restart recovery; rejection and budget exhaustion.
- Claude adapter: invocation package, argument-array execution, local credential boundary, model selection, structured parsing, secret redaction, timeout/cancel/process failure/output cap, planning mutation detection, receipts, and no unauthorized mutation.
- Projection: drop/rebuild equality for consensus, participants, artifacts, objections, approval, child link, and history UI.
- Acceptance: disposable repository with one real Codex and one real Claude Code runtime when operator-provided credentials and supported local CLIs are available. No production resource is contacted or changed.
- Repository gates: migration apply/status, compatibility, unit/integration/E2E, lint, format, typecheck, build, `git diff --check`, secret scan, and rollback verification.

## Rollback

1. Stop assignment of `CONSENSUS_PLAN` missions and disable the Claude Code capability in UI/eligibility configuration.
2. Stop new consensus planner jobs; allow or cancel already leased read-only operations through the existing signed cancellation path.
3. Roll back the application and Mission Agent manifest to the prior compatible artifacts. Do not overwrite immutable Mission Agent releases.
4. Leave additive migration tables, columns, canonical events, receipts, artifacts, approvals, and child references intact for the normal forward-safe rollback. The destructive rollback in `db/rollbacks/0029_consensus_plan.sql` is for an explicitly authorized, evidence-exported disposable or exceptional rollback only.
5. Existing Codex, Hermes, recommendation, change, publication, and prior Mission Agent paths continue using protocol `1.0` without the new capability fields.
6. Repair forward before re-enabling the feature. Rebuild and verify projections and reconcile orphan artifacts/parent-child links using bounded operator tools.

## Runtime-v3 remediation status — 2026-08-05

The preserved runtime-v3 acceptance remains `NO-GO — disposable-mode trust mismatch and incomplete repository registration`. Its successful eight-case Codex/Claude cancellation and timeout result is provider lifecycle evidence only and is not a completed consensus workflow.

The remediation introduces explicit `disposable_acceptance` runtime trust, exact registry path/content binding, production-resource rejection, metadata and capability-manifest attestation, authenticated complete repository registration, immutable `complete_repository_state/3` snapshot artifacts, mandatory setup preflight, and exact structured changed-model rejection. The standalone Next server may still use `NODE_ENV=production`; application trust is selected only by explicit `APP_ENV`, so disposable testing no longer impersonates production and production cannot consume the disposable registry.

The resulting unsigned runtime-v4 local packet passed its pre-provider review, but its subsequent setup failed closed with `ACCEPTANCE SETUP FAILURE: repository_prohibited_authority`. Runtime-v4 is preserved as **NO-GO — disposable repository carried prohibited push authority**. No runtime-v4 consensus workflow or implementation acceptance completed.

The successor remediation adds the authenticated `repository-authority/1` command and receipt, separates isolated worktree mutation and Mission Agent local commit from provider commit and remote push, and binds the authority through planning, approval, child creation, execution leases, mutation, commit, and success. It is a new unsigned packet and must receive fresh exact checksum and expiring-registry approval before registry addition or any real-provider invocation.

The runtime-v5 local packet adds exact 415-file Mission Control acceptance-source provenance, uses a signed disposable owner session against the running same-origin authority API, and keeps repository traversal out of production bundles. Local validation and independent review are complete with zero unresolved high or medium findings. The packet and inactive registry proposal are recorded in `docs/evidence/MISSION_AGENT_080_RUNTIME_V5_LOCAL_VALIDATION_2026-08-05.md`; neither has acceptance or production authority.

This source remains an unsigned development candidate based on `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`. It has no release or production authority. A rebuilt packet, its new checksums, and every runtime binding require fresh exact human approval before registry addition or any real-provider execution.

## Known first-version limitations

- Exactly two planners and one critique/revision round.
- The synthesizer has its own explicit agent/model assignment and may reuse a planner installation; there is no automatic model routing or cost optimizer.
- The schema reserves a future implementation-review flag, but Mission Agent 0.8.0 neither advertises nor accepts it. Automatic post-implementation reviewer assignment/execution requires a later complete workflow with review-evidence delivery and separate acceptance.
- Real disposable acceptance depends on operator-installed Codex and Claude Code CLIs plus local provider credentials. Absence of those credentials must be reported as untested, never simulated as live.
- The real harness has not been rerun against the final checksum in this candidate. Exact human checksum/capability approval and the local acceptance-registry entry must precede real-provider acceptance. Signing and production approval are separate and remain unauthorized.
- This implementation does not authorize publication, merge, deployment, production remediation, infrastructure or secret access, or financial actions.
