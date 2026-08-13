# Mission Agent 0.8.0 runtime-v5 local validation — 2026-08-05

## Disposition

`AWAITING FRESH EXACT DISPOSABLE ACCEPTANCE APPROVAL`

This is an unsigned, local-only development packet. It has not been added to a registry and no runtime-v5 provider invocation has occurred. It is not signed, published, committed, staged, pushed, proposed for merge, production-ready, or deployed. Production Mission Agent 0.7.2 remains unchanged. Runtime-v4 remains permanently `NO-GO — disposable repository carried prohibited push authority`.

## Root cause and remediation

Authenticated Mission Agent GitHub registration historically projected `push_allowed=true` from GitHub remote detection. That was an existing product compatibility decision: legacy owner registration can configure push explicitly, while the Mission Agent registration projector inferred GitHub publication capability. The model conflated a repository's remote-provider capability with the narrower local implementation authority needed by disposable consensus acceptance.

Runtime-v5 adds the exact additive `repository-authority/1` profile. Generic `write_allowed` and `commit_allowed` remain false. Repository read, isolated-worktree mutation, and Mission Agent-controlled local commit are separate. Provider direct commit, push, pull request, merge, publication, deployment, and infrastructure mutation are all false. Existing production rows are not rewritten or retroactively revoked; legacy non-consensus dispatch retains its compatibility mapping. The disposable authority command is unavailable in production and local modes.

The real-acceptance harness creates a signed disposable owner session and invokes the running same-origin authenticated PATCH API. It requires HTTP success, fetches the projected result, and validates the durable immutable actor/command/authority-hash receipt before mission creation. It never patches projection rows directly.

Authority is revalidated at mission creation, planning dispatch/claim/renewal, human approval, child creation, executor dispatch/claim/renewal, before mutation, before Mission Agent local commit, and before terminal success. Rebinding serializes with assignment leases, releases and fences active work, rejects delayed output, and makes a granted plan approval unusable. The explicit implementation-authority expansion test proves a new plan approval is required.

## Packet integrity

The registry binds an exact Mission Control acceptance-source manifest in addition to the agent artifact and named packet files. The manifest enumerates the exact executable/test source closure: 415 files under `agents`, `app`, `application`, `db`, `domain`, `execution`, `fixtures`, `git`, `integrations`, `lib`, `policy`, `remote-agent`, `schemas`, `scripts`, `templates`, and `tests`, plus root runtime/build configuration. The only excluded file is the self-referential manifest itself. Changed bytes and added, removed, symlinked, or escaping paths fail closed. Repository traversal lives in a harness-only module and is absent from production bundles.

## Exact packet

| Identity                             | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| Mission Agent artifact               | `f1608ec9914c5c517cd7804a6e2fc0b4bca65dd31dbc319827247864917909d6` |
| Artifact metadata                    | `1756045597b721eb54c4697547148bc530113bdc9b1806ea14b613a9d5b2d881` |
| Capability manifest                  | `42cd50b49808e1ef96588bec3cf5dd98b82458b71289b1603c8522cc9a35f0e4` |
| Source base                          | `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`                         |
| Source template                      | `2be34277c76ca6ef8a6e8167df7fe9e77fca4033d6bfc8e730db022a5a44c88a` |
| Build script                         | `cbfe59531b1871fe41da477f3cef3b77b2a771c0b859c21e8e90ccb6952f1a5d` |
| Provider requirements file           | `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206` |
| Provider requirements canonical      | `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3` |
| Provider profiles file               | `93aa3f2e5f17a542ebd06c9d4973f644e777abe292fbb9bb83a9f2bf6717979c` |
| Provider profiles canonical          | `a3ede41f203caa818f2ac020a4933a7b12eea55b736740fca118fd3d57e44607` |
| Discovery harness                    | `2256925def8e00d7708e90d0c2b1273bda315ec883a9d3649ba47d1404db2704` |
| Real-acceptance harness              | `041463fe09e1f8288ec7391b9b8dd958f646047c2a3303c21e078a23d7290118` |
| Artifact fixture                     | `6d193f900310db158ae3c04951498243e2f0bc693f426c4865f544ebaed51ed7` |
| Consensus migration 0029             | `45c5532d05c8392709e01fa0d1fbee2f55cfd345e9ba361e83c7dfd21e610fcb` |
| Consensus rollback 0029              | `ca0e45d9151f31a13a7c96949d4e617afad18204b922ddaaec9668588a0ab722` |
| Repository-authority migration 0030  | `70eacced87140d6e7deaa93153e9f682f9406e6479c49c5a0fd9468b206db2db` |
| Repository-authority rollback 0030   | `a51ed79db9e3fcf82eef8f820c11eb86f0c3513c5d1b6d84fb764f5b2277298a` |
| Runtime-mode definition              | `2077ca55a498d1d510e1c36f4d3b76388dd76c4d17adbbfbd1d61a6c0857e688` |
| Disposable-registry schema           | `7150ce39d58a30b595559e40854b35aa0bb65a36ad298cc88e2149eaabaa7e98` |
| Repository-snapshot schema           | `59fce8f9d29f061a5b50aed56817a76e525aa12d66fd60e9e698d19d5fc9014e` |
| Repository-authority schema          | `3338b95cde037565742b097a2daaa6e37db71cbce42044f47cda86802bac9181` |
| Acceptance-source manifest file      | `37b043bd9568de703ec08d2a9c160afb490e60c4402fca2ea1bca50483e6064e` |
| Acceptance-source manifest canonical | `2b591a7bd4f62f14567146fb4e83788abdd5166784e85ad8d81dcaee942d7ffd` |
| Acceptance-source manifest schema    | `6b16fc390c5d3ab7dcc3d8a56579d95d8d7d1519146f5e6a80f3a365420e4c16` |

Proposed registry: `docs/evidence/MISSION_AGENT_080_RUNTIME_V5_PROPOSED_DISPOSABLE_REGISTRY.json`

- Registry SHA-256: `5fc9a96b805240c533d63cbffefbf51713b877a252858971e774720ff3c2da83`
- `valid_from`: `2026-08-05T16:43:05Z`
- `expires_at`: `2026-08-06T15:43:05Z`
- Window: 23 hours
- Scope: disposable local authenticated Codex/Claude consensus real-provider acceptance only; production authority is false.

The proposed bytes remain inactive and have not been copied into an acceptance registry.

## Exact no-fallback role assignments

| Role                    | Provider    | Exact requested model |
| ----------------------- | ----------- | --------------------- |
| Planner A               | Claude Code | `claude-fable-5`      |
| Planner B               | Codex       | `gpt-5.6-sol`         |
| Synthesizer             | Claude Code | `claude-fable-5`      |
| Executor                | Codex       | `gpt-5.6-luna`        |
| Implementation reviewer | Disabled    | —                     |

Runtime binding hashes are unchanged from runtime-v4:

- `claude-implementation-macos-v2`: `6405187965b7fd8c47d2dcdd7892a3a997e8019c082c5c560a0a3d534b6b99ae`
- `claude-planning-macos-v2`: `f85b050c01be1349454ce1e63fdd5ba326a772f9fe391cc4e36adaed823c7eac`
- `codex-implementation-macos-v2`: `2a5eeb729d35071b7ec3538b62c557d5f2b8971a4f5e42f3b96faf976b3dab87`
- `codex-planning-macos-v2`: `1be10ad47abd12eff570be08ee4e390d4a23f45d55d81adf9e1a3b01df530a8e`

## Validation

- Exact candidate unit suite: 197/197 passed.
- Exact candidate serial integration suite: 95/95 passed.
- Consensus integration: 22/22 passed, including exact permission separation, authenticated replay, lease fencing, expansion-after-approval rejection, child inheritance, and push-disabled preflight behavior.
- Focused repository-authority/runtime-trust: 8/8 passed.
- Browser acceptance: 2/2 passed.
- Migrations 0030 then 0029 rolled back on the disposable local database; 0029 and 0030 reapplied; pending migrations: 0.
- Typecheck, ESLint, Prettier check, artifact syntax, and production build passed.
- Production build completed without warnings after moving source traversal to a harness-only module. Standalone output is 33 MB and contains no tests, fixtures, real-acceptance harness, or acceptance-source verifier.
- Production dependency audit: 0 vulnerabilities.
- Full dependency audit: one high-severity advisory in bundled `brace-expansion@5.0.8` under development-only `aws-cdk-lib@2.263.0`; it is absent from the production dependency audit and is reported as a low release-toolchain residual.
- `git diff --check`: passed. Staged files: 0.

## Replay evidence

The focused repository replay deletes the repository authority, immutable snapshot, receipts, and bound repository permission rows, then rebuilds them from canonical registration and authority events. It recreates the exact authority hash/receipt and exact permissions: implementation agent `[read, isolated_worktree_write]`; planning-only agent `[read]`.

Global replay verification ran across 968 shared local events. It truthfully reported `equal=false` for mission/task/execution/usage projections because the long-lived shared development database contains direct fixture rows without corresponding canonical events. This known local-fixture discrepancy is not represented as a passing global replay. Authority-specific replay passed, and global replay now includes only authority-event-backed repository permission rows so legacy non-event-sourced production permissions are never deleted.

## Secret scans

- High-confidence credential patterns: 0.
- Raw durable lease-token literal patterns: 0.
- Private-key headers: one intentional synthetic redaction fixture in `tests/mission-agent-0.8.test.mjs`; no real key bytes.
- Durable lease tokens remain hash-only/ephemeral; provider diagnostics remain redacted.

## Independent review

Pre-build and post-remediation review reports zero unresolved high-severity and zero unresolved medium-severity findings. One low hardening residual remains: acceptance-source bytes are verified at harness startup and represented by immutable packet/preflight evidence rather than reread continuously throughout the workflow. Provider writable-root isolation prevents provider mutation. The development-only dependency advisory above is also retained as a low toolchain residual.

## Differences from runtime-v4

- Exact additive repository authority separates isolated local mutation from remote push/publication.
- Authenticated same-origin owner API and immutable receipt replace in-process harness authority configuration.
- Generic write/commit are explicitly false; merge is explicitly prohibited.
- Authority rebinding fences available/leased/acknowledged assignments and invalidates prior approval.
- Repository permissions and receipts replay from canonical events without touching legacy grants.
- Exact 415-file Mission Control acceptance-source provenance is registry/capability/preflight-bound.
- Both migrations and both rollbacks are bound into the packet.
- Disposable-only authority is unavailable in production/local runtime modes.

## Required next authorization

A human must approve every exact checksum above, registry SHA-256 `5fc9a96b805240c533d63cbffefbf51713b877a252858971e774720ff3c2da83`, the exact UTC window, all four unchanged runtime binding hashes, and the exact no-fallback model assignments. That approval may authorize only copying these exact bytes into the disposable local acceptance registry and running the real-provider disposable workflow/adversarial matrix. Any changed byte, checksum, binding, model, scope, or time window requires a new exact approval.

Stop before registry addition, provider invocation, staging, commit, signing, publication, push, pull request, merge, production access, production migration, or deployment.
