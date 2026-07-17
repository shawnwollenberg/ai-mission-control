# Post-MVP direction: Executive Advisor

**Status:** Recorded direction only. Not approved for the current hackathon submission.

## Product role

The Executive Advisor helps a human exercise judgment about Mission Control's event-derived organizational truth. It is a strategic advisory layer powered by an API model; it is not the canonical optimizer, orchestrator, state owner, or effect dispatcher.

Responsibilities remain distinct:

- Mission Control owns the executive interface and canonical event record.
- The deterministic optimizer owns feasible scheduling and organizational recommendations.
- Hermes coordinates approved effects.
- Codex, Claude, and other specialists perform bounded execution.
- The human retains accountability for consequential decisions.

## Data and authority boundaries

The Advisor may consume a compact purpose-built context projection: Mission, objective/task/resource projections, Mission Health, deterministic recommendation, relevant canonical event summaries, artifact summaries, a human question, and explicitly requested research.

It may produce an advisory artifact or a proposed command through canonical events. Advice must be visibly distinct from deterministic facts and human decisions.

It must never mark work complete, change health, reassign agents, bypass approval, dispatch effects, assert validation, alter budgets/policy, or replace deterministic feasibility checks. Proposed commands still traverse ordinary validation, constraints, approval, and canonical append paths.

## Future sequence

1. Define a versioned `ExecutiveContext` projection.
2. Add advisory request/response events.
3. Add an OpenAI Responses API adapter.
4. Add one explicit **Ask Executive Advisor** interaction.
5. Require structured assessment, evidence, risks, recommendation, alternatives, and uncertainties.
6. Let accepted advice form a proposed command only; retain deterministic validation.
7. Add explicitly requested research after the advisory lifecycle is reliable.
8. Add Claude or other advisory providers through the same vendor-neutral boundary.

Potential invocation points are meaningful health deterioration, a new recommendation, a consequential approval, blocked/conflicting options, a human request, and mission debrief—not continuous background calls.

## Current cut line

Do not implement Advisor events, UI, model integration, provider framework, optimizer changes, or external research during the current submission cycle. The Hermes → Codex live-execution gate remains ahead of this direction.
