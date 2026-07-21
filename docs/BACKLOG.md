# Mission Control — Backlog

**Status:** Approved and frozen — implementation authorized 2026-07-15

## Now: product decisions

- [x] Select one exact target user and current alternative
- [x] Write the product-level core problem statement
- [x] Choose the concrete software-release mission
- [x] Select proactive optimization recommendation review as the memorable wow moment
- [x] Define demo-environment promotion as the approval risk boundary
- [ ] Classify each demo beat as live, controlled, or simulated
- [x] Define the final artifact and proof of completion as a still Mission Debrief with one primary preview proof
- [x] Define final proof categories: real PR, tests, preview, working feature
- [x] Record deadline and team capacity
- [ ] Obtain judging criteria, tracks, sponsor requirements, and required technologies

## Next: experience and system design

- [ ] Approve the three-minute beat sheet
- [ ] Reduce UI to the minimum surfaces needed for the story
- [ ] Define mission, task, approval, and spending state machines
- [ ] Define objective states and objective/task dependencies
- [ ] Define optimizer inputs, operations, invariants, and stale-plan behavior
- [x] Draft optimizer knowledge, decision, prohibition, explanation, and safety contract
- [ ] Define resource types, constraints, allocations, and capability vocabulary
- [ ] Define explainable Mission Health states, evidence rules, and confidence
- [ ] Define command, canonical append, projection, outbox, and safe replay semantics
- [ ] Define canonical event envelope and demo event catalog
- [ ] Build minimal Developer Mode event/projection inspector after Mission Plan, Mission Log, and Mission Health are visible
- [ ] Require an event-consumption and no-independent-state declaration for every feature
- [ ] Decide orchestration approach and agent execution contract
- [ ] Define Aegis responsibility and failure behavior
- [ ] Prove or reject Aegis deployment-policy feasibility; do not invent spend
- [ ] Reduce and validate the candidate technical stack and deployment shape
- [ ] Design deterministic reset, fixtures, and fallback path
- [ ] Design 8-second replay projection that never reissues effects
- [ ] Create risk register with owners and mitigations

## Approval gate

- [x] Product brief explicitly approved
- [x] Demo script explicitly approved
- [x] Architecture explicitly approved
- [x] First execution plan explicitly approved

## Later: implementation milestones

The implementation sequence, estimates, dependencies, visible artifacts, acceptance criteria, stretch cuts, and risks are maintained in `PLANS.md`.

No additional planning artifact should be created unless it resolves a concrete blocker in that execution plan.

Acceptance criteria will be added only after the product and architecture decisions are made.

## Explicitly parked

- Authentication and user management
- General workflow editor
- Multi-tenant data isolation
- Production billing
- Agent marketplace
- Broad integrations catalog
- Multiple concurrent mission management
- Enterprise analytics and permissions

## Post-demo: first real agent workflow

Begin only after the hackathon proof sequence is complete and reliable. Mission Control coordinates and observes existing agents; it does not replace Hermes, Codex, or Claude.

- [ ] Define a versioned, vendor-neutral canonical agent-event envelope
- [ ] Add authenticated `POST /api/agent-events` ingestion
- [ ] Add authenticated assigned-work retrieval for Hermes
- [ ] Publish a small Mission Control client library for Hermes
- [ ] Build one bounded Codex adapter that maps its lifecycle to canonical events
- [ ] Project ingested events into the existing Mission Log
- [ ] Accept a concrete artifact or completion report from the adapter
- [ ] Prove empty-state replay reconstructs mission state only from canonical events
- [ ] Document Claude Code HTTP-hook integration as the second adapter

Cut rule: implement only `Mission Control → Hermes → Codex → artifact → Mission Control`. Vendor payloads remain inside adapters. Do not begin a generalized plugin platform.

## Post-MVP: Executive Advisor

- [ ] Define an event-derived, versioned `ExecutiveContext` projection.
- [ ] Add advisory request/response artifacts that remain distinct from deterministic facts and human decisions.
- [ ] Add one explicit OpenAI-backed advisory interaction after the real-agent workflow is reliable.
- [ ] Route any advice-derived command through existing deterministic validation and approval.

Cut rule: the Advisor is not the optimizer, orchestrator, canonical-state owner, or effect dispatcher. Details: `docs/POST_MVP_EXECUTIVE_ADVISOR.md`.

## Adoption: zero-documentation first run

- [x] Replace Agent Registry onboarding with a guided agent chooser.
- [x] Generate a workspace-scoped credential and one copyable install command.
- [x] Detect a real signed heartbeat and advance the browser automatically.
- [x] Put a preselected read-only first mission directly after connection.
- [x] Package the connector as a versioned, checksummed distribution.
- [x] Add durable pull delivery for agents behind NAT or localhost.
- [x] Execute and complete the preselected first mission through the newly connected agent.
- [ ] Validate an unknown user reaching an artifact without assistance in under ten minutes.

## Repository Change Missions

- [x] Keep Analyze Repository explicitly read-only.
- [x] Add Change Repository with editable objective, acceptance criteria, and validation instructions.
- [x] Produce a read-only implementation-plan artifact before requesting write authority.
- [x] Require a scoped human `repository.modify` approval.
- [x] Execute approved changes on an isolated `mission/*` worktree and branch.
- [x] Capture changed files, full diff, validation output, summary, branch, base commit, and local commit evidence.
- [x] Preserve prohibitions on push, pull-request creation, merge, deploy, infrastructure, secrets, and transactions.
- [ ] Validate the full workflow against a disposable production repository and fresh account.

## Mission Control 0.4 — Engineering Manager

- [x] Persist evidence-backed recommendations as canonical lifecycle entities.
- [x] Emit structured recommendations from Repository Analysis without granting new authority.
- [x] Expose recommendations in mission and Repository Health views.
- [x] Create one idempotently linked Repository Change Mission from a recommendation.
- [x] Inherit objective, evidence, acceptance criteria, and allowlisted validation suggestions.
- [x] Rebuild recommendation projections from the canonical event log.
- [ ] Validate the full recommendation-to-approved-change workflow against a disposable production repository.

## Mission Control 0.5 — Repository Intelligence planning

- [x] Record Repository Intelligence as the next product milestone.
- [x] Establish Repository Health, Timeline, Knowledge, trends, and action templates as the priority sequence.
- [x] Require evidence-backed, versioned, rebuildable health claims.
- [x] Approve health dimensions, scoring weights, missing-data behavior, confidence, and freshness rules.
- [x] Define canonical repository observation and health-assessment events.
- [x] Define explicit mission/recommendation/validation/timeline relationship vocabulary.
- [ ] Define component identity, rename, merge, and stale-knowledge behavior.
- [x] Approve the smallest implementation slice and production acceptance test.
- [x] Implement evidence-backed health assessments, history, repository dashboard, and timeline.
- [ ] Validate two production analyses showing a comparable evidence-backed health trend.

## Mission Control 0.5 — Delivery Authority Expansion

- [x] Add one exact, evidence-bound `Publish for Review` approval.
- [x] Route the approved push to the repository-owning Mission Agent without provider credentials.
- [x] Create and confirm the PR server-side with complete mission/evidence traceability.
- [x] Project Local Changes Ready, Publication Approval Required, Publishing, Pull Request Open, and Publication Failed from canonical execution/action events.
- [x] Keep force push, default/protected-branch push, merge, deployment, infrastructure/secrets, and transactions denied.
- [x] Document independent review, merge authority, deployment mission, and repository autonomy policy boundaries without enabling them.
- [ ] Validate the complete boundary against a disposable production GitHub repository and rebuild projections after restart.
