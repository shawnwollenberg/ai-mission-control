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

The first implementation screenshot is deliberately smaller than the final command center: mission **Integrate Stripe Billing**, status **Planning…**, Mission Plan forming, Mission Health showing Schedule **Planning**, Risk **Unknown**, Next Decision **None**, and a Mission Log showing **Mission Created** then **Hermes Planning…**. Do not wait for a complete dashboard before this state is demoable.

### 0:45–1:15 — Parallel work becomes legible

Research, coding, testing, and security activity appears as structured, human-readable events. The audience sees the important transitions rather than token streams: documentation found, implementation begun, tests run, secrets reviewed.

The organization first reaches an earned **On Track / Low Risk** state. Then the demo introduces a believable crisis: Research exceeds its estimate, Coding remains waiting, and the critical path blocks. Pause for one beat while Mission Health changes to Schedule **Delayed**, Risk **Moderate**, Next Decision **Optimization Available**. This conflict is required; without it, the recommendation is an unearned feature demonstration.

### 1:15–1:55 — Review recommendation (wow moment)

Mission Health becomes Schedule **Delayed**, Risk **Moderate**, Next Decision **Optimization Available**. Mission Control has already analyzed objective dependencies and available resources. It explains “why now?”—research exceeded its estimate, coding became idle, and a new parallel path is feasible. Mission Control presents the recommendation in context:

- Critical path and supporting event evidence
- Overloaded, idle, blocked, or constrained resources
- A coordinated organizational change set
- Current and revised projected completion

The CTO clicks **Approve Reorganization** once. A visible reorganization state shows resources moving onto the critical path: Research remains active, Implementation splits, Validation starts earlier, and the critical path changes. Projected completion moves from 22 to 15 minutes. This changes real event-derived organizational state even if agent timing is controlled for reliability.

### 1:55–2:20 — Validation and environment approval

Projection tests, the production build, and the preview interaction pass as visible event-derived checks. A controlled local preview becomes ready. Hosted preview and promotion approval remain deferred until a genuine destination exists.

### 2:20–2:40 — Completion

The mission resolves into a still **Mission Debrief** rather than another dashboard. It mirrors the opening promise with “Here are the outcomes your AI organization produced,” shows **Completed**, **14m 52s**, **7m estimated savings**, and **1 human decision**, then presents one primary proof: an interactive, honestly labeled controlled local preview. A single **Open Preview** action closes the loop. Pull-request proof appears only after a genuine PR exists. All organizational motion stops so the audience can absorb the outcome.

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

Mission Control proactively shows **Optimization Available** with the critical path, idle capacity, estimated seven-minute savings, and “why now?” evidence. The CTO clicks **Approve Reorganization**; the Mission Plan and crew assignments visibly reconfigure.

### 1:04–1:22 — Trust boundary and proof

Tests and security checks pass. Open the controlled local preview and demonstrate the subscription selection flow. Do not show GitHub, CI, or deployment surfaces unless they are genuine and add more clarity than the preview.

### 1:22–1:30 — Close

“I didn’t manage six agents. I gave the organization an objective, intervened once where judgment mattered, and Mission Control kept me informed.”
