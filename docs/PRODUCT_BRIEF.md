# Mission Control — Product Brief

**Status:** Approved and frozen — 2026-07-15  
**Last updated:** 2026-07-15

## One-line concept

Mission Control for AI Teams lets one human command an AI organization.

External promise: **Give your AI organization an objective. Mission Control handles everything else until human judgment is required.**

Emotional hook: **Humans manage outcomes, not AI.**

## Product thesis

Organizations will increasingly consist of specialized AI agents working toward shared outcomes. Their human leader needs more than task tracking: they need to understand whether the mission is healthy, what constrains it, and how the organization should change to finish sooner. Mission Control observes the organization, recommends structural changes, and applies them after human approval.

Software engineering is the first mission domain and supplies the initial target user. It is not the category boundary. Internally, the product principle is **AI Organization Management**. Externally, the clearer message is **Mission Control for AI Teams**.

Mission Control is the executive layer supervising the organization. Hermes is a capability-bearing Mission Coordinator within that organization, alongside research, coding, testing, security, and deployment members. A separate optimizer evaluates organizational changes. The platform runtime validates commands, records events, and dispatches approved effects.

This is a hypothesis, not yet a validated problem statement.

## Proposed demo scenario

A startup CTO launches a mission: **Launch Stripe Billing for ServicePilot today.** Hermes converts the mission into objectives, decomposes them into tasks, and assigns specialized agents. Mission Control analyzes dependencies and capacity, recommends a faster organizational plan, and applies it after human approval. After validation, promotion to the demo environment pauses for explicit approval.

ServicePilot will be a real, intentionally small demo repository rather than the production codebase or a UI-only fiction. Agent work must produce genuine code, tests, a GitHub pull request, and a working preview.

## Product principles

- Optimize for one convincing three-minute vertical slice.
- Mission Control is the product; agents are interchangeable actors.
- Prefer legible progress and causality over raw logs.
- Represent meaningful actions as structured events.
- Ask for human approval only at a genuine risk boundary.
- Present Aegis as understandable spending governance, not blockchain machinery.
- Label simulated behavior honestly.

## Decisions required

### Target user — decided

A startup CTO, technical founder, or engineering manager accountable for production software built by a team of AI coding agents. The primary persona is phrased as: “I’m the CTO of a startup. I have six AI agents coding all day. I need to know what they’re doing.” This is specifically not a generic AI-operations product.

### Core problem — decided at thesis level

Agent work is fragmented across Claude Code, Codex, Cursor, GitHub, Slack, AWS, terminals, Linear, and browser tabs. The CTO cannot quickly determine what is happening now, which agent owns what, what is blocked, or where human judgment is required. Mission Control does not replace those tools; it provides the supervisory layer across them.

The differentiated job is: **Tell me what should happen next, and let me safely reorganize the agents working toward my objectives.**

### Wow moment

**Proactive mission recommendation:** Mission Control continuously projects the organization from its event history. When meaningful evidence identifies a better feasible plan, it surfaces **Optimization Available**, explains why now, quantifies the projected improvement, and invites the user to **Review Recommendation**. After atomic approval, it visibly reconfigures objective execution and resource allocation.

Promotion to the demo environment is the secondary trust payoff: validated work cannot cross that boundary until the accountable human approves it.

### Real versus simulated

The platform state transitions, structured events, repository changes, tests, GitHub pull request, preview, risk calculation, intervention state change, and demo-environment approval gate should be real. Model outputs and timing may use constrained prompts, fixtures, or deterministic delays where necessary, but must be disclosed. Direct control of Codex, Claude Code, or Cursor is not required.

## MVP boundary

Not approved. Provisional boundary:

- One software-engineering mission template
- Mission → objectives → tasks work hierarchy
- Mission-scoped resources: agents, approvals, wallet budget, compute budget, tools, time, and context
- One coordinator plus research, coding, testing, security, and deployment capabilities
- One live mission run at a time
- Mission status, agent roster, structured Mission Log, and approval panel
- One evidence-backed organizational optimization with a coordinated recommendation
- Human acceptance that changes real assignments or dependencies
- One demo-environment promotion approval boundary
- A real pull request, passing tests, and working preview as final proof
- Deterministic reset/replay path for demo reliability

Explicitly out of scope unless discovery changes this:

- Authentication and multi-tenancy
- General-purpose workflow building
- Agent marketplace
- Production billing
- Enterprise role-based access control
- Multiple concurrent missions
- Broad model/provider support

## Success criteria

Undecided. At minimum, a judge should understand within three minutes:

1. What mission is running.
2. Which agent owns each active task.
3. Why the mission paused.
4. What approving the request permits.
5. Whether the mission succeeded.

## Open questions

- What must a judge see to believe this is more than a visualized script?
- Is the primary pain awareness, intervention, or accountability when something goes wrong?
- What minimal optimization logic makes the recommendation credible and reproducible?
- How do we communicate projected time savings without false precision?

## Aegis role — decided at product level

Aegis is not a reason to invent spending. If included, it quietly enforces agent authority or an approval boundary. It is supporting infrastructure, not the narrative focus. Feasibility must be proven before it is promised; otherwise Aegis should be omitted from the initial vertical slice.

## Experience direction — decided

The experience should feel like commanding a mission, not inspecting a project-management board or Grafana dashboard. The visual hierarchy is mission identity and explainable health, objectives, resources/crew, recommendations, approvals, telemetry, and mission log. “NASA” means operational clarity, purposeful motion, and strong status language—not decorative complexity.

The organization should feel alive because meaningful events are occurring, not because the interface simulates activity. The event stream is its heartbeat. Fake typing, fake terminal output, repeated thinking indicators, and decorative Matrix-style motion are prohibited.

The primary emotional outcome is that the audience feels they watched an AI organization form and work. Architectural rigor earns trust, but it is supporting evidence rather than the story presented to judges.

The demo must contain tension: initial progress, an event-derived critical-path crisis, a moment of organizational pause, a proactive recommendation, one human-approved reorganization, and a measurable completion payoff. Mission Control optimizes because the organization encountered a real constraint, never merely because an optimization feature exists.

Organization members assemble progressively through real events rather than appearing as an immediately active roster. When the mission completes, motion and Mission Log activity stop; the organization becomes visibly idle.

Mission Health answers three questions: **Schedule**, **Risk**, and **Next Decision**. It is accompanied by observed evidence, affected objectives, and confidence. The trust pattern is: **evidence → recommendation trigger → rationale → approval**.

The first judge-facing planning panel is named **Mission Plan**. Objectives and tasks remain the internal hierarchy beneath that immediately understandable label.

## Delivery constraints — decided

- Team: one or two people
- Schedule: less than one week
- Priority: polished, visible, real functionality over scale
- Cut rule: anything that does not improve the demo is removed

## Approval gate

Implementation may not begin until this brief, the demo script, the architecture, and the first execution plan are explicitly approved.
