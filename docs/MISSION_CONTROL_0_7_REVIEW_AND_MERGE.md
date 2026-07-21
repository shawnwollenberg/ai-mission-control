# Mission Control 0.7 — Review and Merge

## Outcome

Mission Control extends the evidence chain from an exact published pull-request revision through independent review and one approval-bound merge. Deployment remains a separate, denied authority.

## Aggregate model

- `pull_request`: provider-backed identity and immutable revision snapshots.
- `review`: repository, PR, base/head refs and SHAs, diff checksum, policy version, scope result, disposition, CI snapshot, confidence, and review mission.
- `review_finding`: exact reviewed head SHA, category, severity, blocking flag, confidence, evidence, file/range, suggested resolution/validation, and lifecycle.
- Existing `action_request` and `approval`: exact merge request, policy evaluation, approval, execution, invalidation, and provider-confirmed result.

All projections rebuild from canonical events. Provider polling may cache transport observations, but a review, readiness decision, approval, or merge result becomes product truth only through an event.

## Revision and stale rules

Every review and finding is bound to one PR head SHA. Observing another head SHA appends review/finding stale events and invalidates any pending merge approval. A later return to an earlier SHA does not revive an old approval; a fresh readiness snapshot and approval are required.

## Role separation

The builder produces a change. A logically independent review execution receives the immutable diff and repository evidence but no write approval. Findings cannot modify code. `Create Fix Mission` creates an idempotently linked change mission at the reviewed branch/head; implementation and subsequent publication each require their own approvals.

## Merge readiness

Readiness is fail-closed and versioned. It requires exact head/review equality, successful required checks, known mergeability and conflict state, satisfied branch/review policy, zero open blocking findings, and one repository-approved merge strategy. Unknown means not ready.

The approval copy identifies the exact operation, for example: `Approve squash merge of PR #42 at abc123 into main`. Its canonical hash binds repository and remote, PR, base branch and SHA, head SHA, diff and review checksums, review mission, CI/policy snapshot, strategy, and action parameters.

## Merge execution

The provider credential is server-side, minimally scoped, and excluded from prompts, artifacts, logs, and agent payloads. Immediately before the effect, Mission Control retrieves the PR again and revalidates every bound field. It never force-merges, bypasses protection, uses administrator privileges, or pushes the default branch. After the provider call it independently records merged state, actor, time, merge commit, final head, base, strategy, and traceability.

## Health and recommendation behavior

Merge may move a recommendation to `implemented_awaiting_assessment`; it cannot complete the recommendation or improve Repository Health. Only later evidence-backed analysis or focused assessment can do that.

## Recovery

Provider calls use idempotency by repository/PR/head/action hash. After an ambiguous response, recovery inspects provider state before retrying. A confirmed exact effect is reconciled without consuming a second approval. Replay never repeats review execution, publication, merge, or any other external effect.

## Intentionally unsupported

- Deployment or production remediation
- Force push or force merge
- Protection or administrator bypass
- Direct default-branch writes
- Unclear/default merge strategy selection
- Autonomous code changes by reviewers
- Treating unknown CI/policy state as passing
