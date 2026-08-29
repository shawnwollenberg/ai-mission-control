# Mission Control 2.0 GitHub Mission Bridge

**Status:** Phase 2 implementation and reversible GitHub spike completed locally on 2026-08-29. This record does
not authorize commit, push, pull request, merge, deployment, credential expansion, or production mutation for Phase 2.

## Boundary

One GitHub Issue is one durable Mission. The issue body contains the immutable initial Mission envelope. Structured
comments contain Engineer Reports, Architect Decisions, CTO Requests, and CTO Decisions. The current state label is a
rebuildable presentation projection. Mission Control stores no canonical issue body, comment history, report,
decision, request, or duplicate mission state.

`MissionStore` exposes only mission-specific read, append, state-label, close, and reconcile operations. The concrete
GitHub adapter uses the existing authenticated `gh` client and does not expose repository management, pull requests,
branches, permissions, or deployment.

## Validation boundary

`npm run test:v2` runs only the V2 routing-kernel and GitHub Mission Bridge tests. Typecheck, lint, formatting, and
`git diff --check` remain shared gates. The legacy `npm test` suite is reported separately; its V1-only expired
release-manifest fixtures do not create a false V2 failure, while failures in shared code still fail the shared gates.

## Reconciliation

Reconciliation parses the initial Mission, validates authorized machine-envelope authors, deduplicates identical
revisions, rejects conflicting duplicates and gaps, sorts valid signals by revision, and applies the routing kernel.
It derives current state and actor, latest Engineer Report and Architect Decision, pending CTO Request, completion,
ignored ordinary-comment IDs, and a deterministic SHA-256 history digest. No Mission Control database history is used.

## Reversible GitHub evidence

The complete revisions 1–9 Agent Payment Risk Check lifecycle ran through
`shawnwollenberg/mission-control-acceptance-07#2`, a repository explicitly described as disposable Mission Control
acceptance infrastructure. The issue contains eight structured comments, finished with only `mc:mission` and
`mc:complete`, and was closed as completed. A fresh store instance rebuilt revision 9 and the identical history digest
`9d3407e63a4b257f6db0d7de9eb5297676e184bbcbf28642fd70c9cbb3b3d80f` from GitHub alone.

No repository contents, branches, pull requests, merge settings, permissions, deployments, Mission Agent registration,
database state, Codex, Architect provider, Project Brain, dashboard, notification, or scheduling behavior changed.
