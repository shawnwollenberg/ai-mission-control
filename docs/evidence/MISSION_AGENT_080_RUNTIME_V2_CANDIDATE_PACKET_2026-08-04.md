# Mission Agent 0.8.0 runtime-v2 unsigned candidate packet

**Status:** unsigned development candidate; not registry-approved; not accepted; not production-ready
**Source base:** `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549` (transitional provenance accepted only for disposable testing)
**Production contacted:** no

The prior approved packet remains immutable and is superseded as **NO-GO — provider sandbox incompatibility**. This packet has different artifact, metadata, capability, template, migration, runtime-profile, and invocation identities and therefore requires a new exact human approval before registry insertion or real-provider execution.

## Candidate checksums

| Component                                                                    | SHA-256                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Mission Agent artifact `public/mission-agent-0.8.0-runtime-v2.candidate.mjs` | `1b0c2549989b3a298bd7e510526b5fcb06e889c926a15d5c7a28b9f2a44e95ee` |
| Artifact metadata                                                            | `25a73475a7e7181e83f0e84c23f74d86074899c4bc4761232974d3f727679621` |
| Capability manifest                                                          | `95a0298a4f6fd6c40bdffdd454057959b1fa4adc25e18fbfac53343c52c63222` |
| Provider-requirements file                                                   | `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206` |
| Canonical provider requirements                                              | `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3` |
| Provider-profile catalog file                                                | `c54338fc7210e65a6394b1f2dbe2499ab4dd6801b6091dc95e7b7b116783e00b` |
| Canonical provider-profile catalog                                           | `2a848456386ef35b8c1823719503818b4f6ac8c04c6420100c5649ca3801f9e0` |
| Source template                                                              | `1875be43526388bd85e5cec4f0cbe1e3de3d95b8fb9ee57800e88fc1c0345690` |
| Build script                                                                 | `bc54e1d6f75a7ff82bc7800ce144d8ffcfae6023c77263782454cec00fa2f1c7` |
| Discovery harness                                                            | `4f16d17f550e1b03270780427cad43ce6ed84867a974ba96c19e5a0ac78f8d1e` |
| Migration 0029                                                               | `e9940895bf434ee46c1bc2b752c640c94369469269fb03d43dd5c89eda13f220` |

Artifact byte length: `248758`. The artifact metadata and capability manifest both bind the exact artifact checksum. The candidate passes `node --check`.

## Runtime-profile bindings

| Profile                          | Definition hash                                                    | Runtime binding hash                                               |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `codex-planning-macos-v2`        | `3cef739aca9b5e0ad7ed417a5e2f0a772c010e3ef20c6f80eb4e3724be623fe7` | `9e63c8f5ec22de172933dd931fadbe52f941122d0941a2439abcdfe814a71d6e` |
| `codex-implementation-macos-v2`  | `b6836870c50abe53b13fb3d61800e63763c66a3f13211adb9fca8d5a7c126ed2` | `996a5ed5690ec6d994e7bf1f2ce1d670acd16670238687385d0f776c8228ff5e` |
| `claude-planning-macos-v2`       | `cee81b854355749392507520626ad12d976ce19589de6c3283a4f7c4408556a5` | `435496d9a26d3bec4cecb42560b13eb913548399452d16f54c503dd507acabf5` |
| `claude-implementation-macos-v2` | `b290d690f2e995368461e1bf0fa72440adba4ea68a82bf5343d982fa0c442b24` | `31160505ec80e69a463c2c13a6642141357cfa014e4f24a6df303a987a9f6410` |

Bindings include the PATH launcher bytes/path, exact invoked executable bytes/path, install/runtime roots, agent runtime root, sandbox-template bytes, and provider-specific credential-reference identities. Codex invokes its bound native binary directly. All executable and credential-reference checks occur before provider version, authentication, or mission subprocesses.

## Differences from the failed packet

- Adds durable, immutable, bounded provider-runtime diagnostics with exact-value/pattern redaction and server scanning.
- Replaces the incompatible shared isolation assumptions with four provider/operation-specific macOS profiles.
- Brokers Claude's exact Keychain item outside the sandbox and provides only its OAuth token in memory; Codex uses an exact read-only auth symlink.
- Binds both launcher and actual invoked executable identities; Codex bypasses the unbound JavaScript launcher.
- Binds complete repository state v2, including actual tracked bytes, modes, symlink targets, untracked and relevant ignored content, and submodule status.
- Adds transactional fail-fast fencing and deterministic stale-output race coverage.
- Separates requested primary-model provenance from provider-reported auxiliary activity.
- Delays terminal execution success until telemetry is validated and persisted.
- Adds bounded SIGTERM/SIGKILL process-group handling and execution-finally provider-state cleanup.

## Validation evidence

- Unit: `189/189` passed.
- Integration: `90/90` passed; consensus subset `17/17` passed.
- Browser/end-to-end: `2/2` passed against a fresh disposable database.
- Migration: fresh application of migrations `0001` through `0029` passed with zero pending.
- Rollback: migration 0029 rollback completed; consensus projections, provider diagnostics, and migration ledger entry were absent afterward.
- Projection replay: equal `true`, `81` events, zero discrepancies.
- TypeScript, Prettier, ESLint, candidate syntax, and Next.js production build: passed.
- Production dependency audit: zero high/critical and two moderate findings (`next`/`postcss`).
- Full dependency audit: one development/toolchain high (`brace-expansion`) and the same two moderates; it is not represented as clean.
- Independent runtime security/correctness review: zero unresolved high-severity findings after repeated review.

## Remaining medium-severity limitations

- Normal completion, retries, and lease-renewal loss do not universally prove descendant-process quiescence; process-group verification cannot detect a descendant that daemonizes into another group.
- The macOS sandbox remains broad in process creation, external TCP/UDP, metadata/non-home reads, and Mach lookup; a focused negative isolation matrix remains to be run.
- The exact direct-native product argv/profile composition, including Codex auxiliary-feature disabling, has not undergone real-provider acceptance. Existing `/tmp` reports are prior-launcher facility-discovery evidence only.
- Discovery-report excerpts use pattern redaction rather than the product diagnostic path's exact in-memory credential-value scan.
- Dirty nested submodule worktree bytes are represented by gitlink HEAD/status rather than a recursive byte manifest.
- A narrow hash-to-spawn TOCTOU window remains against an equally privileged local actor.
- Actual provider-service model identity remains independently unverifiable when the CLI supplies no proof; accepted model arguments and provider telemetry must be reported honestly.

## Required next approval

Before any registry change or provider invocation, obtain exact approval for this artifact, metadata, capability manifest, source base, source template, build script, provider-requirements file/canonical hash, provider-profile file/canonical hash, all four runtime-profile definition/binding hashes, direct-native invocation contract, and the exact role/provider/model allowlist. No fallback is permitted.

The proposed disposable-acceptance allowlist is:

| Role                    | Provider    | Exact model      |
| ----------------------- | ----------- | ---------------- |
| Planner A               | Claude Code | `claude-fable-5` |
| Planner B               | Codex       | `gpt-5.6-sol`    |
| Synthesizer             | Claude Code | `claude-fable-5` |
| Executor                | Codex       | `gpt-5.6-luna`   |
| Implementation reviewer | Disabled    | None             |

This packet is not signed, staged, committed, published, pushed, registered, accepted, or deployed.
