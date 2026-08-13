# Project Brain 0.4.2 remote transport report

Date: 2026-07-24

## Scope

- Mission Control branch: `codex/project-brain-0.4.2-remote-transport`
- Mission Control base: `e2f1b543`
- Project Brain branch: `codex/project-brain-0.4.2-remote-consumer`
- Project Brain base: `6708a0f`
- Project Brain core: `0.4.0`
- Consumer contract: `1.0`
- Artifact schema: `2.5.0`

No dependency upgrade is included. Next.js remains `16.2.10`; the separate 16.2.11 maintenance assessment is
unchanged.

## Capability and protocol contract

Each heartbeat advertises whether Project Brain is installed, its exact core version, supported consumer contracts
and schemas, allowlisted read/write operations, request/result byte limits, inline artifact transport, runtime
readiness, and diagnostics status. Mission Control persists the advertisement and timestamp and refuses dispatch
when it is absent, older than five minutes, incompatible, not ready, or revoked.

`RemoteProjectBrainOperationRequested` contains only validated fields: protocol/request/operation identity,
workspace/agent/repository/mission/execution bindings, opaque `mission-agent://` locator and fingerprint,
allowlisted operation arguments, starting SHA, exact required versions, approval and fingerprint, policy and
authorization snapshots, artifact kinds, bounds, timestamps, expiry, nonce, canonical SHA-256, and an HMAC
signature. No command string or central filesystem path is transmitted. Responses bind the request checksum,
starting/ending SHA, versions, duration, bounded process hashes, validated consumer envelope, and artifact
descriptors, then carry their own canonical checksum.

## Dual authorization and repository resolution

Mission Control authorizes before creating the durable remote assignment and consumes an exact, unexpired approval
for writes. The Mission Agent verifies the request checksum/signature, identities, expiry, nonce, policy snapshot,
approval fingerprint, versions, operation, local write opt-in, and starting HEAD. It then calls the authenticated
live-reauthorization endpoint immediately before execution. That endpoint rechecks active agent status, emergency
controls, repository flags, agent allowlisting, resource permission, mission binding, HEAD, and the exact consumed
approval. A canonically started exact operation remains recoverable after request or approval expiry; expiry still
blocks starting new work.

The server never resolves a remote checkout. The Mission Agent uses only its protected repository map, requires an
absolute canonical path, rejects a changed/symlinked mapping, confirms Git top-level containment, stable repository
identity/fingerprint, current HEAD, and a clean or previously verified Project Brain-only worktree.

## Execution, artifact, and context integrity

The agent maps operations to fixed `project-brain consumer --operation ...` argument arrays, uses `shell: false`, an
explicit executable and checkout, an allowlisted environment, wall-clock and byte bounds, and captured
stdout/stderr hashes. A detached durable runner persists its specification before spawn, PID/liveness evidence,
bounded output files, and an atomic terminal result. Restart recovery either resumes/reconciles the exact request or
retains ambiguous changed bytes for operator reconciliation.

Returned repository-relative paths are allowlisted by operation and resolved under the checkout. The agent and
Mission Control independently verify size, SHA-256, schema, repository SHA, total bounds, and response checksum.
Writing operations create a local Git commit through plumbing from an exact parent and exact index intent; retries
verify or reconstruct that transition without rerunning the operation. The first lost callback is retried from the
durable receipt and does not duplicate the write.

Final context bytes are stored as an immutable Mission Control artifact and dispatched unchanged in the pending
execution assignment. The coding agent recomputes the checksum before planning, reports received and verified
checksums in its execution-start evidence, and stops on byte, checksum, or HEAD mismatch. The context artifact
commit changes repository SHA A→B; execution is deliberately bound to B while the pack's consumer binding retains
source SHA A.

## Canonical events and projections

Capability advertisement is recorded as
`agent.remote_project_brain_capability_advertised`. Remote lifecycle events use
the existing `project_brain.*` convention:

- `remote_operation_dispatched`
- `remote_operation_accepted`
- `remote_operation_started`
- `remote_operation_denied`
- `remote_operation_failed`
- `remote_artifact_received`
- `remote_artifact_rejected`
- `remote_artifacts_versioned`
- `remote_context_verified`
- `remote_context_mismatch`
- `remote_repository_head_changed`

Terminal domain facts continue to use `operation_succeeded`, `context_generated`, `closure_recorded`,
`learning_proposed`, and `learning_evaluated`. Repository, mission, and operation projections are derived only from
canonical events.

## Disposable lifecycle evidence

The acceptance script `scripts/run-project-brain-042-remote-acceptance.ts` created a temporary Git repository known
only to a pull-mode Mission Agent and ran the production-built server plus the real installed Project Brain CLI. It
completed explicit approved initialization, remote validation, context preview, final context generation,
context-bound execution approval, a real Codex code change and local commit, closure, proposal, and evaluation.

Recorded successful run:

```text
disposition: remote_project_brain_artifact_lifecycle_passed
initial SHA: a15db6f38de99ba3b0aeca94a8ab36e540e934ac
execution starting SHA: 8a259889543174ea1519916f9aa242b69442bc9d
execution commit: bc194671b62e2bb2ae3fbbf849da2d3bb6cb64ba
closure ending SHA: 7ef8c82ccd8fc5971b07653546b0f9ad2ee49e9e
context SHA-256: ff765dcea6a3fc3669f04b8b285edd5e72c8b34506cfc38a29e3724599d0dfc1
context bytes: 3888
authoritative remote artifacts: 30
proposed learnings: 1
evaluations: 1
canonical Project Brain events: 79
automatic promotion: false
```

Context selection used 9 of 28 candidates, 9,702 of 26,721 source bytes, with a 63.69% reduction. It reported
complete explicit-source coverage, no missing or budget-rejected sources, and made no optimality claim.

The mission projection recorded the same `ff765d…` checksum as the immutable artifact, the agent-received
checksum, and the agent-verified checksum. Closure is `recorded`, proposal is `proposed`, and evaluation is
`evaluated`. The read-only inbox contained exactly one proposed learning and one evaluation; repository projection
and artifact queries both reported zero confirmed learnings.

Workspace-scoped rollback verification replayed all 152 lifecycle events and returned `equal: true` with no
discrepancies. The lifecycle contained 79 canonical Project Brain events and every required capability, dispatch,
accept, start, artifact, context verification, closure, proposal, and evaluation semantic.

An isolated independent reviewer inspected the actual disposable code commit against its exact parent. The diff
was one line (`app.js` value 1→2), `git diff --check` passed, commit-contained module evaluation returned `value=2`,
and no findings were reported. The code commit remained isolated; main contained only governed Project Brain
artifact commits, proving there was no merge or publication.

## Failure matrix

The remote transport suites exercise the required fail-closed cases across protocol, Mission Agent,
governed-command, integration, execution, recovery, and projection tests:

| Failure                                                                      | Expected durable/safe outcome                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| Missing, stale, incompatible, or revoked capability                          | No assignment; blocked/denied projection              |
| Unknown registration, locator/fingerprint mismatch, traversal/symlink escape | Agent refuses before invocation                       |
| Starting SHA/HEAD change or dirty unverified worktree                        | Stale/blocked; historical context retained            |
| Missing/expired/mismatched approval or denied policy                         | No write; canonical denial                            |
| Invalid signature/checksum, expired request, replayed nonce                  | Agent refuses; no invocation                          |
| Duplicate request/callback/outbox delivery                                   | Stable idempotency receipt; one operation/write       |
| Timeout, disconnect, restart, or lost callback                               | Bounded termination or durable recovery/retry         |
| Invalid envelope, oversized output, partial artifact, checksum mismatch      | Artifact/result rejected before display or dispatch   |
| Context or reported-consumption mismatch                                     | Execution stops; mismatch/stale evidence persists     |
| Projection rebuild                                                           | Live and replayed projection hashes must be identical |

The clean validation run passed 106 Mission Control unit tests, 55 database-backed integration tests, all 16
focused remote transport/recovery cases, and all 68 standalone Project Brain tests. Fresh migrations applied
`0001` through `0026`, the seed was successful, global projection verification returned `equal: true`, lint and
typecheck passed, every changed formatter-supported file passed Prettier, and the production build completed.
Repository-wide Prettier still reports six unrelated pre-existing files outside this change.

## Deliberate exclusions and disposition

There is no automatic initialization, automatic promotion, arbitrary shell, central path disclosure, source-code
write through Project Brain authority, push, merge, publication, or deployment. The learning inbox is read-only.
Repository-local Markdown/YAML remains authoritative.

Release disposition: **GO for review/merge**. The final independent re-review found no unresolved critical or high
findings, verified the shipped agent checksum against both the public manifest and onboarding route, independently
ran all 68 Project Brain tests, and confirmed the final governed disposable lifecycle evidence. This work was not
pushed, merged, published, or deployed.
