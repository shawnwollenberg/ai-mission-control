# Mission Optimizer — Design

**Status:** Approved and frozen — 2026-07-15  
**Last updated:** 2026-07-15

## Purpose

The optimizer recommends changes to the structure and resource allocation of an AI organization so a mission can finish sooner without violating its constraints.

It does not execute work. The platform runtime dispatches approved work and records outcomes. Hermes participates as the organization's Mission Coordinator. The optimizer does not present itself directly to the user; Mission Control turns its output into an evidence-backed executive recommendation.

For the MVP, the optimizer answers one narrow question:

> Can this mission finish sooner by reorganizing available agent capacity across work that is feasible now, without weakening required validation or bypassing human authority?

## Responsibility boundaries

### Mission Control — executive layer

- Continuously assesses mission health.
- Identifies when executive attention may be valuable.
- Presents evidence, recommendation, rationale, expected impact, and safety.
- Requests one atomic human decision.
- Explains the resulting organizational change.

### Hermes — Mission Coordinator

- Proposes objectives and tasks from the launched mission.
- Contributes planning and coordination capabilities as an organization member.
- Proposes actions through the validated command boundary used by other agents.
- Does not own canonical state, effect dispatch, approvals, or constraint enforcement.
- Cannot independently apply an optimization or bypass constraints.

### Platform runtime — execution authority

- Validates commands against event-derived state.
- Appends canonical events.
- Dispatches approved agent and external effects idempotently.
- Applies an approved optimization atomically after revalidation.

### Optimizer — constrained organizational planner

- Reads a versioned snapshot derived from canonical events.
- Finds the current critical path and resource inefficiencies.
- Evaluates only allowed organizational operations.
- Produces a feasible recommendation and comparison to the current plan.
- Does not mutate mission state or execute side effects.

### Event system — organizational record

- Stores immutable facts in mission-local order.
- Reconstructs the current mission, resource, allocation, and approval state.
- Provides evidence identifiers cited by health assessments and recommendations.
- Enables deterministic state replay without repeating external effects.

## What the optimizer knows

The optimizer receives an event-derived, versioned snapshot. It does not query UI state.

### Mission

- Identifier and mission type
- Desired outcome
- Deadline or target completion
- Priority
- Current lifecycle state
- Current projected completion

### Objectives

- Outcome and acceptance criteria
- Required versus optional status
- Objective dependencies
- Current state and progress evidence
- Tasks belonging to the objective

### Tasks

- Required outcome
- Parent objective
- Current lifecycle state
- Required capabilities
- Task dependencies
- Earliest feasible start
- Assigned resources
- Baseline and revised duration estimates
- Whether the task is splittable, and its template-defined valid subtasks
- Whether it is required for validation or promotion

### Dependencies

- Predecessor and successor
- Dependency type: hard, soft, or informational
- Scope: objective or task
- Satisfaction state and evidence
- Whether partial output can release only part of a successor

The MVP optimizer may never infer that a declared hard dependency is unnecessary. The mission template or an accepted planning event must explicitly encode valid partial dependencies.

### Resources

MVP optimization resources are deliberately limited to:

- Agent capacity
- Agent capabilities
- Work dependencies
- Available time

Each agent resource exposes:

- Stable identity
- Declared capabilities
- Capacity, represented as one active task in the MVP
- Current allocation and availability
- Tasks already completed during this mission

Human approvals, tool access, wallet budget, compute budget, policy, and available context are modeled as constraints, not optimization variables in the MVP.

### Capabilities

Capabilities are explicit, composable labels rather than fixed roles. Candidate demo vocabulary:

- `documentation_research`
- `api_analysis`
- `internet_search`
- `backend`
- `frontend`
- `database`
- `unit_testing`
- `integration_testing`
- `playwright`
- `github`
- `ci`
- `demo_deployment`

An agent may hold multiple capabilities. An assignment is feasible only if the assigned agent satisfies every required capability, unless the task explicitly permits a multi-agent allocation.

### Constraints

The optimizer treats constraints as inviolable:

- Hard objective and task dependencies
- Required validation steps
- Required human approvals
- Agent capability requirements
- Maximum agent capacity
- Tool and environment access
- Declared safety and policy rules
- Mission state, such as a paused or terminal mission
- Atomicity of the proposed change set

### Durations

- Mission templates provide baseline task durations.
- Actual start, progress, block, and completion events revise projections.
- The MVP uses deterministic arithmetic over those inputs.
- Historical learning is not part of the MVP.
- Displayed projections should use sensible rounding and avoid false precision.

## Optimization objective

Choose the feasible organizational plan with the earliest projected mission completion while preserving all required validation, approval, capability, capacity, tool, and policy constraints.

For the MVP, this is a single-objective calculation. It does not trade safety, quality, or cost for speed. Future versions may support explicit weighted priorities, but hidden tradeoffs are prohibited.

## Decisions the optimizer can make

The optimizer selects from a closed operation set.

### Reassign work

Move a ready or not-yet-started task to an available agent with the required capabilities.

### Split work along declared boundaries

Replace a splittable objective or task with template-defined child tasks. The optimizer does not invent arbitrary decomposition. In the demo, `Implementation` may split into `Backend Billing` and `Frontend Checkout` because that split and its dependencies are defined by the mission template.

### Parallelize independent work

Start ready work concurrently when dependencies are satisfied and capable resources are available.

### Reorder ready work

Prioritize critical-path work over ready non-critical work.

### Delay non-critical work

Defer optional or explicitly deferrable work when doing so releases a constrained resource. Required testing and security controls are never classified as deferrable in the demo.

### Escalate an approval

Recommend that Mission Control request a required human decision earlier. The optimizer cannot grant the approval or assume its outcome.

### Preserve safety constraints

Carry every required validation, approval, and policy constraint into the proposed plan and show that each still has a feasible path to completion.

## Decisions the optimizer can never make

- Ignore or remove a required dependency.
- Skip required testing, security review, or acceptance criteria.
- Bypass, fabricate, or assume human approval.
- Invent an agent capability, tool permission, budget, or completed result.
- Exceed an agent's declared capacity.
- Violate a policy or environment restriction.
- Modify running or completed work unless an explicit safe transition supports it.
- Execute repository, deployment, wallet, or other external actions.
- Apply a recommendation based on stale organizational state.
- Claim learned historical insight when only current-mission evidence exists.
- Present model-generated prose as proof of feasibility.

## Optimization process

1. Read the current event-derived snapshot at mission sequence `N`.
2. Validate that the mission is running and optimizable.
3. Construct the objective/task dependency graph.
4. Compute current earliest start/finish times and critical path.
5. Identify resource states: active, idle, blocked, overloaded, or unavailable.
6. Enumerate allowed operations using template-defined splits and capability-compatible assignments.
7. Reject candidates that violate any constraint or invariant.
8. Recompute projected completion for feasible candidates.
9. Select the best improvement; use deterministic tie-breaking.
10. Produce an immutable recommendation referencing sequence `N` and its evidence events.
11. Revalidate the recommendation against current state when the user approves it.
12. Append either acceptance and plan-revision events or a stale/rejected outcome.

## Demo scenario: canonical before and after

### Initial organization

```text
Research
   ↓
Implementation
   ↓
Validation
   ↓
Deployment
```

Current state:

- Research is examining Stripe authentication and billing documentation.
- Implementation is represented as one serialized objective.
- Coding is blocked waiting for all research.
- Testing is waiting for all implementation.
- Deployment is idle.
- Projected completion is 22 minutes.

### Evidence discovered by the optimizer

- Only backend billing work depends on the unfinished API research.
- Frontend checkout scaffolding has no unsatisfied hard dependency.
- Test fixtures can be prepared before implementation completes.
- CI configuration can begin before application code is ready.
- Capable frontend, testing, and CI resources are available.

### Recommended organization

```text
Research ─────→ Backend Billing ──┐
                                 ├─→ Validation ─→ Demo Deployment
Frontend Checkout ───────────────┤
Test Fixture Preparation ────────┘
CI Preparation ──────────────────────────────────┘
```

Atomic proposed operations:

1. Split `Implementation` into `Backend Billing` and `Frontend Checkout` using the declared template boundary.
2. Allocate a frontend-capable coding agent to begin `Frontend Checkout` immediately.
3. Allocate the testing agent to `Test Fixture Preparation` immediately.
4. Allocate the deployment agent to `CI Preparation` immediately.
5. Keep Research on the critical backend dependency.

All required validation and demo-environment approval remain in the plan.

Projected completion changes from 22 minutes to 15 minutes. These exact durations are provisional until the full demo event fixture is defined and calculated.

## Recommendation contract

Every recommendation contains:

### Evidence

- Current mission sequence
- Evidence event identifiers
- Current critical path
- Blocked, idle, overloaded, and unavailable resources
- Relevant dependencies and capability matches

### Proposed organizational change

- Atomic ordered operations
- Affected objectives, tasks, resources, and allocations
- Preconditions for each operation

### Expected impact

- Current versus proposed projected completion
- Rounded time savings
- Resource utilization changes
- Risk status changes, if any

### Why it is safe

- Constraint checks performed
- Required validation preserved
- Required approval preserved
- Capability and capacity checks passed
- No hard dependency removed

### Confidence

Confidence measures input completeness and estimate stability, not model certainty.

Provisional calculation:

- **High:** all relevant dependencies and capabilities are declared; duration estimates have current execution evidence; no ambiguous resource state.
- **Medium:** the plan is feasible, but one or more durations still rely only on template baselines.
- **Low:** missing or ambiguous inputs materially affect the projected benefit. Low-confidence recommendations should not be presented as the primary demo recommendation.

## Mission Health relationship

Mission Health runs continuously and is separate from optimization.

- Health answers exactly three top-level questions: “What is the schedule state?”, “What is the risk level?”, and “What decision is needed next?”
- Optimization answers: “Can a safe organizational change improve the outcome?”

Optimization analysis is proactive. Event-derived trigger rules run when relevant organizational facts change. If a safe material improvement exists, the canonical log records the trigger, its “why now?” evidence, and the resulting recommendation. Mission Health then projects **Optimization Available** and the UI offers **Review Recommendation**. Reviewing and atomically approving or rejecting the recommendation remain explicit user actions; applying it is never automatic.

## Events

Minimum optimizer lifecycle:

- `recommendation.triggered`
- `optimization.analysis_started`
- `optimization.recommendation_created`
- `optimization.no_improvement_found`
- `optimization.approved`
- `optimization.rejected`
- `optimization.stale`
- `organization.reconfiguration_started`
- `objective.split`
- `resource.reallocated`
- `plan.revised`
- `organization.reconfiguration_completed`
- `organization.reconfiguration_failed`

The recommendation stores its input mission sequence, calculation version, operations, evidence references, projections, safety checks, and confidence basis.

## Determinism and model use

The MVP optimizer should be deterministic for a given event-derived snapshot, mission template, and optimizer version. A language model may:

- Generate concise executive-facing explanations from verified structured output.
- Help Hermes propose the initial objective plan before it is validated.
- Rank equally feasible alternatives only if deterministic tie-breaking remains available for demo mode.

A language model may not be the sole authority for dependency satisfaction, capability matching, constraint validation, time calculation, or approval enforcement.

## Acceptance criteria

- The canonical demo snapshot produces a feasible recommendation from current events.
- Every claimed fact cites event-derived evidence.
- The recommendation contains the five intended organizational changes.
- Approval is atomic and idempotent.
- Approval against changed state produces `optimization.stale` rather than applying unsafe changes.
- Applying the recommendation changes canonical allocations and objective/task structure.
- Replaying the resulting events reconstructs the same post-optimization organization.
- All required testing and demo-environment approval remain present.
- No external side effect is repeated during replay.
- Current and revised completion projections are reproducible from recorded inputs.

## Explicit non-goals for MVP

- Learning across missions
- Optimizing wallet or compute spend
- Dynamic capability inference
- Arbitrary model-generated objective decomposition during optimization
- Multi-mission portfolio allocation
- Automatic application without human approval
- Probabilistic simulation or Monte Carlo forecasting
- General-purpose scheduling for every organization type

## Roadmap: organizational memory

After multiple missions, Mission Control may learn recurring organizational patterns such as research overruns, systematically late frontend starts, or reusable knowledge gaps. This requires versioned historical features, sufficient sample sizes, transparent evidence, and controls against treating correlation as causation. It is product direction, not an MVP claim.

## Open decisions

- Final canonical task durations and dependency fixture
- Exact capability catalog and agent roster
- Whether an objective split is represented as replacement or child activation
- Mission Health rules that trigger `Optimization Available`
- UI treatment for evidence without overwhelming the executive view
