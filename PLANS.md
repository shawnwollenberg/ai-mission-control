# Mission Control — First Execution Plan

**Status:** Approved and frozen — implementation authorized 2026-07-15  
**Planning basis:** One or two builders, less than one week  
**Estimation unit:** Focused person-hours, excluding long unattended external waits  
**Optimization goal:** Maximize the quality and reliability of the 90-second demo, not architectural completeness

## Demo outcome

The smallest successful build must demonstrate this uninterrupted story:

1. A CTO launches “Stripe Billing” with a deadline and priority.
2. Mission Control automatically forms objectives and assigns a capability-based AI organization.
3. Real event-derived state makes objective progress and organization status legible.
4. Mission Health reports **Moderate Risk** with evidence.
5. The CTO clicks **Optimize Mission**.
6. Mission Control explains a safe 22-minute → 15-minute organizational change.
7. The CTO approves once; assignments and objective progress visibly reorganize.
8. Validation passes and demo-environment promotion requires approval.
9. A real or controlled pull request and working Stripe preview prove the outcome.
10. A compressed replay reconstructs the mission without repeating external effects.

## Non-negotiable cut rule

Every task below must produce a visible, testable artifact. If work does not strengthen one of the ten demo beats, improve deterministic recovery, or prove a judge-facing claim, it moves to the backlog.

## Real versus controlled contract

### Must be real

- Canonical append-only event recording
- Event-derived mission, objective, task, resource, allocation, health, and approval state
- Mission launch command and automatic objective creation
- Capability and dependency validation
- Optimizer calculation over the canonical demo state
- Atomic approval and application of the recommendation
- Stale-recommendation rejection
- Promotion approval gate
- Replay reconstruction from recorded events
- Test execution against the ServicePilot demo repository

### May be controlled for reliability

- Agent execution timing
- Exact agent prose and research output
- Repository patch generation, provided the resulting branch and tests are genuine
- GitHub pull-request creation if network credentials are unavailable during judging
- Preview deployment, provided the fallback is explicitly described as a controlled local preview

### Must not be falsely implied

- Control of external Codex, Claude Code, or Cursor sessions
- Learned cross-mission organizational memory
- General-purpose optimization beyond the supported template and operations
- Real production access
- Aegis enforcement unless it is separately proven and rehearsed

## Critical path summary

| Milestone | Estimate | Depends on | Demo classification |
|---|---:|---|---|
| M0 Contract freeze and fixture | 3h | None | Critical |
| M1 Mission walking skeleton | 6h | M0 | Critical |
| M2 Canonical event engine | 8h | M0 | Critical |
| M3 Executive mission UI | 10h | M1, M2 | Critical |
| M4 Organization execution | 8h | M2 | Critical |
| M5 Mission Health and optimizer | 10h | M0, M2, M4 | Critical |
| M6 Optimization approval and animation | 10h | M3, M5 | Critical |
| M7 Proof and promotion gate | 8h | M2, M4 | Critical |
| M8 Replay epilogue | 4h | M2, M3, M6, M7 | Critical but first cut if schedule slips |
| M9 Demo hardening and rehearsal | 10h | M1–M8 | Critical |
| S1 Live GitHub automation | 4h | M7 | Stretch |
| S2 Hosted preview automation | 4h | M7 | Stretch |
| S3 Aegis policy enforcement | 6–10h | M7 | Stretch |

Core plan: approximately **77 focused person-hours**. This is too large for one person working normal hours for less than a week, so the staged cut line and two-person parallel path are mandatory planning tools, not optional process.

## M0 — Freeze the executable demo contract

**Estimate:** 3h  
**Dependencies:** None  
**Classification:** Critical

### M0.1 Define canonical organization fixture — 1.5h

Specify the exact mission, four objectives, tasks, dependencies, capabilities, resource allocations, baseline durations, progress events, and before/after projections.

**Visible artifact:** A reviewed fixture table showing why the initial plan takes 22 minutes and why the feasible optimized plan takes 15 minutes.  
**Test:** A reviewer can calculate both critical paths from the table and obtain the stated values.

### M0.2 Freeze the 90-second presenter path — 1h

Assign exact seconds, clicks, narration, expected UI state, and fallback for every beat.

**Visible artifact:** A single-page presenter runbook with no branching choices during the primary demo.  
**Test:** A tabletop walkthrough completes in 90 seconds without explaining implementation details.

### M0.3 Freeze the truth labels — 0.5h

Label each beat live, controlled, or fallback-only.

**Visible artifact:** Truth-label matrix adjacent to the presenter runbook.  
**Test:** Every visible demo claim maps to an implementation artifact or an explicit controlled behavior.

### Exit criteria

- No unresolved number drives Mission Health or optimization.
- No new product feature may enter the critical path without replacing an existing beat.

## M1 — Mission walking skeleton

**Estimate:** 6h  
**Dependencies:** M0  
**Classification:** Critical

### M1.1 Establish the smallest runtime and UI shell — 2h

Choose one backend approach and eliminate unnecessary process boundaries. Add only the launch and mission routes needed by the demo.

**Visible artifact:** Launch screen loads and transitions to an empty mission screen.  
**Test:** A fresh local start reaches both screens using documented commands.

### M1.2 Launch a fixed mission — 2h

Accept objective text, deadline, and priority; issue a mission-launch command.

**Visible artifact:** Clicking **Launch Mission** creates a mission titled “Stripe Billing” and shows `Planning…`.  
**Test:** Duplicate submission is idempotent and refresh does not create another mission.

### M1.3 Materialize automatic objectives — 2h

Use the canonical mission template to create Research, Implementation, Validation, and Deployment without confirmation.

**Visible artifact:** Four objectives appear in the mission view after launch.  
**Test:** Objective identifiers, order, and dependencies match the frozen fixture.

### Exit criteria

- The first 20 seconds of the demo are clickable end to end.

## M2 — Canonical event engine

**Estimate:** 8h  
**Dependencies:** M0  
**Classification:** Critical

### M2.1 Implement versioned event envelope and append contract — 2h

Support event identity, type/version, mission sequence, timestamps, causation, correlation, visibility, and payload.

**Visible artifact:** Developer event inspector shows ordered launch and planning events.  
**Test:** Duplicate event identity is rejected; mission sequence is monotonic.

### M2.2 Build deterministic projections — 3h

Project mission, objectives, tasks, resources, capabilities, allocations, approvals, and effect status solely from events.

**Visible artifact:** Clearing projections and replaying events restores the same mission screen.  
**Test:** Projection snapshot before and after rebuild is identical.

### M2.3 Add idempotent effect intent/result boundary — 1.5h

Record external actions as intents and outcomes so replay never reruns them.

**Visible artifact:** Event inspector distinguishes requested, started, and completed effects.  
**Test:** Rebuilding or replaying the mission produces zero additional external-effect calls.

### M2.4 Stream projection updates — 1.5h

Deliver live state changes using the simplest reliable transport. WebSockets are preferred only if they remain lower risk than SSE or polling after the runtime choice.

**Visible artifact:** Objective status updates without page refresh.  
**Test:** Disconnect/reconnect converges to the current projected state without duplicate UI events.

### Exit criteria

- The event log is canonical.
- All displayed mission state can be deleted and rebuilt.

## M3 — Executive mission UI

**Estimate:** 10h  
**Dependencies:** M1, M2  
**Classification:** Critical

### M3.1 Establish command-center visual system — 2h

Define restrained NASA-inspired typography, colors, spacing, status language, and motion rules.

**Visible artifact:** Mission shell visibly reads as an operational command surface rather than a generic admin dashboard.  
**Test:** At a glance, a reviewer can identify mission, status, health, and commander.

### M3.2 Render objective progress — 3h

Show Research, Implementation, Validation, and Deployment as large, event-derived progress bars with state and dependency context.

**Visible artifact:** Objective bars advance as canonical fixture events arrive.  
**Test:** Each visual state maps to a projection value; no animation mutates state.

### M3.3 Render organization and resources — 2h

Show Hermes and specialized agents as peers in the organization, with capabilities, allocation, and availability.

**Visible artifact:** Crew view makes idle, active, and blocked capacity understandable without opening task details.  
**Test:** A reviewer can identify the idle Deployment resource in under five seconds.

### M3.4 Render executive mission log — 1.5h

Translate selected canonical events into concise operational language.

**Visible artifact:** Mission log shows planning, assignments, progress, and decisions without raw prompts or chain-of-thought.  
**Test:** Every log entry references a canonical event and respects visibility rules.

### M3.5 Responsive demo layout — 1.5h

Target the actual judging viewport and make the 90-second path usable without scrolling between primary actions.

**Visible artifact:** Full primary flow fits the presentation viewport.  
**Test:** Run at the chosen demo resolution with no clipped controls or layout shifts.

### Exit criteria

- A skeptical viewer understands current outcome, organization, and constraint in ten seconds.

## M4 — Organization execution

**Estimate:** 8h  
**Dependencies:** M2  
**Classification:** Critical

### M4.1 Register capability-bearing organization members — 2h

Represent Hermes as a coordinator-capable peer plus research, coding, testing, security, and deployment members with explicit capabilities.

**Visible artifact:** Crew inspector shows capabilities rather than rigid role permissions.  
**Test:** Capability-incompatible assignments are rejected.

### M4.2 Execute the canonical mission state machine — 3h

Hermes proposes coordination actions from event-derived state; the platform validates them, records accepted facts, and dispatches bounded agent actions.

**Visible artifact:** Launch produces real task transitions and allocations in the mission UI.  
**Test:** No task starts before hard dependencies are satisfied; capacity is never double-allocated.

### M4.3 Attach controlled specialist outputs — 2h

Produce bounded research, implementation, testing, and deployment artifacts with deterministic demo timing.

**Visible artifact:** Each organization member produces one recognizable artifact or outcome.  
**Test:** Restarting the demo fixture produces the same required state transitions within the timing budget.

### M4.4 Failure-safe pause — 1h

Convert agent or effect timeout into a visible blocked state rather than hanging the mission.

**Visible artifact:** Injected failure produces an understandable executive alert.  
**Test:** One forced timeout reaches a recoverable state within the configured limit.

### Exit criteria

- Hermes visibly coordinates the organization as a peer member; the platform runtime retains canonical state and dispatch authority.

## M5 — Mission Health and optimizer

**Estimate:** 10h  
**Dependencies:** M0, M2, M4  
**Classification:** Critical

### M5.1 Compute critical path and projections — 3h

Use frozen durations, dependencies, progress, and allocations to reproduce the current plan.

**Visible artifact:** Analysis view shows the 22-minute projection and Research/Backend dependency evidence.  
**Test:** Automated fixture test reproduces the frozen critical path and duration exactly.

### M5.2 Derive explainable Mission Health — 2h

Continuously project `On Track`, `Moderate Risk`, or `Critical` with event evidence and confidence basis.

**Visible artifact:** Mission Health becomes **Moderate Risk** and cites research overrun, idle resources, and blocked objectives.  
**Test:** Removing or changing the supporting events predictably changes the health result.

### M5.3 Generate one valid organizational recommendation — 3h

Evaluate the declared Implementation split and capability-compatible parallel allocations.

**Visible artifact:** Recommendation card contains evidence, five operations, 22 → 15 minute impact, safety proof, and confidence basis.  
**Test:** Optimizer output matches the frozen fixture and preserves every hard constraint.

### M5.4 Reject unsafe and stale recommendations — 2h

Validate capabilities, capacity, dependencies, required controls, and input sequence when applying.

**Visible artifact:** Diagnostic state explains why a deliberately invalid or stale recommendation cannot be applied.  
**Test:** Attempts to skip validation, invent capability, double-allocate capacity, or approve stale analysis all fail.

### Exit criteria

- Every recommendation claim is reproducible from recorded inputs.
- A language model is not the authority for feasibility or safety.

## M6 — Optimization approval and wow animation

**Estimate:** 10h  
**Dependencies:** M3, M5  
**Classification:** Critical; highest polish allocation

### M6.1 Build Optimize Mission interaction — 2h

Surface **Optimization Available**, run explicit analysis, and present the recommendation at executive depth.

**Visible artifact:** One click transitions from mission state to a legible recommendation without navigation confusion.  
**Test:** The user can state the evidence, proposed change, benefit, and safety rationale after viewing it for ten seconds.

### M6.2 Apply one atomic approval — 2h

Approve all recommendation operations as one idempotent command.

**Visible artifact:** **Approve Optimization** records the decision and begins reconfiguration exactly once.  
**Test:** Double-click or retry cannot apply operations twice.

### M6.3 Animate organizational reconfiguration — 4h

Animate objective bars, splits, allocations, critical-path state, and projected completion in a deliberate sequence driven by new projections.

**Visible artifact:** Research holds, Implementation splits, Frontend/Testing/CI begin, and 22 minutes transitions to 15 minutes.  
**Test:** Slow-motion review shows each animation corresponds to a canonical event-derived state change.

### M6.4 Polish evidence and motion — 2h

Tune pacing, hierarchy, transitions, and focus for the presentation viewport.

**Visible artifact:** The complete optimization beat is understandable without narration.  
**Test:** Three uninformed viewers can describe what changed and why; target at least two accurate responses.

### Exit criteria

- This is the most polished 20 seconds of the product.
- The organization visibly changes; the UI does not merely update a number.

## M7 — Outcome proof and promotion approval

**Estimate:** 8h  
**Dependencies:** M2, M4  
**Classification:** Critical

### M7.1 Create the tiny ServicePilot fixture repository — 2h

Prepare only the baseline application needed to make Stripe Billing understandable and testable.

**Visible artifact:** Baseline app runs locally and visibly lacks the subscription capability.  
**Test:** Fresh setup reaches the baseline state using the documented command.

### M7.2 Produce genuine feature and test artifacts — 2.5h

Apply the controlled implementation result and run real automated validation.

**Visible artifact:** Working Stripe test-mode checkout or subscription preview plus passing test output.  
**Test:** Feature acceptance test and required automated tests pass from a clean fixture state.

### M7.3 Provide pull-request proof — 1.5h

Create a real branch and commit. Use a real GitHub pull request when credentials/network are available; otherwise display a clearly labeled controlled PR fixture backed by the genuine diff.

**Visible artifact:** PR view contains real diff, checks, and mission correlation.  
**Test:** Commit diff matches the tested preview artifact.

### M7.4 Enforce demo-environment approval — 2h

Block promotion until a human decision is recorded.

**Visible artifact:** Approval card shows commit, checks, destination, and policy; approval transitions the preview to promoted state.  
**Test:** Direct promotion before approval fails; approved promotion is idempotent.

### Exit criteria

- The ending proves work happened; “Mission Complete” is supplementary rather than the evidence.

## M8 — Replay epilogue

**Estimate:** 4h  
**Dependencies:** M2, M3, M6, M7  
**Classification:** Critical but first feature cut if schedule slips

### M8.1 Build compressed projection playback — 2.5h

Read the completed event stream and animate historical projection states on an eight-second presentation clock without appending events.

**Visible artifact:** Replay reconstructs launch, objectives, health change, optimization, approval, and completion.  
**Test:** Event count and external-effect call count remain unchanged after replay.

### M8.2 Add epilogue control and reset — 1.5h

Provide a single Replay action and clean return to final state.

**Visible artifact:** Presenter can trigger the replay reliably at 1:22 in the 90-second demo.  
**Test:** Five consecutive replay runs complete within the target duration and return to the same projection.

### Exit criteria

- Replay feels like proof of the architecture, not a second product tour.

## M9 — Demo hardening and rehearsal

**Estimate:** 10h  
**Dependencies:** M1–M8  
**Classification:** Critical

### M9.1 One-command reset and seeded run — 2h

Reset local mission data, ServicePilot branch state, controlled effects, and presenter state.

**Visible artifact:** Clean launch screen appears from one documented reset action.  
**Test:** Five reset/run cycles produce the same canonical checkpoints.

### M9.2 External dependency fallbacks — 2h

Prepare honest controlled fallbacks for model, GitHub, Stripe, and preview-host failures.

**Visible artifact:** Presenter controls can switch to disclosed fixture outcomes without breaking the mission.  
**Test:** Disable each external dependency and complete the demo once.

### M9.3 Timed rehearsal and trimming — 3h

Run the complete 90-second story repeatedly and remove anything that requires explanation but does not advance it.

**Visible artifact:** Recorded rehearsal completes in 90 seconds with the wow moment unobscured.  
**Test:** Three consecutive runs finish within ±5 seconds.

### M9.4 Judge comprehension test — 1.5h

Show the demo to people without project context.

**Visible artifact:** Written notes answering what the product is, what changed, why approval mattered, and what was real.  
**Test:** At least two of three viewers identify “manages outcomes and reorganizes AI teams” rather than “AI Jira/dashboard.”

### M9.5 Final capture and recovery kit — 1.5h

Record a clean backup demo and preserve the exact known-good fixture.

**Visible artifact:** Backup video, presenter runbook, truth labels, reset instructions, and known-good data snapshot.  
**Test:** A teammate can restore and present from the kit without verbal setup.

### Exit criteria

- Demo is repeatable, comprehensible, and recoverable under venue conditions.

## Stretch goals

### S1 — Live GitHub automation — 4h

**Depends on:** M7  
**Artifact:** Mission creates or updates a real GitHub pull request live.  
**Test:** Two rehearsed runs succeed without manual cleanup.  
**Cut condition:** Any credential, rate-limit, or latency instability.

### S2 — Hosted preview automation — 4h

**Depends on:** M7  
**Artifact:** Approved commit promotes to a hosted demo URL.  
**Test:** Promotion completes inside the demo timing budget twice.  
**Cut condition:** Hosting latency or setup threatens M6/M9.

### S3 — Aegis policy enforcement — 6–10h

**Depends on:** M7  
**Artifact:** Aegis credibly enforces a relevant authority boundary without invented spending or blockchain exposition.  
**Test:** Pre-approval action fails, post-approval action succeeds, and fallback is rehearsed.  
**Cut condition:** No natural enforcement mapping is proven in two hours of isolated investigation.

## Two-person parallel schedule

### Day 1 — Contract and foundations

- Both: M0
- Builder A: M1
- Builder B: M2

**Checkpoint:** Launch creates replayable objectives by end of day.

### Day 2 — Product becomes legible

- Builder A: M3
- Builder B: M4

**Checkpoint:** Canonical fixture visibly advances through the organization.

### Day 3 — Differentiation and proof

- Builder A: M6 interaction shell, then M7 UI/proof surfaces
- Builder B: M5 optimizer, then M7 execution/approval

**Checkpoint:** 22 → 15 recommendation applies to real state; tested artifact is visible.

### Day 4 — Wow moment and replay

- Both: M6 animation and comprehension review
- One builder only after M6 is strong: M8 replay

**Checkpoint:** Rough 90-second end-to-end demo.

### Day 5 — Hardening only

- Both: M9
- Stretch work is forbidden until three consecutive successful rehearsals.

**Checkpoint:** Known-good build, backup capture, and recovery kit.

## Solo cut plan

For one builder, reduce scope before reducing rehearsal:

1. Use one application runtime and the simplest live-update mechanism.
2. Use controlled specialist outputs rather than multiple live model calls.
3. Keep genuine local tests and a genuine Git branch/diff.
4. Use a controlled PR surface if GitHub automation costs more than 90 minutes.
5. Use a local preview and simulated promotion state if hosting costs more than 90 minutes.
6. Cut replay before cutting optimization animation or hardening.
7. Omit Aegis entirely unless sponsor rules require it.

## Ranked delivery risks

| Rank | Risk | Likelihood / impact | Mitigation | Kill signal |
|---:|---|---|---|---|
| 1 | Scope exceeds available person-hours | High / Critical | Freeze contract; honor cut order; no stretch before rehearsal | Critical path misses Day 3 checkpoint |
| 2 | Optimization looks scripted or mathematically false | Medium / Critical | Frozen calculable fixture; event evidence; deterministic tests | Reviewer cannot reproduce 22 → 15 |
| 3 | UI reads as AI Jira/Grafana | Medium / High | Executive hierarchy; outcome language; objective/resource emphasis | Viewer describes it as task tracking |
| 4 | Wow animation is confusing | Medium / High | Allocate 10h; test without narration; simplify motion | Viewer cannot explain before/after |
| 5 | External model/GitHub/Stripe/host fails | High / High | Controlled outputs and honest offline fallbacks | Two rehearsals fail on same dependency |
| 6 | Event sourcing consumes the hackathon | Medium / High | Minimal append log and projectors; no generic framework | Infrastructure work has no visible artifact after 4h |
| 7 | Real artifact path is too large | Medium / High | Tiny fixture repo; narrow Stripe test-mode feature | Baseline-to-proof flow not complete by Day 3 |
| 8 | Replay reissues effects or diverges | Low / High | Projection-only replay; effect-count invariant | Replay changes event/effect counts |
| 9 | Aegis distorts the story | Medium / Medium | Stretch only; two-hour feasibility kill switch | Requires invented spend or explanation detour |

## Definition of demo-ready

- One reset action restores the known-good initial state.
- Three consecutive 90-second runs finish within ±5 seconds.
- Optimize Mission produces the same evidence-backed feasible recommendation.
- Atomic approval visibly changes event-derived organizational state exactly once.
- Required testing and environment approval remain intact after optimization.
- The final diff, test result, PR/PR fixture, and preview correspond to one another.
- Replay appends no events and repeats no effects.
- The presenter can state exactly what is live, controlled, and fallback-only.
- Unfamiliar viewers describe the product as managing AI-team outcomes, not tracking tickets.

## Approval record

- Product brief: approved 2026-07-15
- Demo script: approved 2026-07-15
- Architecture: approved 2026-07-15
- First execution plan: approved 2026-07-15

All four planning gates were approved on 2026-07-15. Planning documents are frozen unless the user explicitly requests a design change.
