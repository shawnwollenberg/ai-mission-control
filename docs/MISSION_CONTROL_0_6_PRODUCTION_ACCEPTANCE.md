# Mission Control 0.6 Production Acceptance

**Date:** 2026-07-21  
**Production app:** `https://app.missioncontrol.wallyweb.com`  
**Disposable repository:** `shawnwollenberg/mission-control-acceptance-07`  
**Acceptance PR:** `#1`  
**Exact head:** `6a498736907c8b7559052c35f120dbc06dc9a5c1`

## Completed workflow

An isolated authenticated workspace registered one pull-based Mission Agent and repository. Repository Analysis produced analysis, structured recommendation, and health artifacts. A recommendation created a linked Change Mission. After write approval, Mission Agent created an isolated worktree, modified `README.md` and `package.json`, ran validation, produced diff/summary/log evidence, and created the exact local commit above.

`Publish for Review` required a second approval. Mission Agent pushed only the exact `mission/*` commit without force and opened PR #1. GitHub independently reported the same head SHA and `main` base. Multiple web-container restarts preserved state. Full production replay verified 3,379 canonical events with no discrepancies. Repository flags were `push=true`, `pull_request=true`, `merge=false`, `deployment=false`.

## Acceptance findings fixed

- Agent and execution heartbeats shared a rate bucket and could falsely disconnect active work; they now have separate limits.
- A successful Codex process could return no diff; Mission Agent now performs one bounded ephemeral retry and still fails closed if no change appears.
- Private-repository provider verification could leave an already-created exact PR marked failed; publication now supports authenticated provider verification and recovery-safe reconciliation without a second effect or approval.
- The mission debrief omitted the push performed by the combined publication action; it now reports both exact push and provider-confirmed PR.
- Projection verification compared transient transport heartbeat state to event-rebuilt business state; it now excludes only `last_heartbeat_at` while verifying every authoritative execution field.

## Observed friction retained for follow-up

- A failed recommendation-derived Change Mission leaves its recommendation `in_progress` with no first-class retry/reset action.
- Signup derives a workspace label from the first display-name token, which produced an awkward `Mission's Workspace` label in this acceptance account.
- Routine CDK deployment attempts to replace the current single EC2 host and its local database volume. Acceptance releases therefore used scoped in-place image replacement. Release infrastructure must be made data-safe before relying on CDK updates.

## Boundary result

The 0.6 workflow is accepted for exact publication. Merge, deployment, infrastructure/secret modification, force operations, protection bypass, and transaction operations remained unavailable.
