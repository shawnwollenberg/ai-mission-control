# Mission Control 2.0 — Non-production Vertical Slice

**Status:** implemented and locally validated on 2026-08-29. This is development evidence, not a production release
authorization. V2 is not deployed and no production traffic or V1 data was changed.

## Runtime boundary

The deterministic routing kernel remains side-effect free. `MissionOrchestrator` performs provider and GitHub side
effects through `CodexSdkEngineerAdapter`, `CodexSdkArchitectAdapter`, and `MissionStore`. The official Codex SDK uses
the owner's existing ChatGPT subscription authentication. It starts separate Engineer and Architect threads per
mission and resumes their stored thread IDs. The Engineer runs in the configured checkout with workspace-only writes;
the Architect runs read-only. Both have network disabled, no interactive approval, medium reasoning, bounded mission
packets, and strict output schemas. CTO-owned capabilities may be requested for escalation but are never granted to
either provider.

The Codex SDK adapter is the default Architect. It makes decisions only and cannot mutate the repository. The
Responses Architect remains disabled at runtime, so V2 neither requires an API key nor creates separate Responses API
billing. `WorkspaceAgentArchitectAdapter` preserves the future trigger/result interface without making Workspace Agent
a current dependency. A `CTO_REQUIRED` decision becomes an inbox request only when an Engineer Report identifies an
exact CTO-owned capability. Mission Control binds decisions to the mission and pending request revision and rejects
stale decisions.

## Minimal persistence

Project definitions and constitutions live in the Mission Control JSON configuration. The runtime JSON store contains
only mission/project/issue identity, separate Engineer and Architect Codex thread IDs, last processed revision, and a bounded
in-flight dispatch marker. File replacement is atomic and owner-only. It contains no GitHub body, comment, report,
decision, or mission-history copy. Deleting derived UI/cache state is safe: Mission state, current actor, reports,
decisions, requests, transitions, and completion rebuild from GitHub; provider bindings remain the minimal required
non-reconstructable input.

Set `MISSION_CONTROL_V2_CONFIG` to a copy of `config/mission-control-v2.example.json`. Optionally set
`MISSION_CONTROL_V2_DATA_DIR`; the default `.mission-control-v2-runtime/` is ignored by Git. Add active issue numbers
to `trackedMissionIssues` for the dashboard.

## User experience

Authenticated `/v2` is the Chief-of-Staff board. It shows the CTO Inbox first, then mission projects ordered by owner
attention, active work, external blocks, complete/paused, and seven-day staleness. Colors derive from state: Architect
blue, Engineer orange, CTO red, external gray, complete black, stale light. Project detail shows the latest Engineer
summary, Architect decision, exact pending CTO request, recent transitions, GitHub/repository links, and provider
context IDs. Approve, Reject, and Discuss are owner-only, same-origin, optimistic-concurrency mutations. Discuss routes
back to the Architect context; Mission Control has no chat UI.

While `/v2` is visible, the dashboard refreshes its server projection every 30 seconds. This updates Mission, actor,
CTO Inbox, and Local Worker presentation without issuing a mutation. Refresh scheduling stops while the document is
hidden where the Visibility API is supported, refreshes once when visibility returns, then resumes the bounded timer.
The dashboard read path reconstructs directly from the fetched Issue and comments with label enforcement disabled for
presentation; it never repairs labels, appends comments, updates the Issue, or invokes the mutating MissionStore path.

An externally blocked Mission can resume only through an authenticated owner reconciliation. The command appends an
`mc.owner-reconciliation/v1` envelope at the next revision, binds the exact `BLOCKED_EXTERNAL` revision, requires a
reason and evidence, and routes a fresh Architect reassessment. Labels remain derived presentation and cannot reopen
a Mission. `COMPLETE`, active, stale, or mismatched blocked revisions fail closed.

When an external block proves that an acceptance criterion has become obsolete, an authenticated owner may instead
append `mc.owner-mission-amendment/v1`. The amendment binds the exact current `BLOCKED_EXTERNAL` revision, records a
reason and evidence, and supplies the complete replacement acceptance-criteria list. Reconstruction preserves the
original criteria and every prior signal in GitHub history, projects only the replacement criteria from the amendment
revision forward, and routes the same Mission to Architect reassessment. It cannot change the objective, constraints,
capabilities, approval policy, or any completed or active Mission.

## Explicit direct Codex handoff

A direct Codex task remains private provider context until the owner explicitly promotes that exact thread with
`npm run mc:v2:handoff -- /absolute/path/to/handoff.json`. The command validates the admitted project, exact local
Codex session metadata, checkout, normalized GitHub origin, and exclusive thread ownership before creating a GitHub
Issue. It then writes a bounded initial Engineer report, binds the existing Engineer thread, and labels the Issue
`mc:tracked`. The dashboard and worker discover only this explicit label; Mission Control never enumerates or mirrors
arbitrary Codex tasks. GitHub becomes canonical immediately after promotion. A new Architect thread reviews the
bounded status normally, while the full Codex transcript remains outside GitHub and Mission Control.

`OWNER_AUTHENTICATION` is an explicit CTO-owned routing capability for authentication ceremonies such as MFA. It
authorizes only the owner to complete authentication; it does not grant an agent credentials or permission to perform
the ceremony. External provider failures without owner action remain external blocks and do not enter the CTO Inbox.

## Validation evidence

`npm run test:v2` covers the router, strict envelopes, GitHub reconstruction, idempotency, adapters, same-thread
remediation, Architect context continuation, exact CTO escalation, stale-decision rejection, dispatch pause, simulated
approval, completion, dashboard derivation, and history rebuild.

The full real-provider acceptance completed in the private `agent_payment_risk_check` repository as
[Issue #2](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/2). Engineer thread
`01a04ea1-7f40-7e93-8d2a-188eab4fa20c` and read-only Architect thread
`01a04ea1-dc93-7e10-bf91-a036d96519bf` drove revisions 1 through 9 without human copy/paste. The Architect returned
`REMEDIATE`; Mission Control resumed the same Engineer thread; the bounded pytest target passed; the Engineer requested
the inert `SIGN_WALLET_MESSAGE` boundary; the Architect returned `CTO_REQUIRED`; Mission Control paused, recorded an
exact simulated approval, resumed the same Engineer thread, observed the test pass again and a clean worktree, then
recorded Architect `APPROVE` and closed the Issue. A fresh GitHub store reconstructed revision 9 and history digest
`ba1ba922ca871a7da2eac284f6a15da72a7e56212f8d604e92f48e0326e503e7`; the derived dashboard state was
`COMPLETE` / `NONE` / `BLACK`. Responses remained disabled. No wallet access, signature, money movement, network tool,
deployment, repository modification, commit, or push occurred in the fixture repository.

## Rollback and legacy

V2 is additive under `v2/`, `/v2`, and `/api/v2`. Rollback is removal of those development-only paths and dependencies.
V1 remains intact and authoritative for its production operations. No schema migration, database, worker, auth,
repository permission, deployment, wallet, or production action is part of this slice.
