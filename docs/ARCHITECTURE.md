# Mission Control — Architecture

**Status:** Approved; event-sourcing constitution revised 2026-07-16

## Architectural goal

Support one reliable, inspectable three-minute mission in which agent work, organizational state, optimization, and approval share a coherent event history.

## Architectural constitution

Mission Control has exactly one source of truth: the canonical append-only event log. Everything else is a disposable projection or cache.

- Mission Plan, Mission Log, Mission Health, timeline, optimizer inputs and recommendations, approvals, replay, and every dashboard view own no independent business state.
- No screen may maintain independent business state.
- Every user-visible business fact must identify the canonical events from which it was projected.
- Replaying the canonical event log into an empty system must reconstruct every user-visible view.
- Only ephemeral interface state may remain outside the log: animation progress, scroll position, focus, open/closed panels, and local selections that do not change business behavior.
- If a proposed feature requires independent business state, implementation stops until the exception is explicitly justified and recorded here.

Mission Control is event-sourced, not merely event-driven. Events are durable organizational history; commands and effects may react to them, but events exist primarily so decisions, state, audit, and replay share one authoritative record.

Before implementation, every feature must declare:

1. The canonical event types it consumes.
2. The projection it produces.
3. Its rebuild test from an empty projection store.
4. Confirmation that it owns no independent business state.

## Responsibility model

- **Mission Control** is the executive layer: health, evidence, recommendations, decisions, and organizational memory.
- **Hermes** is a Mission Coordinator within the organization: it contributes planning and coordination capabilities but is not a privileged product layer.
- **Mission Optimizer** is a constrained planner: it evaluates event-derived organizational alternatives but does not execute them.
- **Specialized agents** perform bounded work using declared capabilities and tools.
- **Platform runtime** validates commands, appends canonical events, projects state, and dispatches approved effects.

## Provisional system boundaries

### Mission Control UI

Projects mission state into a small number of legible views: progress, agent ownership, events, approval, and outcome.

Developer Mode is a minimal supporting inspector showing ordered canonical events beside current projected state. It is built after the first judge-facing Mission Plan, Mission Log, and Mission Health slice is visible. It detects drift but is not a product milestone or a second source of truth.

### Platform runtime

Accepts commands, validates invariants, and appends canonical events. Mission, objective, task, resource, approval, and assignment state are projections derived from the event log rather than independently maintained truth.

Hermes uses this boundary as one organization member with coordination capabilities. Canonical append authority and effect dispatch belong to the platform runtime, not to Hermes or any other agent.

### Agent adapters

Expose a small common contract for coordination, research, coding, testing, security, and deployment capabilities. Organization members may have distinct tools and permissions. Whether they are separate processes, model sessions, or controlled executors remains deliberately undecided.

After the hackathon proof sequence, the first real integration will use a versioned vendor-neutral agent protocol for one bounded path: `Mission Control → Hermes → Codex → artifact → Mission Control`. Core events may describe assignments, lifecycle transitions, evidence, artifacts, and outcomes, but must not contain Hermes-, Codex-, or Claude-specific fields. Vendor payloads and lifecycle translation belong inside adapters. Claude Code follows through HTTP hooks only after the Codex path is complete and reliable. This is not authorization for a generalized plugin platform.

### Event store and projector

Persists the canonical append-only mission event stream and deterministically derives read models for the UI, optimizer, health assessment, and audit trail. Replay rebuilds internal state and projections only. Recorded external-effect results replay as facts; replay never repeats GitHub writes, deployments, payments, or other side effects.

### Mission optimizer

Analyzes event-derived objectives, dependencies, duration estimates, resource availability and constraints, agent capabilities, assignments, approvals, budgets, tools, time, and context availability. It returns an evidence-backed organizational revision and projected effect. Feasibility and timing calculations should be deterministic; a model may explain or rank valid alternatives but must not invent impossible allocations.

The MVP action set is deliberately constrained: assign or reassign a ready task to a capable agent, start independent work earlier, split only template-defined work, reprioritize ready tasks, or defer non-blocking work. Recommendations must pass invariant checks before presentation.

The full optimizer contract is defined in `docs/OPTIMIZER_DESIGN.md`.

### Approval and policy service

Creates demo-environment promotion requests, records human decisions, and determines whether a gated action may proceed. It also records acceptance or rejection of recommended replans.

### Aegis smart account adapter

Optional. If technically coherent, proves one policy-governed authority action related to demo-environment promotion. Aegis is supporting infrastructure and must remain behind a narrow adapter. No spending action will be invented for the demo.

### Repository and delivery adapters

Operate on the small ServicePilot demo repository and expose bounded actions for code changes, tests, GitHub pull-request creation, preview deployment, and demo-environment promotion.

## Provisional execution flow

1. Create mission from a fixed template.
2. Hermes creates objectives, tasks, dependencies, and initial assignments.
3. Ready tasks are assigned to agent roles.
4. Agent/tool results become structured events and update task state.
5. The optimizer proposes a valid plan revision based on current organizational state.
6. A human accepts or rejects it; the platform runtime atomically applies accepted changes.
7. Tests and review produce evidence attached to a production approval request.
8. A human decision allows or denies deployment.
9. Orchestrator emits a terminal mission outcome with repository and preview evidence.

## Candidate technology stack

- Next.js, React, TypeScript, and Tailwind
- FastAPI or Go; one must be selected and a separate backend must justify itself
- PostgreSQL
- WebSockets
- GitHub
- OpenAI Agents SDK

With less than one week, this may still be too much infrastructure. Stack preference is not architecture approval.

## Domain hierarchy

Work decomposition: `Mission → Objectives → Tasks`

Resource allocation: mission-scoped resources are required or consumed by objectives and tasks. Agents are allocatable resources with capabilities rather than fixed roles.

- A mission defines the desired organizational outcome, deadline, and priority.
- An objective defines a meaningful outcome or workstream and its dependencies.
- A task is an executable unit contributing to one objective.
- A resource represents constrained capacity: agent, human approval, wallet budget, compute budget, tool access, time, or context.
- An agent resource advertises capabilities such as API research, backend, frontend, database, integration testing, Playwright, GitHub, CI, or cloud deployment.
- An allocation binds resources to an objective or task under explicit constraints.

## Event-sourcing boundary

- Commands request actions such as launch, optimize, approve recommendation, or approve promotion.
- The platform runtime validates commands against the current projection.
- Accepted commands append immutable events in mission-local order.
- Projectors rebuild all application state from events.
- External-effect workers execute outbox intents idempotently and append success/failure events.
- UI animation reacts to projected state changes; it never creates mission state.

## Architecture decisions deferred

- FastAPI versus Go, and whether a separate backend is justified
- Process topology and deployment target
- Persistence technology
- Real-time transport (polling, SSE, or WebSocket)
- Agent framework versus a small custom state machine
- Model and tool providers
- Whether Aegis can coherently govern a software-deployment authority boundary
- Replay/reset strategy
- Authentication (expected to be omitted for the demo)

## Skeptical constraints

- A multi-agent framework is not automatically valuable; use one only if it reduces delivery risk.
- A graph visualization is not automatically understandable; a linear Mission Log with clear dependencies may demo better.
- Streaming tokens are not meaningful observability.
- “Human in the loop” is not differentiated unless the approval is contextual, consequential, and actually enforced.
- On-chain execution is not the product story; it must justify its latency and failure modes.

## Non-functional priorities

1. Deterministic demo reset and replay
2. Clear and monotonic state transitions
3. Idempotent approval/action handling
4. Fast perceived response
5. Honest labeling of controlled or simulated behavior

## Repository Change Mission boundary

Repository changes reuse the existing mission/task/execution/approval/artifact architecture. The server issues a `repository_change` assignment only for a registered repository and compatible pull agent. Mission Agent creates a read-only plan, then emits `ExecutionApprovalRequested` for the exact `repository.modify` action. An approval decision is checked over the signed assignment channel and `ExecutionResumed` is appended only after a grant.

Write execution occurs in a local Git worktree created from the recorded base commit on a `mission/*` branch. Codex receives `workspace-write` access only inside that worktree. Validation commands are parsed server-side and restricted to an allowlist; arbitrary shell evaluation is not used. The runtime collects a plan, execution log, patch, validation output, and review summary before one local commit. It verifies that the registered source branch and worktree did not change.

Canonical mission, task, execution, approval, progress, artifact, and completion events supply user-visible truth. Pull leases, local worktree locations, and restart files are operational coordination only. No new independent product state is introduced. Push, PR creation, merge, deployment, infrastructure/secret changes, and transaction operations remain unavailable.

## Repository Recommendations and Health

Repository Analysis may submit a bounded structured recommendation artifact. The server validates its schema, repository-relative evidence paths, impact/risk vocabulary, acceptance criteria, and validation suggestions before appending one canonical Recommendation aggregate per item. Recommendation projections are workspace- and repository-scoped and rebuild entirely from those events.

Repository Health is the product abstraction for architecture quality, test posture, security findings, technical debt, open recommendations, CI, dependency freshness, documentation completeness, and recent mission activity. Health claims must be explainable projections citing canonical observations and artifacts. Individual agents consume Repository Knowledge and Health; they do not privately own authoritative memory.

Repository Health 0.5 separates observation from calculation. Mission Agent may submit bounded, attributed observations for architecture, tests, security, technical debt, documentation, dependencies, and CI. The platform validates repository-relative evidence and applies the versioned deterministic `repository-health-v1` scoring function. Unknown dimensions remain unscored and lower confidence. A model cannot directly submit or modify a numeric health score.

Each assessment is a canonical `repository_health` aggregate linked to the repository, source mission, execution, artifact, and observed commit. The disposable assessment projection retains comparable history rather than only the latest value. Repository Timeline is a read projection over repository-linked missions, recommendations, assessments, and approvals; it owns no separate timeline state and does not duplicate Git history.

## Delivery authority progression

`Publish for Review` is the first delivery-authority boundary. One owner approval binds repository and remote identity, base branch and commit, generated mission branch, exact local commit, diff and validation evidence, objective, acceptance criteria, and the canonical action hash. The approved effect is only: push that commit without force and create its evidence-rich pull request. Mission Agent performs the push from its retained isolated worktree; the server-side provider creates and confirms the PR. Agent credentials never receive GitHub provider credentials.

The action aggregate provides the rebuildable publication lifecycle: a successful local execution is **Local Changes Ready**; `waiting_for_approval` is **Publication Approval Required**; `executing` is **Publishing**; success with provider evidence is **Pull Request Open**; and failure is **Publication Failed**. CI, review, ready-to-merge, changes-requested, merged, and closed are reserved provider-backed states for later boundaries.

Independent review agents may emit findings and a merge recommendation, but neither is authority. A future merge action must bind the current PR head SHA, target branch, required CI checks, required review decisions, unresolved findings, repository merge policy, and a fresh human approval. Merge remains permanently denied in the current policy engine.

Deployment is a separate future mission. It must bind an exact merged commit, target environment, immutable build artifact, deployment plan, rollback plan, health checks, and deployment-specific approval. Publication approval cannot authorize it; deployment remains denied.

Future autonomy settings are repository policy (`manual`, `publish-after-approval`, `merge-after-checks-and-approval`, and narrowly bounded higher modes), never vague “full autonomy.” Every mode preserves protected-branch controls, evidence requirements, emergency stops, credential isolation, and independent merge/deployment boundaries.

## Open questions

- Where will the demo run and what network access can be assumed?
- Can Aegis enforce anything meaningful in the chosen deployment path without distorting the story?
- Which states must survive a refresh?
- Is denial part of the demo or only approval?
- What telemetry is useful to the target user rather than merely available?
- Which risk formula and intervention are deterministic, legible, and visually convincing?
