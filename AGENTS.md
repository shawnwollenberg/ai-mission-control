# Mission Control — Codex Instructions

## Project purpose

Mission Control is a command center for orchestrating, observing, and governing teams of AI agents.

The hackathon goal is not to build a complete enterprise platform. The goal is to create a polished, convincing demonstration showing multiple specialized agents collaborating on a mission while a human monitors progress and approves sensitive actions.

Aegis smart accounts may provide spending controls and policy enforcement, but Aegis is supporting infrastructure rather than the main product.

## Current phase

The hackathon demo is complete. Phase 0 and the Phase 1 production architecture were approved on 2026-07-18. Phase 1 durable-core implementation is active.

Implement only the approved Phase 1 scope in `PLANS.md`, use its reviewable vertical slices, and stop at the Phase 1 boundary before external-agent execution.

## Source-of-truth documents

Read these before proposing or implementing work:

- `docs/PRODUCT_BRIEF.md`
- `docs/DEMO_SCRIPT.md`
- `docs/ARCHITECTURE.md`
- `docs/EVENT_MODEL.md`
- `docs/BACKLOG.md`
- `docs/PRODUCTION_GAP_ANALYSIS.md`
- `docs/PRODUCTION_ARCHITECTURE.md`
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
