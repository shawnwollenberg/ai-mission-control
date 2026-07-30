# R_2026_07_30_PUBLICATION_RECONCILIATION_UX

**Status:** Human approved for commit, push, merge, and deployment  
**Classification:** Security-sensitive application release  
**Production base:** `a04252562f1ffb3db6cf22639f7ff83b01b71b53`

## Problem and intended behavior

Mission Agent can push an exact approved commit and create its pull request while Mission Control subsequently fails to confirm the pull request through GitHub. The mission page currently offers only **Retry Publish for Review**, which looks like confirmation but requests a new approval-gated publication action.

For the ambiguous-confirmation case, the page must direct the user to inspect GitHub first. If the exact pull request exists, **Confirm Existing Pull Request** must re-run provider verification for the original action without pushing, creating, approving, or merging anything. If no matching pull request exists, **Start New Publication Attempt** remains a separate approval-gated path.

The missions archive must also present the existing unknown-cost predicate as a labeled Cost filter rather than a visually isolated checkbox.

## Scope and non-goals

Scope is one authenticated, origin-checked reconciliation endpoint; reuse of exact GitHub PR verification; recovery back to an explicit failed state when verification remains unavailable; separated mission-console recovery language; the equivalent Cost select; tests; and documentation.

This release grants no push, PR-creation, approval, review, merge, deployment, force-push, credential, Mission Agent, repository-identity, Project Brain, command-policy, signing, KMS, infrastructure, schema, or migration change. A human click never substitutes for provider evidence, and mission-search semantics do not change.

## Authorization, isolation, and evidence

The endpoint requires the existing authenticated browser identity and mutation-origin check. The server supplies `workspaceId`; the request accepts no workspace identifier. Existing action, repository, and publication-assignment queries remain workspace-scoped.

The change is security-sensitive because it advances externally evidenced action state. It grants no external effect: the provider operation is a read-only GitHub lookup, and success requires the repository, PR number, source branch, base branch, and head SHA already bound to the approved action.

Reconciliation appends `action.execution_reconciliation_started`, followed by `action.execution_succeeded` only after exact verification. An unavailable or mismatched provider appends `action.execution_failed` with `provider_verification_failure` and `requires-human-review`; it cannot remain stuck in `executing`. No new approval or duplicate publication lifecycle is created.

## Acceptance criteria

1. The failure explains that a matching PR may already exist and links to GitHub.
2. Confirming performs no push or PR creation and succeeds only for exact approved evidence.
3. Failed confirmation remains recoverable and never remains `executing`.
4. A new publication attempt stays distinct and approval-gated.
5. Cross-workspace reconciliation is rejected.
6. Existing publication, Mission Agent, repository-management, Project Brain, signing, and merge boundaries remain unchanged.
7. The missions archive presents Cost as a conventional filter while preserving `unknownCost=true`.

## Validation

Required evidence is focused publication/action-state testing, unit, integration, E2E, lint, formatting, typecheck, production build, migration status, and `git diff --check`. Manual authenticated validation must prove exact-PR reconciliation creates no branch, PR, or approval; missing/mismatched PR remains failed; cross-workspace access fails; and a fresh attempt still requires approval. Mission Agent artifact/signature/manifest and Project Brain inputs must remain unchanged.

## Rollout, rollback, and verification

After exact-scope human approval, deploy through the governed application procedure with no migration. Verify health/readiness and both reconciliation outcomes using a noncritical repository.

Rollback only the application revision. Never delete or rewrite actions, approvals, repositories, branches, pull requests, events, receipts, missions, or Project Brain records. Post-deployment checks must confirm exact reconciliation reaches **Pull Request Open**, mismatches remain **Publication Failed**, new publication requires approval, merge remains unavailable, workspace isolation and secret scanning pass, and the Cost filter returns unchanged results.

## Risks and approval evidence

Private-repository verification still requires the existing provider credential; missing scope remains a safe visible failure. GitHub availability can delay reconciliation, but bounded timeout and explicit failure prevent a stuck action. A previously merged PR can be confirmed only when its immutable head/base evidence still matches.

- Runtime: Node `v22.20.0`; npm `10.9.3`; clean install passed.
- Focused publication/action/filter tests: `7/7` passed.
- Complete unit suite: `166/166` passed.
- Lint, full formatting check, typecheck, production build, and `git diff --check`: passed.
- Production dependency audit: zero vulnerabilities.
- Mission Agent 0.7.2: unchanged at 148,063 bytes and SHA-256
  `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`.
- Integration suite: `73/73` passed against a dedicated PostgreSQL 16.4 container, including 100 production-path
  concurrent repository registrations.
- E2E suite: `2/2` passed with the repository-declared CI session-key fixture. An initial `503` run omitted the required
  `MISSION_CONTROL_SESSION_SECRET`; both scenarios passed unchanged after restoring the declared harness configuration.
- Migration status: migrations `0001` through `0028` applied to the disposable database and schema health reported zero
  pending migrations.
- Authenticated production-build/provider validation passed against private noncritical repository
  `shawnwollenberg/CLEO`. Before reconciliation, the rendered mission page exposed **Check GitHub pull requests**,
  **Confirm Existing Pull Request**, and **Start New Publication Attempt**. The authenticated confirmation returned
  HTTP 200 and recorded provider-confirmed PR #1 with source
  `mission/validation-publication-reconciliation-20260730`, base `main`, and exact head
  `dce4e2f60d5d40bd2fb6586efb938f093bf6e9b9`.
- GitHub contained exactly one matching PR before and after confirmation. Mission Control retained one publication
  assignment and appended `action.execution_reconciliation_started` followed by `action.execution_succeeded`; it
  created no new action, approval, branch, PR, review, or merge. The disposable PR was closed unmerged and its branch
  deleted after validation. No credential value was printed or retained.
- Visual Chrome click evidence is unavailable because the Chrome control extension had no attached local tab. The same
  authenticated rendered page and mutation endpoint were exercised over HTTP against the production build; this
  limitation does not affect provider or canonical-event evidence.
- Reviewed diff: nine files, pending the database-backed and manual gates above.
- Human approval: **GRANTED by Shawn Wollenberg on 2026-07-30** for the exact reviewed eight-file diff,
  including commit, push, merge, and deployment. Approval is invalid if the diff, production base, required validation,
  or Mission Agent artifact changes.
