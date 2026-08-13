# Consensus Plan operator and acceptance runbook

**Release:** `R-2026-08-13-RUNTIME-V6-CONSENSUS`
**Classification:** security-sensitive application and agent-runtime release
**Production status:** human-approved for the exact release procedure; deployment verification pending

## Operating truth

Consensus does not prove correctness. Two planner verdicts do not bypass human approval. Planning agents are read-only. The approved canonical plan is immutable and SHA-256 bound. Implementation is a separate governed change mission. The one consensus approval explicitly authorizes only the bound executor/model to create an isolated worktree, write the approved change, run the declared validation, and create one local commit; push, pull-request creation, merge, and deployment remain prohibited. Ordinary Change Missions outside consensus keep their existing separate write approval.

## Launch prerequisites

1. Migration `0029_consensus_plan.sql` is applied and schema health reports zero pending migrations.
2. For production, the exact human-approved, signed Mission Agent 0.8.0 artifact is installed on each planning host and `mission-agent doctor` passes. For disposable acceptance only, the exact human-approved unsigned candidate may be added to the disposable local registry. Any byte or manifest change invalidates that narrow approval.
3. Two distinct agent identities are online with current unexpired capability attestations and satisfied provider-runtime contracts. Every selected role/model combination must explicitly advertise its operations, structured-output/read-only planning properties, and repository mutation only for the executor role.
4. The same repository is registered for both agents and its recorded commit is current.
5. The Project Brain CLI supports context schema 2.5.0.
6. A workspace owner is available for the exact action approval, including the preferred executor/model and bounded local effects. Provider credentials stay local.

## Normal operation

Launch **Consensus Plan** from New Mission, select repository, objective, acceptance criteria, optional constraints, Planner A agent/model, Planner B agent/model, synthesizer agent/model, preferred executor agent/model, optional implementation-reviewer agent/model, and fixed attempt/duration/cost limits. Dropdowns show only approved agents with current attestations and a model that supports that exact role and its required operations.

The mission page must show, in order: one context pack; exact role/agent/provider/model/attestation bindings; two independent proposals; two cross-critiques; two revisions; one canonical plan/hash; two exact-plan verdicts; role-separated usage; the fixed child budget and validation command set; human approval; one child implementation; and a proposed Project Brain learning candidate after completion. The selected reviewer assignment is recorded and displayed, but automatic implementation review remains disabled in 0.8.0. Open objections remain visible. No opaque consensus score is used.

Only an owner may approve or reject. Approval does not edit the plan. To change content, reject and launch a new consensus mission. The executor/model are selected before planning and displayed as immutable approval bindings; they cannot be substituted afterward. An optional execution budget may be supplied when the idempotent child is created. Repository drift or revoked write/commit/resource authority marks the path ineligible and blocks creation or claim.

## Failure and recovery

- An expired lease is reclaimed; every new claim increments the fence. Late holders are rejected.
- A disconnected planner leaves durable work intact until retry/deadline limits. The other proposal is not revealed early.
- Malformed, oversized, secret-like, wrong-snapshot, wrong-context, wrong-source, or wrong-hash output fails validation.
- Duplicate message IDs with the same checksum return the stored receipt; changed-payload reuse is rejected.
- An artifact stored before a failed canonical append is non-authoritative and may be reconciled by its message/checksum metadata.
- Budget, unknown-cost, duration, turn, command, artifact, or retry exhaustion stops before the next turn.
- A child created before a parent-link crash is recovered by the unique parent key; a retry cannot create another child.
- `PLAN_INVALID` creates a proposed deviation artifact requiring reapproval; the executor may not silently redesign.

## Disposable acceptance

The authoritative mandatory-step inventory is generated from the executable registry into [`MISSION_AGENT_080_RUNTIME_V6_GENERATED_CHECKLIST.md`](evidence/MISSION_AGENT_080_RUNTIME_V6_GENERATED_CHECKLIST.md). This runbook may explain operation and recovery, but it may not independently add, remove, or rename a mandatory step. The contract generator and runbook-consistency test require every checklist and independent-review step to match the generated canonical contract.

Run against a disposable repository and nonproduction database only. Verify two real provider registrations, signed 0.8 artifact eligibility, same commit/context hash, proposal withholding, critique/revision release, canonical hash, exact verdicts, one owner action approval, one child, exact action-hash/plan acknowledgement, isolated implementation, validation evidence, local commit, and proposed learning candidate. Verify that no second `remote_workflow` approval exists for the consensus child. Mission Agent 0.8.0 does not advertise or accept a post-implementation non-executor review option; add that only as a later complete, separately accepted workflow. Confirm no push/PR/merge/deploy unless separately exercised through an already approved governed publication path.

Start the server only with explicit `APP_ENV=disposable_acceptance` and `CONSENSUS_DISPOSABLE_ACCEPTANCE=true`. Pin the absolute registry path and its raw SHA-256, an exact loopback database URL plus governed disposable database name, loopback HTTP application/acceptance URLs, the disposable root, local artifact root, and the complete JSON list of provider-writable roots. The registry file and its directory must be non-writable and outside every provider-writable root. Any production credential, production registry setting, S3 setting, non-loopback endpoint, changed/expired registry, or production-authority substitution must stop startup.

The harness must stop before lifecycle probes or mission creation unless readiness reports the exact runtime/registry/database trust, both authenticated agents are artifact/profile/executable/authentication/attestation/model eligible, both authenticated repository registrations converge on the same clean `complete_repository_state/3` snapshot artifact, Project Brain files are in that snapshot, local read/write/commit authority is present, push/deployment are absent, the four role assignments exactly match the no-fallback allowlist, and implementation review is disabled. A prerequisite failure is `ACCEPTANCE SETUP FAILURE`, not a provider failure. The changed-model probe must compare exact structured error details and prove unchanged diagnostics, missions, assignments, approvals, and child counts.

The final unsigned candidate must first be presented with its exact artifact checksum, capability-manifest checksum, source base, source-template checksum, provider/model behavior, permissions, and limitations. Human approval for the exact checksum permits only adding that artifact to the disposable local acceptance registry and running the acceptance matrix. It is not signing, publication, production approval, or deployment authority. Do not mark the release ready or create release commits until the real harness, adversarial matrix, and repeated independent review complete with zero unresolved highs.

The prior exact approval was superseded because the provider runtime contract changed the Mission Agent bytes and capability manifest. The operator subsequently approved the exact revised packet recorded in `PLANS.md` solely for disposable acceptance: artifact SHA-256 `52a2a20f8058351ecd91ed431dbc65a107c5e4489c40b938cc4a3e10a2fc2dbd` (203173 bytes), artifact-metadata SHA-256 `fa5ca6f83c675b96b137b82ba5447fa106efb347852d23b240f594be6a667200`, capability-manifest SHA-256 `52f9524747e94bed8298e37e382a63c7eee20a3cfc083bb1d03c74797c05fd01`, authoritative source base `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`, uncommitted source-template SHA-256 `896a29247a486479ca390c91d358135537541d05c9a49af19e9b6541a5bf0258`, build-script SHA-256 `601b03d980a1463fc535e40e880fd614f375f5e34ebf8a6ea4a0c2ea093ed080`, provider-runtime catalog file SHA-256 `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206`, and canonical catalog SHA-256 `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3`.

The 2026-08-04 disposable run failed closed at the governed provider boundary. Codex `gpt-5.6-sol` could not initialize its in-process app-server client inside the Mission Agent macOS sandbox, and Claude Code `claude-fable-5` exited inside that sandbox without accepted structured output. Direct diagnostics accepted both model identifiers outside the outer sandbox, which proves model availability but not governed execution. No synthesis, verdict, approval, child mission, or executor was reached. Any sandbox-policy or artifact correction changes the approved packet and requires a rebuild, new checksums, fresh exact approval, and a complete new acceptance run.

The later runtime-v3 run remains `NO-GO — disposable-mode trust mismatch and incomplete repository registration`. Its eight successful provider cancellation/timeout cases remain lifecycle evidence only. The remediation packet must be independently reviewed with zero unresolved high or medium findings before it is rebuilt. After rebuild, stop before registry addition and real-provider execution and obtain fresh exact approval for every checksum, runtime binding, registry identity, and model assignment.

The runtime-v4 packet is permanently `NO-GO — disposable repository carried prohibited push authority`. Its preflight stopped before provider execution. Do not add its registry or reuse its approval.

The successor runtime-v5 packet is an inactive unsigned proposal. Its exact bytes, 23-hour window, source manifest, results, and residuals are in `docs/evidence/MISSION_AGENT_080_RUNTIME_V5_LOCAL_VALIDATION_2026-08-05.md`. Do not copy the proposed registry or invoke providers until a human approves that complete exact packet and window. The disposable authority endpoint itself fails closed outside `disposable_acceptance` and tests.

For the successor packet, the harness must first use the authenticated owner repository-authority command. Confirm the resulting immutable receipt and exact `repository-authority/1` projection: read, isolated-worktree write, and Mission Agent local commit are true; provider-direct commit, push, PR, publication, deployment, and infrastructure mutation are false. A changed binding fences active leases and requires a new approval. Only after fresh exact packet and registry approval may the proposed registry bytes be copied without reformatting into a provider-inaccessible non-writable authority directory.

Before dispatch, the Agent Registry must show the exact consensus provider runtime requirement ID/hash and `satisfied` probe readiness; this is local heartbeat evidence, not provider attestation. For Codex this includes CLI version `0.146.0`, authenticated session, macOS `sandbox-exec`, outbound/local-IPC network behavior, private writable runtime directories, read-only Codex credential home, exact argv model selection, and disabled fallback. For Claude Code it includes CLI version `2.1.221`, authenticated session, macOS `sandbox-exec`, outbound network, private writable runtime directories, read-only Claude home plus service-mediated Keychain access, exact argv model selection, and disabled fallback. A missing, changed, stale, unsupported-version, or unsatisfied contract is ineligible. Hermes, generic, and mock contracts are explicit but not consensus eligible in this release.

Required repository gates are unit tests, integration tests, protocol compatibility, typecheck, lint, format check, production build, migration apply/status, destructive rollback on a disposable database, projection replay, diff check, and secret scan. Real Codex + Claude acceptance requires operator-provided local credentials; absence must be reported as not run.

## Rollback

Preferred production rollback is forward-safe: disable new consensus creation and Claude eligibility, drain or cancel signed read-only turns, restore the prior application and `mission-agent-latest.json`, and retain additive history for audit/replay.

The destructive schema rollback is [`db/rollbacks/0029_consensus_plan.sql`](../db/rollbacks/0029_consensus_plan.sql). Use it only after exporting required artifacts/events, proving no active or retained consensus records are needed, rolling back the application, and obtaining exact human authorization. It removes consensus projections and additive provider/fencing/mission/usage columns; it does not belong in normal production rollback.

Re-enable only after migration health, projection verification, Mission Agent compatibility, and a fresh security-sensitive human release approval pass.

# Runtime-v6 terminal lifecycle trust boundary

Disposable real-provider acceptance uses one non-recursive proof hierarchy:

1. The bootstrap authority creates the evidence root and fsynced authoritative resource inventory before normal resource creation.
2. Ordinary resources move through durable reservation, creation, cleanup, and terminal records.
3. Cleanup attempts form an append-only hash chain. Its final entry hash is the cleanup-journal root.
4. The canonical terminal inventory ledger accounts for every ordinary governed resource and binds the cleanup-journal root, source closure, independent review, and requirement evidence index.
5. The terminal ledger is the external trust anchor for the resource set. It is not an ordinary self-accounted resource and does not contain its own byte hash.
6. After the ledger bytes are sealed, their SHA-256 is computed without modifying them. The outer final acceptance record binds that SHA-256 and is the terminal acceptance result, not another recursively self-accounted resource.

The cleanup journal uses its final hash-chain entry as its non-recursive root and is authenticated by the terminal ledger. Finalization artifacts and every other ordinary run resource remain explicitly governed.
