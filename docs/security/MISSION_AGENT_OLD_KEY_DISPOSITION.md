# Mission Agent 0.6.8 signing-key disposition

Decision date: 2026-07-25
Decision authority: authorized Mission Control release owner

> The private key corresponding to the 0.6.8 trust root is presumed unrecoverable after a focused local custody investigation. No evidence of compromise was found.

- Key identifier: `ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a`
- Release Authority key ID assigned for historical verification: `mission-agent-release-2026-00`
- First known use: commit `4a97e6a32f2cbc577875c8f4ce4f774b21f03430`, 2026-07-25
- Last known signed release: Mission Agent 0.6.8
- Investigation: original worktree, Gitignored files, local Codex sessions, local temporary directories, available shell history, Trash, and accessible local snapshot metadata
- Result: no matching private key recovered
- Compromise status: no evidence of compromise; do not classify as compromised
- Future status: retiring; valid only for the already-approved historical 0.6.8 release and unable to authorize a new release

The old public key remains present during the first rotation release so existing
0.6.8 evidence continues to verify. Its missing private key is not a reason to
weaken verification or allow a new key to authorize itself.
