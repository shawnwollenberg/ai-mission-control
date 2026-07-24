# Project Brain 0.4.1 governed execution report

Date: 2026-07-24

## Scope and branch

- Branch: `codex/project-brain-0.4.1-governed-execution`
- Base: accepted Mission Control integration head `9d8f611`
- Project Brain consumer: core `0.4.0`, contract `1.0`, schema `2.5.0`
- Primary and prior acceptance worktrees were not modified.

## Implemented architecture

Project Brain web-page subprocess calls were removed. Pages now read `repository_project_brain_projections` and `mission_project_brain_projections`; their server action records a governed command only.

`project_brain_operation` is a canonical aggregate. Authorization appends requested plus authorized/denied events transactionally. An authorized event creates an outbox record; the existing outbox dispatcher creates a `project_brain_operation` job. The dedicated worker uses the existing claim, lease renewal, retry, dead-letter, worker-presence, timeout, bounded-output, and artifact-store primitives.

The operation allowlist declares read/write classification, clean-worktree requirement, permission, policy action, approval type, allowed location, artifacts, and SHA behavior. Final context generation is treated as a repository write while preview remains read-only.

Writing commands independently require repository `write_allowed`, agent allowlisting, resource `write` permission when agent-associated, exact policy action, and a granted unexpired approval. The approval fingerprint covers workspace-scoped repository, mission, execution, agent, operation, arguments, starting SHA, location, write scope, limits, and required versions. The worker recomputes the fingerprint and consumes the approval immediately before mutation.

Local execution accepts only `location_mode=server`, rejects `mission-agent://`, resolves the registered checkout under `CODEX_REPOSITORY_ROOT`, checks HEAD and cleanliness, and validates returned artifact containment and SHA-256 before durable storage. Remote URIs are never passed to filesystem or process APIs.

## Canonical events and projections

Lifecycle events include:

- `project_brain.operation_requested`
- `project_brain.operation_authorized`
- `project_brain.operation_denied`
- `project_brain.operation_started`
- `project_brain.operation_attempt_failed`
- `project_brain.operation_succeeded`
- `project_brain.operation_failed`
- `project_brain.context_generated`
- `project_brain.context_bound_to_execution`
- `project_brain.context_verified_by_agent`
- `project_brain.closure_recorded`
- `project_brain.learning_proposed`
- `project_brain.learning_evaluated`

The three projections are rebuilt solely from those events:

- per-operation lifecycle and authorization evidence;
- repository availability, compatibility, validation, freshness, knowledge counts, warnings, and last-operation state;
- mission context artifact/checksum/SHA/manifest/quality/binding/agent verification/closure/learning state.

Projection verification on the disposable database reported identical live and replay hashes.

## Context continuity

Project-Brain-enabled local executions are held without a Codex job until a final context artifact is generated and explicitly bound. Binding rechecks repository HEAD, then enqueues the existing Codex job idempotently. The Codex worker reads the immutable artifact, recomputes SHA-256, refuses stale or mismatched evidence, records received and verified checksums canonically, and injects the exact verified bytes plus checksum into the agent prompt.

The remote envelope and Mission Agent now define checksum verification fields and exact-byte prompt handling, but PB-enabled remote dispatch is deliberately disabled until the missing remote Project Brain operation/binding transport is complete. This fail-closed boundary prevents a mission-level artifact from being reused for a different execution. The preparatory response handler refuses a mismatched first verification report.

Closure authorization additionally requires the execution binding, exact context checksum, and successful agent verification.

## Validation evidence

- Migration `0001` through `0025`: applied from an empty PostgreSQL database.
- TypeScript: passed.
- ESLint: passed with zero warnings.
- Unit tests: 90 passed, including exact consumed-approval lease recovery after expiry.
- Standalone Project Brain tests at `6708a0f`: 64 passed.
- New governance adapter/unit subset: 16 passed.
- Integration tests: 48 passed after correct disposable owner seed setup.
- New governed-execution integration tests: 3 passed (canonical request/outbox/job idempotency, denied unapproved write, remote URI isolation).
- Projection replay: equal, 26 events, no discrepancies on the final clean disposable database.
- Production build: passed with Next `16.2.10`.

No automatic initialization or learning promotion was added.

## Independent review and repair

The fresh independent review found no critical arbitrary-command or path-escape issue and identified five high-severity integrity findings. The repair pass:

- made specialized success facts terminal so there is no second success-event crash window;
- verifies the actual isolated execution worktree HEAD;
- rechecks repository enablement, read/write authority, agent allowlisting, and resource grants in the worker;
- rechecks approval status, expiry, type, fingerprint, mission, and execution immediately before consumption;
- disables PB-enabled remote execution fail-closed until an exact remote operation/binding transport exists, preventing reuse of a mission-level pack from another execution.

The remaining artifact-orphan window and operation-specific argument schemas are medium follow-up items and contribute to the no-go disposition.

The final targeted re-review confirmed that no critical or high-severity findings remain.

## Remaining release limitations

Standalone Project Brain operations for `mission_agent` repositories currently produce a durable `remote_project_brain_transport_unavailable` blocked result. Remote coding execution can consume and verify an already stored immutable context artifact, but the complete remote Project Brain operation request/response transport is not yet implemented.

A full disposable mission covering initialization, real code change, closure, proposal, evaluation, and inbox display has not yet been recorded. The required failure matrix is only partially automated. Therefore this branch is an implementation checkpoint, not a production-accepted release.

The dependency assessment identifies an applicable high-severity Next Server Action advisory. It remains separate from this branch and blocks Internet-facing deployment until the maintenance upgrade is validated.

## Release disposition

**NO-GO for merge or deployment.** Continue the repair mission with remote Project Brain operation transport, full recovery/failure tests, and the real disposable lifecycle. Nothing was merged, pushed, published, or deployed.
