# Consensus provider-runtime acceptance — superseded attempt

**Disposition: NO-GO — provider sandbox incompatibility**

This record preserves the failed disposable acceptance of the exact unsigned Mission Agent 0.8.0 packet approved on 2026-08-04. It is historical evidence, not release approval. The packet must not be reused after any diagnostic, runtime-profile, sandbox, template, catalog, or artifact change.

## Frozen packet

- Mission Agent artifact SHA-256: `52a2a20f8058351ecd91ed431dbc65a107c5e4489c40b938cc4a3e10a2fc2dbd`
- Artifact metadata SHA-256: `fa5ca6f83c675b96b137b82ba5447fa106efb347852d23b240f594be6a667200`
- Capability manifest SHA-256: `52f9524747e94bed8298e37e382a63c7eee20a3cfc083bb1d03c74797c05fd01`
- Source base: `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`
- Source-template SHA-256: `896a29247a486479ca390c91d358135537541d05c9a49af19e9b6541a5bf0258`
- Build-script SHA-256: `601b03d980a1463fc535e40e880fd614f375f5e34ebf8a6ea4a0c2ea093ed080`
- Provider-catalog file SHA-256: `1f90d098743977b65dccd91ca6d36619f6fe7d7cb8e62402b82969d49fbab206`
- Canonical provider-catalog SHA-256: `4b9a344fe39ec1ea953d2befca8a4c205d9819033ce6f6383bd8dd3a030f99f3`
- Disposable registry evidence SHA-256: `155afc5e87d5f7d3ce8fdd99fd33ee5d3e5e1c9732593c7243f2de14b992b48d`
- Failed-run evidence SHA-256: `0c7a7ff0464ea745f4ef0aa2a012566d44f5467bbe04708ad0189178a242aa49`
- Adversarial evidence SHA-256: `877892be9bf2eb9fcb1c9b1e0d9d235e2fa28ad9d36084d74153ec0bafdd4c8a`

## Runtime and assignments

| Role        | Provider    | Requested model  | CLI         | Runtime requirement        | Runtime hash                                                       |
| ----------- | ----------- | ---------------- | ----------- | -------------------------- | ------------------------------------------------------------------ |
| Planner A   | Claude Code | `claude-fable-5` | `2.1.221`   | `claude-code-cli/macos-v1` | `5807d6a089063ff99e7405aae07bbe783516baffe1952e5eda434f6d0606d423` |
| Planner B   | Codex       | `gpt-5.6-sol`    | `0.146.0`   | `codex-cli/macos-v1`       | `3e517330bd9c34e71da0ff0946343fe7de0c10da068276add48c2dcf886a0622` |
| Synthesizer | Claude Code | `claude-fable-5` | not reached | `claude-code-cli/macos-v1` | `5807d6a089063ff99e7405aae07bbe783516baffe1952e5eda434f6d0606d423` |
| Executor    | Codex       | `gpt-5.6-luna`   | not reached | `codex-cli/macos-v1`       | `3e517330bd9c34e71da0ff0946343fe7de0c10da068276add48c2dcf886a0622` |

Both authenticated readiness probes passed after the harness used the exact supported executables. A separate earlier heartbeat resolved repository-local Codex `0.144.6`; Mission Control marked the runtime contract unsatisfied and withheld Planner B work without fallback.

## Failure evidence

- Codex Planner B received the exact `--model gpt-5.6-sol` argument. The governed process exited before accepted output because the outer macOS sandbox denied initialization of the in-process app-server client: `Operation not permitted`.
- Claude Planner A received the exact `--model claude-fable-5` argument. The governed process exited without accepted structured output; the failed packet did not persist enough redacted diagnostic detail to distinguish sandbox denial, adapter parsing, or another initialization failure.
- Direct read-only schema diagnostics outside the Mission Agent outer sandbox succeeded for both exact models. Claude provider telemetry reported the requested Fable model and an internal Haiku helper. These direct results establish model availability only; they are not governed acceptance.
- The consensus mission failed before any accepted proposal. Synthesis, verdicts, human approval, child creation, executor execution, validation, learning, and the downstream recovery matrix were not reached.

## Repository and replay state

- Disposable repository HEAD: `9c872c27a6b344f16c6b2b1263906198f2385dfd`
- Worktree: clean, including untracked-file inspection
- Repository mutation during planning: none observed
- Projection replay: equal, 654 events, zero discrepancies across the disposable database
- Durable credential matches: `0`
- Artifact-file credential matches: `0`
- Provider-log credential scan: unavailable because bounded provider diagnostics were not durably persisted

## Review disposition

Independent review found two unresolved high-severity blockers: governed Codex planning is unusable inside the approved profile, and governed Claude planning is unusable inside the approved profile. The failed packet is superseded for investigation and cannot proceed to commit, signing, publication, registry reuse, production access, or deployment.
