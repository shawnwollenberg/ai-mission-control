# Mission Control — Event Model

**Status:** Approved; event-sourcing constitution revised 2026-07-16

## Purpose

Every meaningful state change is recorded as a structured event. The append-only event stream is the sole source of truth for Mission Plan, Mission Log, Mission Health, optimization, approvals, audit, replay, developer inspection, and every other business projection. All projection stores are disposable caches. Events describe observable facts and decisions, not private model reasoning.

## Candidate event envelope

| Field | Purpose |
|---|---|
| `event_id` | Unique event identity |
| `event_type` | Versioned semantic name |
| `occurred_at` | Source timestamp |
| `recorded_at` | Ingestion timestamp |
| `mission_id` | Mission correlation |
| `task_id` | Optional task correlation |
| `agent_id` | Optional actor correlation |
| `causation_id` | Event or command that caused this event |
| `correlation_id` | Cross-step operation correlation |
| `sequence` | Stable mission-local ordering |
| `visibility` | User-facing, diagnostic, or hidden-sensitive |
| `payload` | Event-specific, versioned data |

Whether all fields are needed in the MVP remains undecided.

## Candidate event families

### Mission

- `mission.created`
- `mission.started`
- `mission.paused`
- `mission.resumed`
- `mission.completed`
- `mission.failed`

### Plan and task

- `plan.created`
- `objective.created`
- `objective.started`
- `objective.blocked`
- `objective.completed`
- `task.created`
- `task.assigned`
- `task.started`
- `task.blocked`
- `task.completed`
- `task.failed`

### Agent and tool

- `agent.status_changed`
- `agent.output_submitted`
- `tool.call_started`
- `tool.call_completed`
- `tool.call_failed`

### Resource and allocation

- `resource.registered`
- `resource.availability_changed`
- `resource.constraint_changed`
- `resource.allocated`
- `resource.released`
- `agent.capabilities_registered`

### Approval and policy

- `approval.requested`
- `approval.granted`
- `approval.denied`
- `policy.check_started`
- `policy.check_passed`
- `policy.check_failed`

### Risk and intervention

- `mission.risk_detected`
- `recommendation.triggered`
- `optimization.completed`
- `intervention.recommended`
- `intervention.accepted`
- `intervention.rejected`
- `plan.revised`
- `organization.reconfiguration_started`
- `objective.split`
- `resource.reallocated`
- `organization.reconfiguration_completed`
- `organization.reconfiguration_failed`

### Delivery

- `repository.change_created`
- `pull_request.created`
- `check.completed`
- `preview.ready`
- `deployment.requested`
- `deployment.started`
- `deployment.succeeded`
- `deployment.failed`

## Core state machines

Provisional only:

- Mission: `created → running ↔ paused → completed | failed`
- Objective: `pending → active → blocked | completed | failed`
- Task: `pending → ready → assigned → running → blocked | completed | failed`
- Intervention: `recommended → accepted | rejected → applied | failed`
- Deployment approval: `requested → granted | denied | expired`
- Deployment: `pending_approval → authorized | denied → deploying → succeeded | failed`

Cancellation, retry, and partial completion semantics are intentionally deferred until the demo story requires them.

## Optimization recommendation payload

Candidate fields: input mission sequence, critical path, idle or misallocated capacity, current completion projection, proposed operations and reasons, revised projection, preconditions, and invariant-check result. Applying a stale recommendation must fail safely if organizational state changed after analysis.

## Replay semantics

Given the same ordered event stream and projector version, Mission Control must reconstruct the same internal mission state. Replay consumes recorded external-effect outcomes as facts and never reissues external side effects. Projector and event-schema versions must be recorded to prevent silent historical drift.

Replay is also a user-visible demo projection: it re-emits historical projection states on a compressed clock without appending new canonical mission events.

## Mission Health projection

Mission Health answers exactly three executive questions:

| Field | Initial example | Actionable example |
|---|---|---|
| Schedule | `Planning` | `Delayed` |
| Risk | `Unknown` | `Moderate` |
| Next Decision | `None` | `Optimization Available` |

Schedule values are `planning`, `on_track`, or `delayed`. Risk values are `unknown`, `low`, `moderate`, or `high`. Next Decision is `none`, `optimization_available`, or a specific pending approval boundary required by the demo.

The projection also carries reasons referencing affected objectives/tasks/resources, evidence event identifiers, confidence, calculation version, critical path, and projected completion. Those fields support explanation but do not add a fourth top-level answer.

An optimization recommendation is proactive. When event-derived rules find a meaningful intervention, the runtime appends `recommendation.triggered` with the reasons, evidence event identifiers, and estimated benefit. The UI then shows **Review Recommendation**; it does not ask the user to initiate analysis with an always-visible **Optimize Mission** button.

## UI projection requirements

Each user-visible event should answer at least one of:

- What changed?
- Who or what caused it?
- Why does it matter?
- What happens next?
- Does the human need to act?

Raw prompts, chain-of-thought, secrets, and unfiltered tool payloads must not enter the user-facing event stream.

The event stream is the visible heartbeat of the organization and must appear in the earliest mission UI. The judge-facing name is **Mission Log**, not Event Feed. The initial log may be visually plain, but it must be causally honest.

- No fake typing indicators or repeated `Thinking…` states.
- No synthetic terminal spam or decorative activity events.
- Every animation corresponds to a newly appended canonical event or to a projection state emitted during explicit replay.
- Quiet means no meaningful organizational event occurred; the UI must not manufacture motion to appear busy.

## Developer Mode projection inspector

Developer Mode renders two synchronized projections from the same canonical log:

- **Events:** ordered sequence, type, actor, causation, correlation, and payload summary.
- **State:** current Mission, Mission Plan, task/assignment, Mission Health, recommendation, and approval projections.

Its first acceptance test appends `mission.created`, `plan.created`, `task.created`, `task.assigned`, `task.started`, and `task.completed`, then verifies the visible state after every sequence number. Clearing all projections and replaying those events must reproduce identical inspector and product views.

## Open questions

- Which agent-emitted facts require validation before canonical append?
- What is the exact task dependency graph for the demo?
- What data proves the demo-environment promotion boundary could not be crossed before approval?
- Which events must be persisted versus generated for presentation?
- How are estimates calculated and revised without implying false precision?
