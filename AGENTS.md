# Mission Control — Codex Instructions

## Project purpose

Mission Control is a command center for orchestrating, observing, and governing teams of AI agents.

The hackathon goal is not to build a complete enterprise platform. The goal is to create a polished, convincing demonstration showing multiple specialized agents collaborating on a mission while a human monitors progress and approves sensitive actions.

Aegis smart accounts may provide spending controls and policy enforcement, but Aegis is supporting infrastructure rather than the main product.

## Current phase and release governance

Phase 5 daily operations and the approved Phase 6 production launch are complete. Preserve their scope in `PLANS.md`, `docs/PHASE_5_OPERATIONS.md`, and the Phase 6 operational documents. Preserve the existing mission, task, execution, approval, policy, action-request, event, and projection authority. Templates and schedules create new mission instances through the existing command layer; they never bypass agent eligibility, resources, policy, or approvals.

Further production changes require a documented release authorization in `PLANS.md` or a linked release record. Documentation prepared by Codex is review evidence, not human approval. Codex may not approve its own release. Stop before commit, push, merge, or production deployment unless the repository's existing approval mechanism contains an actual human approval for the exact documented release scope.

Classify every proposed production change before release:

1. **Routine governed application release:** bounded presentation or application behavior that does not change authentication, authorization, tenant isolation, credentials, agent execution authority, signing, infrastructure, destructive mutation behavior, or Project Brain authority. A compact release record is permitted, but it must document exact scope, acceptance criteria, validation, rollout, rollback, risks, and human approval.
2. **Security-sensitive application release:** any application change involving authentication, authorization, workspace or tenant isolation, credentials, agent protocol/runtime behavior, policy enforcement, signing, destructive mutations, or sensitive audit evidence. It requires a dedicated reviewed production phase with threat-focused tests and explicit human approval.
3. **Infrastructure/runtime release:** deployment topology, databases, networks, secret providers, IAM, workers, runtime versions, build/release infrastructure, or production remediation. It requires a dedicated reviewed production phase, operational validation, rollback evidence, and explicit human approval.
4. **Not safe to release:** acceptance criteria are unmet, authority is ambiguous, validation or rollback is inadequate, secrets may leak, tenant boundaries may fail, destructive effects are uncontrolled, or required human approval is absent.

Project Brain initialization, schema/authority changes, curation automation, provider migration, or release-process integration are high-risk and require a dedicated reviewed production phase. Routine edits to already-authorized project documentation may use the routine release path only when they do not change Project Brain authority or automation.

High-risk releases remain narrow: approval for one release never authorizes unrelated future production changes. No production deployment may occur without an explicitly documented release authorization and corresponding human approval. Continue to stop before production remediation, secrets access, infrastructure modification, blockchain transactions, wallet signing, asset movement, or unrestricted remote command execution unless a dedicated approved phase explicitly authorizes the exact action.

## Source-of-truth documents

Read these before proposing or implementing work:

- `docs/PRODUCT_BRIEF.md`
- `docs/DEMO_SCRIPT.md`
- `docs/ARCHITECTURE.md`
- `docs/EVENT_MODEL.md`
- `docs/BACKLOG.md`
- `docs/PRODUCTION_GAP_ANALYSIS.md`
- `docs/PRODUCTION_ARCHITECTURE.md`
- `docs/PHASE_2_CODEX_EXECUTION.md`
- `docs/PHASE_4_REMOTE_AGENTS.md`
- `docs/PHASE_5_OPERATIONS.md`
- `PLANS.md`

When decisions change, update the appropriate document.

## Product principles

1. Optimize for a compelling three-minute hackathon demo.
2. Mission Control is the product; individual agents are interchangeable.
3. The interface must make agent activity understandable at a glance.
4. Every meaningful agent action should be represented as a structured event.
5. Human approvals should occur only at meaningful risk boundaries.
6. Aegis should be experienced as simple spending governance, not explained through blockchain terminology.
7. Prefer a narrow, polished vertical slice over many incomplete features.
8. Clearly distinguish real functionality from simulated demo behavior.

## Initial demo concept

The user launches a software-release mission.

A coordinator agent:

1. Creates a plan.
2. Delegates research to a research agent.
3. Delegates implementation to a coding agent.
4. Delegates validation to a testing agent.
5. Requests a paid resource or spending action.
6. Pauses when human approval is required.
7. Continues after approval.
8. Completes the mission.

Mission Control displays:

- Agent roster and live status
- Mission progress
- Structured event feed
- Branching mission timeline
- Tool and model usage
- Spending and approval requests
- Final mission outcome

## Working rules

- Ask questions and challenge assumptions during planning.
- Do not silently make major product or architecture decisions.
- Record decisions and unresolved questions in the planning documents.
- Keep plans scoped to the hackathon deadline.
- Break implementation into milestones that produce demonstrable progress.
- Define acceptance criteria for every milestone.
- Run relevant tests and validations after implementation begins.
- Avoid premature infrastructure, authentication, billing, and enterprise features.
- Use an execution plan for changes spanning multiple subsystems.
- Keep the event log canonical and never introduce hidden state transitions.
- Never represent simulated or fallback data as live data.
- Never place raw secrets in source code, event payloads, logs, or database records; store credential references only.
- Add tests for every new state transition and preserve backward compatibility for versioned agent protocols.
- Do not silently weaken approval or policy enforcement.
- Do not autonomously sign or submit financial transactions.
- Keep arbitrary command execution out of the web server; agent runtimes belong behind isolated adapters/workers.
- Update the relevant architecture and operational documents whenever a decision changes.
