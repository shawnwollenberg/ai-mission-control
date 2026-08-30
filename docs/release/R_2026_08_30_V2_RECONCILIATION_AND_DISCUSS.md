# R-2026-08-30 — V2 reconciliation and Discuss feedback

## Classification and authorization

This is a security-sensitive application/provider-runtime release because it introduces an owner-authorized Mission
transition and completes the bounded worker-recovery implementation. On 2026-08-30, the product owner explicitly
authorized push, merge, and production deployment of the reviewed combined working tree. Codex does not approve the
release.

## Exact scope

- Complete explicit, actor-bound recovery for eligible failed dispatches while preserving fail-closed indeterminate
  outcomes and completed-provider-work idempotency.
- Project exact current dispatch status and worker presence truthfully on the V2 dashboard.
- Add `mc.owner-reconciliation/v1`, bound to the exact current `BLOCKED_EXTERNAL` revision, requiring owner authority,
  same-origin mutation, a reason, and evidence before routing an Architect reassessment.
- Require a discussion note for `DISCUSS`, send it to the existing Architect context, and refresh the detail page after
  a successful decision.
- After rollout verification, reconcile Mission Control Issue #38 revision 5 with the exact release and validation
  evidence.

## Non-goals and authority boundary

No authentication ceremony, credential expansion, repository admission, Responses/API billing, provider-private API,
arbitrary terminal-state reopening, label-based Mission mutation, policy bypass, wallet/signature/financial action,
infrastructure topology change, V1 change, or unrelated production mutation. `COMPLETE`, active, and stale blocked
revisions remain non-reopenable.

## Acceptance

V2 routing, GitHub reconstruction, worker security/recovery, dashboard, and Discuss tests pass; typecheck, lint,
formatting, production build, production dependency audit, and diff checks pass. Production health/readiness remain
green, the local worker reports online, the exact digest is recorded, and Issue #38 gains exactly one revision-6 owner
reconciliation followed by an Architect dispatch without revision gaps or duplicate provider work.

## Rollout and rollback

Capture the current image and database backup; merge the exact reviewed commit to the production branch; build and
push an ARM64 image; deploy only the web container by immutable digest; verify health/readiness; restart the local
worker on the merged code; then invoke the exact Issue #38 reconciliation. Roll back by stopping the worker and
restoring the prior digest-pinned web container. Preserve all canonical GitHub evidence; append corrective Mission
evidence rather than deleting a reconciliation revision.
