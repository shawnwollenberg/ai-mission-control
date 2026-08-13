# Mission Agent 0.8.0 provider-runtime profile discovery

**Status:** development evidence only — not approved, signed, published, or production-ready
**Date:** 2026-08-04
**Source base:** `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`
**Production contacted:** no
**Mission Control production contacted:** no

The previously approved packet remains immutable and failed. Its evidence is retained separately in
`CONSENSUS_PROVIDER_RUNTIME_NO_GO_2026-08-04.md` as **NO-GO — provider sandbox incompatibility**. The old packet must not be reused.

## Root causes

1. The old Seatbelt profile first allowed global reads, then explicitly denied the user, volume, and host temporary trees, and then attempted to re-allow narrower provider and assignment paths. An explicit Seatbelt deny wins, so both providers were denied their intended scoped paths.
2. Early discovery paths compared `/var/folders/...` with `/private/var/folders/...`. Canonicalizing every assignment and provider root with `realpath` removed the apparent need for broad host-temporary access.
3. Codex implementation under two nested Seatbelt authorities exited successfully but its internal `sandbox_apply` helper failed with `EPERM`, producing no diff. The corrected implementation profile makes Mission Agent's outer Seatbelt profile the sole filesystem authority, disables Codex's shell tool, and invokes Codex with its documented internal sandbox bypass. The outer profile allows writes only to the exact disposable worktree and assignment-private state and denies `.git` metadata writes.
4. Claude's native login path required broad Keychain directory access. The corrected profile resolves and hash-binds the exact default-keychain path and account metadata, then uses service + account + keychain as the broker lookup tuple before sandbox entry. It extracts `claudeAiOauth.accessToken` in memory and gives the sandboxed process only the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. The token is not written to evidence or provider state.
5. The first review found that discovery had retained copied Codex credentials. All 43 disposable discovery roots (including 45 `auth.json` copies) were removed. Discovery and product source now use an assignment-private symlink to the exact read-only source credential, never copy credential bytes, and remove probe/provider roots on every handled terminal path.

## Final proposed profiles

The complete proposed definitions are in `domain/provider-runtime-profiles.proposed.json`.

| Profile                          | Definition hash                                                    | Runtime binding hash                                               | Minimum demonstrated facilities                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-planning-macos-v2`        | `3cef739aca9b5e0ad7ed417a5e2f0a772c010e3ef20c6f80eb4e3724be623fe7` | `9e63c8f5ec22de172933dd931fadbe52f941122d0941a2439abcdfe814a71d6e` | Exact Codex 0.146.0 launcher and native executable bytes/paths, direct native invocation, hash-bound read-only auth reference, assignment-private HOME/TMP/CODEX_HOME, read-only repository scope, external TCP/UDP plus exact mDNS resolver socket, no loopback |
| `codex-implementation-macos-v2`  | `b6836870c50abe53b13fb3d61800e63763c66a3f13211adb9fca8d5a7c126ed2` | `996a5ed5690ec6d994e7bf1f2ce1d670acd16670238687385d0f776c8228ff5e` | Planning facilities plus exact worktree writes excluding `.git`; outer Seatbelt is sole authority; Mission Agent performs validation and local commit                                                                                                            |
| `claude-planning-macos-v2`       | `cee81b854355749392507520626ad12d976ce19589de6c3283a4f7c4408556a5` | `435496d9a26d3bec4cecb42560b13eb913548399452d16f54c503dd507acabf5` | Exact Claude 2.1.221 direct executable bytes/path and roots, isolated HOME/TMP, exact service/account/keychain broker binding, external TCP/UDP plus exact mDNS resolver socket, no loopback, Bash/write/web tools disabled                                      |
| `claude-implementation-macos-v2` | `b290d690f2e995368461e1bf0fa72440adba4ea68a82bf5343d982fa0c442b24` | `31160505ec80e69a463c2c13a6642141357cfa014e4f24a6df303a987a9f6410` | Planning facilities plus Read/Edit/Write/Grep/Glob in the exact worktree; Bash/web tools disabled; guard hook and outer Seatbelt enforce worktree scope                                                                                                          |

All four runtime bindings include exact CLI version, PATH-resolved launcher SHA-256/path identity, exact invoked executable SHA-256/path identity, resolved install/runtime-root identities, agent runtime-root identity, exact sandbox-template byte hash (`2ad5c2ecbffc87c6cdea54e05a0efd5f746e1b4f112c7904a5d153d4155e1791`), and provider-specific credential-reference identities: the Codex auth path or the Claude keychain/account tuple. Codex bypasses its JavaScript launcher and invokes the exact hash-bound native binary directly. Executable and credential-reference identities are checked before every provider version, authentication, or mission subprocess; a changed PATH executable that merely prints the approved version is rejected without execution or credential access.

## Discovery matrix

| Dimension                          | Codex 0.146.0                                                            | Claude Code 2.1.221                                                   | Result                                                             |
| ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Direct authenticated reference     | `login status` passed                                                    | `auth status` passed                                                  | Baseline provider sessions valid                                   |
| Old conflicting deny profile       | Provider state inaccessible                                              | Provider state/Keychain inaccessible                                  | Root cause reproduced                                              |
| Canonical assignment paths         | Isolated state passed                                                    | Isolated state passed with credential broker                          | Broad `/private/var/folders` access unnecessary                    |
| Provider installation/runtime tree | Required                                                                 | Required                                                              | Narrow resolved installation roots retained                        |
| HOME/config                        | Isolated HOME with exact read-only `auth.json` symlink; no copied bytes  | Isolated HOME; no `.claude` read                                      | Passed                                                             |
| Keychain                           | None inside provider                                                     | Exact item read by broker before sandbox; no Keychain path in sandbox | Passed                                                             |
| Structured planning                | `gpt-5.6-sol` accepted                                                   | `claude-fable-5` accepted                                             | Passed; actual runtime identity remains independently unverifiable |
| Implementation                     | `gpt-5.6-luna` produced the exact README-only diff under outer authority | `claude-fable-5` produced the exact README-only diff                  | Passed postcondition, not exit-code-only                           |
| Git metadata                       | HEAD unchanged; only README modified                                     | HEAD unchanged; only README modified                                  | Passed                                                             |
| External network                   | External TCP/UDP plus mDNS resolver only                                 | External TCP/UDP plus mDNS resolver only                              | Required for inference and sufficient                              |
| Loopback/inbound/bind              | Denied                                                                   | Denied                                                                | Passed provider operations                                         |
| Arbitrary Unix sockets             | Denied; mDNS resolver is the sole exception                              | Denied; mDNS resolver is the sole exception                           | Passed provider operations                                         |
| Shell/provider tools               | Codex shell tool disabled                                                | Bash, WebFetch, WebSearch, and NotebookEdit disabled                  | Passed exact probes                                                |
| Cancellation                       | Detached group terminated; no remaining process group                    | Detached group terminated by SIGTERM; no remaining process group      | Passed                                                             |
| Timeout                            | Termination attempted; no remaining process group                        | Termination attempted; no remaining process group                     | Passed                                                             |
| Read-only repository state         | Complete before/after snapshot identical                                 | Complete before/after snapshot identical                              | Passed                                                             |
| Temporary state cleanup            | Assignment-private roots; zero retained roots after probes               | Assignment-private roots; zero retained roots after probes            | Passed; handled exit and signal cleanup is enforced                |
| Telemetry                          | Primary model not independently exposed                                  | Primary and internal Haiku helper reported by provider telemetry      | Helper stored separately; unknown usage is never coerced to zero   |

The discovery harness also varied provider configuration/cache paths, Keychain and Library paths, HOME, host temporary roots, process signaling, POSIX IPC, file ioctl, Mach/sysctl access, file locks through assignment-private writes, app-server startup, child processes, network modes, and broad diagnostic controls. Broad host file access and broad host writes were diagnostic controls only and are not present in any proposed profile.

## Final real-provider evidence

The JSON reports are disposable local files under `/tmp`; their hashes make this summary tamper-evident without adding raw provider logs to the repository.

**Evidence boundary:** these reports predate the post-review change from the PATH launcher to direct hash-bound native invocation and therefore prove the minimum facility discovery only. They are immutable prior-launcher evidence, not acceptance evidence for the new profile bindings or candidate packet. The direct-native product argv/profile composition requires fresh exact approval and a new real-provider run; it has not been executed under this changed runtime contract.

| Evidence                                                 | Internal report hash                                               | File SHA-256                                                       | Outcome                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `/tmp/mc-provider-runtime-codex-planning-v3.json`        | `61b590270ae60396cf5e9e597c6802a030abcc9b919926e88a702d4e6dbc63a9` | `8afdfc55e0f4d389f388e8c9704cebde1ba0c1229a8152adaa1d5d21079f7090` | exact `gpt-5.6-sol`; read-only structured plan passed    |
| `/tmp/mc-provider-runtime-claude-planning-v3.json`       | `a31b6b94a82609a28bc998252b0e1609eeab034314db1d39fc9070a6c4d87017` | `f55bd95127eec9498a33c0d71218d7bb883617d85208ee20ebc5c3a20124beb6` | exact-keychain broker + structured planning passed       |
| `/tmp/mc-provider-runtime-codex-implementation-v3.json`  | `cb7af40984978e6380671f09d16b652502375afa9a6ca836f5573a9dd3d180ef` | `d287e8a0759c87dac35c0108f47a6d22c262d947fd4a84427269a4bb9fbe6529` | exact `gpt-5.6-luna`; README-only postcondition passed   |
| `/tmp/mc-provider-runtime-claude-implementation-v3.json` | `dd3def3cbb9fcd275362f66527d777fc10b62e13c08c9c3610681dec0d25536d` | `8cfe8a7afeebfb95b902d2bdc122cf42d2d025c19347c42295669e477fbd9994` | exact `claude-fable-5`; README-only postcondition passed |
| `/tmp/mc-provider-runtime-codex-lifecycle-v3.json`       | `0d06a4b3799b4c9536cfbd47523a4010de63a8c86d2b0811449cdbb1a67557ab` | `49afa029abbe160da811862269e7c26221fa5c5e4ed411966a2dba98fa9733c6` | cancellation + timeout process-group cleanup passed      |
| `/tmp/mc-provider-runtime-claude-lifecycle-v3.json`      | `066d1a319f692ebf260f710c8b1d2a7ff70024d9051be377eff40720bf26e4fc` | `e9b3351ed92094e719b68e8d308085da870a0fbd4f404c644252024be93acb5c` | cancellation + timeout process-group cleanup passed      |

No provider output independently proves the actual runtime identity selected by the provider service. The CLIs accepted the exact requested `--model` values. Claude telemetry reported the requested `claude-fable-5` primary and provider-managed `claude-haiku-4-5-20251001` auxiliary activity; both identities remain provider-reported, not independently verified.

## Security invariants retained

- Planning repository access is read-only, and disposable consensus creation requires the registered complete snapshot to be clean.
- Complete state v2 binds HEAD, tracked status, every tracked worktree file's actual bytes/mode/symlink target against its index object (including skip-worktree/assume-unchanged bypasses), untracked content/modes/symlink targets, policy-relevant ignored content, and recursive submodule status.
- Provider state and temporary files are assignment-scoped and cleaned after terminal handling.
- No provider sees the real HOME, unrelated repositories, `.claude`, raw Keychain directories, SSH/cloud/package-publishing credential directories, or Mission Control credentials.
- Loopback, inbound network, bind, and arbitrary Unix sockets are denied.
- Provider tool surfaces cannot commit, push, publish, deploy, sign, or invoke unrestricted shell. Git validation and the permitted local commit remain Mission Agent operations after provider exit.
- Every exact profile definition and runtime binding (executable bytes/roots, sandbox template, and provider-specific credential-broker identities) is hash-bound into heartbeat status and the capability attestation; the selected runtime binding hash is bound into participant assignments, permission hashes, pull payloads, lease revalidation, diagnostics, receipts, events, and artifacts. Actual rendered sandbox bytes are recorded separately in provider diagnostics.
- Cancellation first fences both planner outputs in the same transaction as the terminal consensus event; sibling success/artifacts/heartbeats are then rejected while failure/cancellation evidence remains accepted.
- Provider diagnostics are immutable, bounded, locally checked against exact in-memory credential values plus encoding/pattern rules, server rescanned, and reduced to hashes/metadata if any check fails.

## Remaining limitations

- External provider inference cannot be constrained to stable hostname allowlists by the current Seatbelt policy; the profiles therefore allow outbound TCP/UDP while denying loopback and local sockets except mDNS. This is explicit and hash-bound.
- Codex implementation relies on the outer Mission Agent Seatbelt profile because nested Seatbelt is incompatible with its edit helper. The bypass changes only Codex's internal sandbox; it does not bypass the outer OS sandbox.
- CLI acceptance of `--model` is observable, but actual provider-service runtime model identity is not independently verifiable.
- Claude auxiliary-model identity and usage are provider-reported. Missing auxiliary usage is recorded as unknown, not zero.
- The ignored-file policy intentionally excludes dependency/build caches (`node_modules`, `.next`, `dist`, `build`, `coverage`, `.turbo`, `.cache`, and `vendor`) from the relevant-ignored content manifest. Consensus provider planning consumes the bounded Project Brain context rather than those directories.

## Local validation so far

- Fresh disposable PostgreSQL database migration through `0029_consensus_plan.sql`: passed, zero pending migrations.
- Unit suite: 189/189 passed.
- Consensus integration suite: 17/17 passed, including a deterministic prevalidated-artifact/terminal-failure race and telemetry-before-terminal-success validation.
- TypeScript typecheck: passed.
- Template and harness syntax checks: passed.

Artifact rebuild remains prohibited until the fresh independent review reports zero unresolved high-severity findings.
