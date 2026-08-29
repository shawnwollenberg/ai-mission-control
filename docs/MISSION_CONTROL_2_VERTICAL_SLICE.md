# Mission Control 2.0 — Non-production Vertical Slice

**Status:** implemented and locally validated on 2026-08-29. This is development evidence, not a production release
authorization. V2 is not deployed and no production traffic or V1 data was changed.

## Runtime boundary

The deterministic routing kernel remains side-effect free. `MissionOrchestrator` performs provider and GitHub side
effects through `CodexSdkEngineerAdapter`, `OpenAIResponsesArchitectAdapter`, and `MissionStore`. The official Codex
SDK starts one thread per mission and resumes the stored thread ID for remediation. It runs in the configured checkout
with workspace-only writes, no network, no interactive approval, medium reasoning, a bounded mission packet, and a
strict Engineer Report schema. CTO-owned capabilities may be requested for escalation but are never granted to Codex.

The Architect uses the official OpenAI Responses API with versioned instructions, strict JSON Schema output, no
tools, and `previous_response_id` continuity. It makes decisions only. A `CTO_REQUIRED` decision becomes an inbox
request only when an Engineer Report identifies an exact CTO-owned capability. Mission Control binds decisions to the
mission and pending request revision and rejects stale decisions.

## Minimal persistence

Project definitions and constitutions live in the Mission Control JSON configuration. The runtime JSON store contains
only mission/project/issue identity, Codex thread ID, Architect response ID, last processed revision, and a bounded
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

## Validation evidence

`npm run test:v2` covers the router, strict envelopes, GitHub reconstruction, idempotency, adapters, same-thread
remediation, Architect context continuation, exact CTO escalation, stale-decision rejection, dispatch pause, simulated
approval, completion, dashboard derivation, and history rebuild.

A real Codex SDK acceptance used the clean `agent_payment_risk_check` checkout without modifying it. Thread
`01a04e88-ccd1-7871-b421-146d3bb95fa1` returned revision 2 after passing 11/11 targeted tests and a clean-tree check;
the remediation turn resumed the same thread and returned revision 4 with another clean-tree check and a bounded test
gap. No OpenAI API key was available to the Mission Control process, so the real Responses Architect and therefore the
single real-provider end-to-end GitHub loop remain unexercised. The adapter contract and complete loop are validated
with deterministic provider doubles. Supplying a development `OPENAI_API_KEY` is credential authority and remains an
owner action.

## Rollback and legacy

V2 is additive under `v2/`, `/v2`, and `/api/v2`. Rollback is removal of those development-only paths and dependencies.
V1 remains intact and authoritative for its production operations. No schema migration, database, worker, auth,
repository permission, deployment, wallet, or production action is part of this slice.
