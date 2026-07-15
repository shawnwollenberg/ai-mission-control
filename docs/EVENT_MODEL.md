# Mission Control — Event Model

**Status:** Approved and frozen — 2026-07-15

## Purpose

Every meaningful state change is recorded as a structured event. The append-only event stream is the source of truth for UI projections, Mission Health, optimization, approvals, audit, replay, and demo debugging. Events describe observable facts and decisions, not private model reasoning.

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
- `optimization.requested`
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

Mission Health returns a qualitative status (`on_track`, `moderate_risk`, or `critical`), reasons referencing affected objectives/tasks/resources, evidence event identifiers, confidence, calculation version, critical path, and projected completion.

## UI projection requirements

Each user-visible event should answer at least one of:

- What changed?
- Who or what caused it?
- Why does it matter?
- What happens next?
- Does the human need to act?

Raw prompts, chain-of-thought, secrets, and unfiltered tool payloads must not enter the user-facing event stream.

## Open questions

- Which agent-emitted facts require validation before canonical append?
- What is the exact task dependency graph for the demo?
- What data proves the demo-environment promotion boundary could not be crossed before approval?
- Which events must be persisted versus generated for presentation?
- How are estimates calculated and revised without implying false precision?
