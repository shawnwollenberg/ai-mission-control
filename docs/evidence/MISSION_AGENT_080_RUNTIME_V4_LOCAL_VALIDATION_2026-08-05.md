# Mission Agent 0.8.0 runtime-v4 local validation packet

Date: 2026-08-05
Classification: unsigned development candidate; disposable acceptance only
Source base: `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`
Production readiness: not claimed
Registry status: not added
Real-provider status: not run for runtime-v4; fresh exact approval required

## Preserved runtime-v3 disposition

Runtime-v3 remains `NO-GO — disposable-mode trust mismatch and incomplete repository registration`. The eight successful Codex/Claude cancellation and timeout probes under `/private/tmp/mission-control-runtime-v3-acceptance-20260805` remain provider lifecycle evidence only. They are not relabeled as consensus-workflow acceptance. The preserved report SHA-256 is `9057d283d46f5c9bed908dc0c59e98a7601754401249fd6a9f15ef12ff0acb93`.

## Root causes and corrections

The standalone Next process used `NODE_ENV=production` for its framework runtime and the application treated that as production trust, so the disposable registry could not be used. Application trust is now selected only by explicit `APP_ENV`. `disposable_acceptance` requires an explicit flag, exact loopback endpoints and database name, local artifact storage within the governed disposable root, absence of production credentials and registry authority, and an exact non-writable registry outside every provider-writable root. The harness performs these checks and requires its real path to equal the governed disposable root before any database, HTTP, artifact-test, or provider effect.

The prior registry design shape-validated packet hashes but did not consume all of them. The registry is now the sole packet authority: legacy per-file and per-model approval environment variables are rejected. It must contain exactly one artifact, exact packet fields, exact role assignments, and exactly four named runtime bindings. Before effects, the harness hashes every approved file, recomputes both canonical catalog hashes and all four runtime bindings, and compares them with the sole entry. The mandatory server preflight repeats and exposes that comparison.

Repository registration now uses the authenticated Mission Agent protocol route and persists `complete_repository_state/3`, stable repository identity, checkout-root identity, branch/base/HEAD, clean status, full tracked/untracked/relevant-ignored manifests, modes, symlink targets, submodules, snapshot hash, immutable snapshot artifact, authenticated actor/receipt/authorization binding, and Project Brain paths. Registration is idempotent; incomplete state, identity mismatch, wrong snapshot, drift, mutable snapshot artifacts, and replay divergence fail closed. Every consensus assignment carries the exact registered snapshot and repository resource, and Mission Agent recomputes the full state before Project Brain or provider work.

The harness preflight now stops with `ACCEPTANCE SETUP FAILURE` unless server trust, migrations/readiness, both authenticated agents, artifact/capability/runtime attestations, repository snapshot and Project Brain inputs, exact role/provider/model eligibility, disabled implementation reviewer, and no fallback are all proven. The changed-model adversarial test asserts the exact assignment, original and attempted provider/model, approval and attestation binding, `disposable_model_assignment_mismatch`, unchanged lifecycle state, and zero provider, fallback, mutation, approval, or child-mission effects.

## Exact unsigned packet

| Item                            | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| Mission Agent artifact          | `42518845b9d9ee9f6a92d9bc99d0125e33f3a721ac25d2fbcd62fbf535209623` |
| Artifact metadata               | `f76995ca96d51e350c27998b0d11578ceeffc62a07f03af96f502a88272972c4` |
| Capability manifest             | `d05e13b9b11159c93c16538c0fc04438097f8db05f69887277c73971c7783908` |
| Source template                 | `c05c223e6f5d5dafcf9f692b463627425ecc89becd85e8390f1e70eac27fc4fd` |
| Build script                    | `0e209f70a3fe0f32f11a96552fa5f09a524e31c0c5fb3d21f404defdb6032791` |
| Provider requirements file      | `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206` |
| Provider requirements canonical | `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3` |
| Provider profiles file          | `93aa3f2e5f17a542ebd06c9d4973f644e777abe292fbb9bb83a9f2bf6717979c` |
| Provider profiles canonical     | `a3ede41f203caa818f2ac020a4933a7b12eea55b736740fca118fd3d57e44607` |
| Discovery harness               | `2256925def8e00d7708e90d0c2b1273bda315ec883a9d3649ba47d1404db2704` |
| Real-acceptance harness         | `82427861d174b6a006aef7e03f89987c09dc09a883689d26b3f1e144646fd76e` |
| Artifact fixture                | `5a4a59efa7c06166e05c62f805bf2ac978bfcfcb822fa4b735c100d79fabb220` |
| Migration 0029                  | `45c5532d05c8392709e01fa0d1fbee2f55cfd345e9ba361e83c7dfd21e610fcb` |
| Rollback 0029                   | `ca0e45d9151f31a13a7c96949d4e617afad18204b922ddaaec9668588a0ab722` |
| Runtime-mode definition         | `2077ca55a498d1d510e1c36f4d3b76388dd76c4d17adbbfbd1d61a6c0857e688` |
| Disposable-registry schema      | `5c4f18147a9fde4a986f63887fc965a832bbd2e5316d7d3d3a52ffcb3bb91758` |
| Repository-snapshot schema      | `59fce8f9d29f061a5b50aed56817a76e525aa12d66fd60e9e698d19d5fc9014e` |
| Proposed registry raw bytes     | `4cdb2f06820e78cdfa9747e200915b8dccc62496b9ed0b360a50381c32751c48` |

The artifact byte length is `259394`. Metadata, capability manifest, deterministic template substitution, embedded catalogs, source commit, and artifact bytes were independently checked for exact agreement.

## Runtime bindings and role assignments

| Profile                          | Runtime binding SHA-256                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `claude-implementation-macos-v2` | `6405187965b7fd8c47d2dcdd7892a3a997e8019c082c5c560a0a3d534b6b99ae` |
| `claude-planning-macos-v2`       | `f85b050c01be1349454ce1e63fdd5ba326a772f9fe391cc4e36adaed823c7eac` |
| `codex-implementation-macos-v2`  | `2a5eeb729d35071b7ec3538b62c557d5f2b8971a4f5e42f3b96faf976b3dab87` |
| `codex-planning-macos-v2`        | `1be10ad47abd12eff570be08ee4e390d4a23f45d55d81adf9e1a3b01df530a8e` |

- Planner A: Claude Code / `claude-fable-5`
- Planner B: Codex / `gpt-5.6-sol`
- Synthesizer: Claude Code / `claude-fable-5`
- Executor: Codex / `gpt-5.6-luna`
- Implementation reviewer: disabled
- Fallback: disabled

Actual runtime model identity remains honestly `unverifiable` because neither approved CLI exposes independent proof for every invocation. Acceptance will still verify that the exact model argument is passed and accepted and will stop on any detectable mismatch.

## Local validation

- Exact candidate credential-free artifact gate: 8/8 passed.
- Full unit suite using the exact candidate: 196/196 passed.
- Full serial integration suite: 93/93 passed.
- Consensus integration suite in isolation: 20/20 passed.
- Disposable trust/repository snapshot/consensus focused suite: 18/18 passed.
- Authenticated browser acceptance: 2/2 passed.
- TypeScript typecheck: passed.
- ESLint with zero warnings: passed.
- Prettier check: passed.
- Mission Agent and discovery-harness syntax: passed.
- `git diff --check`: passed.
- Next.js production build: passed locally without instrumentation warnings.
- Fresh migration apply/status through 0029: passed.
- Destructive 0029 rollback on the exact disposable database: passed; all three target objects were absent.
- Forward reapply: passed; migration 0029 and immutable snapshot trigger were restored.
- Repository snapshot projection deletion/replay: passed in integration; state, snapshot hash, checksum, and deterministic artifact ID were restored exactly, and the artifact update trigger rejected mutation.
- Event-backed Project Brain replay checks remained equal (`16bc…`: 6 events; `8355…`: 5 events). The shared integration database contains intentionally direct test fixtures and is not represented as a whole-workspace replay pass.
- Production dependency audit (`npm audit --omit=dev --audit-level=high`): 0 vulnerabilities.
- Full dependency audit: one high advisory in `brace-expansion@5.0.8`, bundled under latest `aws-cdk-lib@2.263.0`. It is dev-toolchain-only, has no available upstream package upgrade, and is retained as one low-severity project residual.

## Secret scans

Exact-value tests proved that raw Mission Agent credentials, credential-bearing remote markers, and raw lease bearer tokens were absent from durable events, receipts, identities, repository records, audit records, and local durable state. High-confidence credential-pattern scans found zero OpenAI, Anthropic, AWS access-key, GitHub token, or Slack token patterns. The sole private-key header match is an intentional synthetic redaction fixture in `tests/mission-agent-0.8.test.mjs`; the test proves it is redacted. No real provider secret was accessed during runtime-v4 remediation or validation.

## Independent review

The final post-build independent security/correctness/runtime review reports:

- High: 0
- Medium: 0
- Low: 1

The reviewer independently verified the artifact, metadata, capability manifest, byte length, source/template substitution, embedded provider catalogs and canonical hashes, four runtime bindings, syntax, fixture-only sidecar correction, exact registry fixture profile IDs, empty staging area, and production isolation. The sole low is the dev-only dependency advisory described above.

## Differences from runtime-v3

Runtime-v4 adds explicit non-production runtime trust; fail-before-effects harness isolation; sole-registry packet, catalog, runtime-binding, and model authority; metadata/capability sidecar attestation; authenticated complete repository registration and immutable replayable snapshots; exact Project Brain/snapshot assignment binding; mandatory structured preflight; exact changed-model assertions; deterministic serial full-integration execution; and corrected credential-free artifact fixtures. It does not alter the preserved runtime-v3 evidence or convert it into workflow acceptance.

## Stop and approval boundary

The proposed registry file is `MISSION_AGENT_080_RUNTIME_V4_PROPOSED_DISPOSABLE_REGISTRY.json`, issued `2026-08-05T14:45:57Z` and expiring `2026-08-06T10:45:57Z`. It has not been added to the disposable acceptance registry. A fresh human approval must name every checksum above, the four runtime bindings, the raw registry SHA-256, the registry validity interval, and the exact no-fallback role assignments before copying those exact bytes into a protected disposable registry or executing any real provider.

No source or artifact was staged, committed, signed, published, pushed, merged, added to a registry, or deployed. No production endpoint, database, credential, migration, or runtime was contacted or changed. Deployed Mission Agent 0.7.2 remains unchanged.
