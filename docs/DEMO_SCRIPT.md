# Mission Control — Three-Minute Demo Script

**Status:** Approved and frozen — 2026-07-15  
**Target duration:** 3:00

## Audience takeaway

“One human can command an AI organization—and Mission Control tells them what that organization should do next.”

## Story skeleton

### 0:00–0:20 — Launch from intent

Do not begin on a dashboard. The CTO enters:

- Objective: Integrate Stripe subscriptions into ServicePilot
- Deadline: Today
- Priority: High

They click **Launch**.

### 0:20–0:45 — Launch

Mission Control comes alive. Hermes creates outcome-oriented objectives, decomposes them into tasks, and assigns a specialized crew. Research, implementation, validation, and delivery become visible with their dependencies.

### 0:45–1:15 — Parallel work becomes legible

Research, coding, testing, and security activity appears as structured, human-readable events. The audience sees the important transitions rather than token streams: documentation found, implementation begun, tests run, secrets reviewed.

### 1:15–1:55 — Optimize Mission (wow moment)

Mission Health becomes **Moderate Risk**, supported by evidence such as research exceeding its estimate, coding capacity sitting idle, and deployment remaining blocked. The CTO clicks **Optimize Mission**. Mission Control analyzes objective dependencies and available agent, tool, approval, budget, time, and context resources. It presents:

- Critical path and supporting event evidence
- Overloaded, idle, blocked, or constrained resources
- A coordinated organizational change set
- Current and revised projected completion

The CTO clicks **Approve Optimization** once. Objective progress bars animate: Research remains active, Implementation splits, Validation starts earlier, and the critical path changes. Projected completion moves from 22 to 15 minutes. This changes real event-derived organizational state even if agent timing is controlled for reliability.

### 1:55–2:20 — Validation and environment approval

Tests and security review pass. Mission Control requests promotion to the demo environment with commit, checks, preview, and destination context. The CTO approves; the transition is enforced and recorded.

### 2:20–2:40 — Completion

The mission resolves with a real GitHub pull request, passing tests, a working deployment or local preview, the functioning Stripe subscription feature, and a concise audit trail.

### 2:40–2:50 — Close

Restate the transformation: opaque autonomous work became observable, explainable, and governable execution. Mention what was live and what was simulated.

### 2:50–3:00 — Replay epilogue

Click **Replay**. Reconstruct the mission rapidly from its event history: objectives form, work advances, health changes, the organization reorganizes, approval occurs, and the mission completes. Replay must rebuild recorded state without re-executing external actions.

## On-screen surfaces

Provisional, not approved:

- Mission identity and explainable health
- Agent roster with current responsibility
- Event-driven timeline or feed
- Resource-aware optimization recommendation
- Production deployment approval with validation context
- Final outcome summary
- Replay control for the closing epilogue

The initial concept also asks for branching timeline, tool/model usage, and spending detail. These may be too much for a three-minute demo and must earn their place.

## Demo integrity

Before implementation, every beat will be labeled as one of:

- **Live:** actually executed during the demo
- **Controlled:** real product behavior driven by deterministic inputs or fixtures
- **Simulated:** prerecorded or synthetic behavior disclosed as such

## Failure recovery

Undecided. The final plan must include seeded state, reset instructions, timeouts, an offline-safe path, and a presenter fallback that does not misrepresent simulated behavior as live.

## Open questions

- What specific ServicePilot baseline and completion artifact will be shown?
- What concrete risk and intervention produce the most memorable transformation?
- Does the demo show actual parallel execution, or controlled event interleaving?
- What final artifact proves useful work happened?
- Can Aegis credibly enforce a deployment boundary, or should it remain outside the initial demo?

## Proposed 90-second cut

### 0:00–0:10 — Pain

“I have six coding agents across terminals, GitHub, and cloud tools. Which one needs me right now?” Show fragmented activity only briefly, or state it without opening more products.

### 0:10–0:20 — Intent

Enter the Stripe subscription objective, deadline, and priority; click **Launch**.

### 0:20–0:43 — Organization forms

Hermes proposes a plan; the platform validates it and the organization forms. Research becomes active, coding waits on its result, and testing and security become visible downstream. Three meaningful events advance quickly.

### 0:43–1:04 — Optimize the organization

The CTO clicks **Optimize Mission**. Mission Control shows the critical path, idle capacity, and a coordinated recommendation. The CTO accepts; the objective timeline and crew assignments visibly reconfigure.

### 1:04–1:22 — Trust boundary and proof

Tests and security checks pass. Demo-environment promotion pauses for CTO approval. Approve, then show the real pull request and functioning Stripe subscription preview.

### 1:22–1:30 — Close

“I didn’t manage six agents. I gave the organization an objective, intervened once where judgment mattered, and Mission Control kept me informed.”
