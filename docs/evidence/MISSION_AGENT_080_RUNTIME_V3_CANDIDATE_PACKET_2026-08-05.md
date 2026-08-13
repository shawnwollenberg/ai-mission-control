# Mission Agent 0.8.0 runtime-v3 unsigned development candidate packet

**Disposition:** rebuilt unsigned candidate; exact packet approval required before registry addition or provider execution
**Production readiness:** not claimed
**Production authority:** none; production was not contacted or modified
**Source base:** `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`
**Source provenance:** transitional dirty-worktree development provenance accepted only for disposable local review

This packet closes the source-level rebuild gate after the runtime-v2 disposable acceptance failed. It is not
registered, signed, published, committed, staged, pushed, approved for real-provider execution, or approved for any
production action.

## Exact packet identities

| Packet component                                      | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `public/mission-agent-0.8.0-runtime-v3.candidate.mjs` | `a26b7c570a597d0be2823ce1b743ef3591f9193328b0a07b0a1e3ee4dc5160fe` |
| Artifact metadata                                     | `4cfd06d3cd390e4a6dcb71a50c2b203a04129c7477ff833151c9e873764fd26c` |
| Capability manifest                                   | `b303868dda5353ca5802d85076a2a47f8e25ae50165b793afef4439d528d7107` |
| Source template                                       | `8b088d4aa6eb05cd3626282622c9b7dcdc6edd758a3036711ae5e3193ce4b9cb` |
| Build script                                          | `fb5c63f760314b19e0752cdad9020ef4ed68454a8ef980f39d0d50fd0391fbcd` |
| Provider requirements file                            | `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206` |
| Canonical provider requirements                       | `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3` |
| Provider profiles file                                | `c54338fc7210e65a6394b1f2dbe2499ab4dd6801b6091dc95e7b7b116783e00b` |
| Canonical provider profiles                           | `2a848456386ef35b8c1823719503818b4f6ac8c04c6420100c5649ca3801f9e0` |
| Discovery harness                                     | `2256925def8e00d7708e90d0c2b1273bda315ec883a9d3649ba47d1404db2704` |
| Real-acceptance harness                               | `be65fc1b4e4c881119f943a044d4381ade0fe9783bfb8d701bac8c1b5ba70551` |
| Artifact test fixture                                 | `cd2bf015135122cf370c63f970f85aad177b7f9f341c99cc66b68e45646f8cf9` |
| Migration 0029                                        | `9a87d8c69f7d1baf5be7030b7907371167bc04d1ce9660b7852e612dbba74ca7` |
| Rollback 0029                                         | `ca1c5ce8b1611cc3fbe99b7793c7bba89abfdd8037564607dad9e6f87be0896e` |

Artifact byte length is `255779`. Artifact metadata binds version `0.8.0`, Manifest v3,
`release-manifest-json-v3`, release authority v2, the source base above, and the artifact checksum above.

## Required future disposable model assignments

| Role                    | Provider    | Exact requested model |
| ----------------------- | ----------- | --------------------- |
| Planner A               | Claude Code | `claude-fable-5`      |
| Planner B               | Codex       | `gpt-5.6-sol`         |
| Synthesizer             | Claude Code | `claude-fable-5`      |
| Executor                | Codex       | `gpt-5.6-luna`        |
| Implementation reviewer | Disabled    | Not invoked           |

The discovery and acceptance harnesses bind planning and implementation profiles independently. Codex planning
lifecycle coverage requests `gpt-5.6-sol`; Codex implementation lifecycle coverage requests `gpt-5.6-luna`.
Claude lifecycle coverage requests the explicitly assigned Claude model. Fallback remains disabled.

No provider service invocation was made against runtime-v3 because this exact packet has not been approved. Therefore
no runtime-v3 model argument has yet been acknowledged by a provider, no runtime-v3 provider/model mismatch has been
observed, and actual runtime model identity remains independently unverifiable where the provider CLI exposes no proof.

## Differences from the frozen runtime-v2 NO-GO packet

- Mission Control generates a deterministic canonical objection UUID from mission, consensus attempt, critique
  artifact, participant assignment, round, and raw provider objection ID. Raw labels such as `B1` are provenance and
  display metadata only.
- Command authorization resolves raw labels only through exact critique provenance. Events, live projection, replay,
  API responses, UI, and receipts use the same canonical identifier.
- Durable protocol receipts are strict kind-specific v2 schemas. Raw lease bearer authority is accepted only at the
  ephemeral request boundary; durable state contains a one-way fingerprint, stable lease ID, issued/expiry times,
  fencing token, and exact authorization binding.
- Migration 0029 blocks on every unexpired invalid legacy receipt, deletes only expired invalid receipts, and validates
  the structural constraint before it can complete.
- Consensus terminal success requires an immutable, contiguous provider diagnostic history whose final attempt is a
  successful exit. Conflicting diagnostic retries fail closed.
- Provider retry identities remain contiguous across every invocation, including implementation no-change recovery;
  success and terminal failure/cancellation preserve the complete history. The shared bound is eleven diagnostics,
  matching the authorized maximum of ten retries plus the initial invocation.
- Acceptance binds every independently approved packet file and canonical catalog hash, verifies exact role/model
  populations and retry histories, runs credential-free artifact preflight and real-provider cancel/timeout lifecycle
  cases, rejects changed model assignments, and scans expanded durable, artifact, state, and log surfaces including
  forbidden `leaseToken` keys.
- Codex implementation lifecycle coverage is bound to Luna rather than inferred from a planning probe.

## Validation evidence

- Candidate syntax and artifact-specific tests: `8/8` passed.
- Unit tests: `193/193` passed with the exact runtime-v3 artifact selected.
- Fresh-database integration tests: `92/92` passed.
- Fresh built-application browser tests: `2/2` passed.
- Independent pre-boundary focused review suite: `23/23` passed; after the boundary correction, the reviewer
  independently rebuilt the exact source and reran the credential-free artifact suite `8/8`.
- Maximum retry boundary: one successful consensus turn persisted all `11/11` contiguous provider diagnostics.
- Typecheck, lint, formatting, production build, and `git diff --check`: passed.
- Production dependency audit: zero vulnerabilities.
- Full dependency audit: one HIGH advisory in `aws-cdk-lib`'s bundled `brace-expansion@5.0.8`; this is dev-only
  infrastructure tooling and is not in the authored/runtime production dependency path.

The event-backed browser database replayed `81` canonical events with exact equality and zero discrepancies. The
focused consensus invariant deletes and rebuilds the five consensus tables and compares proposals, critiques,
objections, resolutions, revisions, synthesis, verdicts, terminal consensus, approval, child linkage, usage, provider
provenance, cancellation, and failure exactly.

A diagnostic global replay against the broad integration-test database was not used as acceptance evidence: those
tests intentionally leave three direct projection fixtures after removing their fixture events, producing three
expected discrepancies. This does not affect the exact event-backed browser replay or the focused consensus invariant.

Migration validation used two fresh databases:

- Full apply, rollback, schema absence verification, and forward reapply passed.
- An unexpired invalid legacy receipt blocked migration 0029. After the fixture was expired, migration deleted only
  that invalid expired row and completed with `0` invalid rows and the constraint `convalidated=true`.

## Secret and receipt evidence

Expanded durable scans covered events and metadata, agent protocol receipts, idempotency results, outbox and job
payloads/errors, artifact metadata, normalized consensus artifacts, full provider diagnostics, pull payloads, and
Project Brain requests. Across all retained runtime-v3 disposable validation databases:

- Raw `mc_lease_`/`mc_pb_lease_` credential-pattern matches: `0`.
- Forbidden durable lease-token key matches: `0`.

All retained runtime-v3 local artifact roots also reported zero raw lease-token pattern matches. Exact-value and
failure-path secret/redaction tests passed. Structural receipt tests reject unknown fields, nested secret fields,
alternate casing, provider credential values, raw authentication headers, and raw environment secrets.

An initial post-rebuild test-fixture run incorrectly reused the production Claude Keychain broker and supplied the
user's real OAuth token to a temporary compiled fake-Claude executable. The executable had no networking,
persistence, or token-output implementation; no provider service invocation, token persistence, or exfiltration was
observed. Independent review rejected that run as clean rebuild evidence. The fixture now compiles a separate
fixture-only security broker, binds a disposable keychain path and account, supplies only a dummy OAuth token, and
requires the fake Claude executable to receive exactly that dummy value. It also asserts that production source still
hardcodes `/usr/bin/security` and that the generated fixture contains no such production broker reference. The
credential-free replacement run passed `8/8`; only that replacement run is accepted as artifact-test evidence. The
final independent re-review verified the dummy broker and exact fixture bindings, independently reran `8/8`, and
returned to zero unresolved HIGH and zero unresolved MEDIUM findings.

## Independent review

The repeated independent security, correctness, and runtime review reports **0 unresolved HIGH** and **0 unresolved
MEDIUM** findings in the requested rebuild-gate scope. It independently verified the migration guard, canonical
objection identity, explicit execution/Project Brain receipt kinds, strict local receipts, immutable diagnostic
histories through the eleven-invocation retry boundary, expanded packet binding and scans, replay-safe evidence
storage, and exact artifact-test selection.

The reviewer cleared only rebuild and local validation. It did not authorize registry mutation, provider execution,
commit, release, production access, or deployment.

## Frozen runtime-v2 evidence

Runtime-v2 remains permanently:

> NO-GO — objection projection divergence and durable lease credential exposure

Its frozen checksums remain:

- Artifact: `1b0c2549989b3a298bd7e510526b5fcb06e889c926a15d5c7a28b9f2a44e95ee`
- Artifact metadata: `25a73475a7e7181e83f0e84c23f74d86074899c4bc4761232974d3f727679621`
- Capability manifest: `95a0298a4f6fd6c40bdffdd454057959b1fa4adc25e18fbfac53343c52c63222`

The retained disposable database `mc_runtime_v2_acceptance_20260804` still contains ten raw lease-bearing receipts;
all ten are expired and had no production authority. The retained evidence root is
`/private/tmp/mission-control-runtime-v2-acceptance-20260804`. The failed acceptance application server is stopped.
The raw values were not found outside that disposable database. No historical value has been copied into this report,
sanitized, deleted, or modified.

After evidence retention is separately released, the governed cleanup procedure is to record authorization and final
hashes, verify zero database sessions, drop only `mc_runtime_v2_acceptance_20260804`, remove only the exact retained
evidence-root path, and verify both are absent without reproducing token values. That procedure has not been executed.

## Exact approval required next

Before any registry change or provider execution, a human must approve every runtime-v3 checksum and canonical hash in
this record together with the source base and exact role/provider/model assignments. Any changed artifact, metadata,
manifest, template, build script, provider requirement, provider profile, canonical form, runtime binding, discovery
harness, acceptance harness, migration, rollback, capability declaration, or model assignment requires a new exact
approval.

After approval, acceptance must start from the beginning on new disposable infrastructure; it must not resume the
runtime-v2 canonical plan. Stop again before staging, committing, signing, publishing, pushing, opening a pull request,
merging, production access, migration, or deployment.
