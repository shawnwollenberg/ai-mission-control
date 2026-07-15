# Mission Control — Backlog

**Status:** Approved and frozen — implementation authorized 2026-07-15

## Now: product decisions

- [x] Select one exact target user and current alternative
- [x] Write the product-level core problem statement
- [x] Choose the concrete software-release mission
- [x] Select Optimize Mission as the memorable wow moment
- [x] Define demo-environment promotion as the approval risk boundary
- [ ] Classify each demo beat as live, controlled, or simulated
- [ ] Define the final artifact and proof of completion
- [x] Define final proof categories: real PR, tests, preview, working feature
- [x] Record deadline and team capacity
- [ ] Obtain judging criteria, tracks, sponsor requirements, and required technologies

## Next: experience and system design

- [ ] Approve the three-minute beat sheet
- [ ] Reduce UI to the minimum surfaces needed for the story
- [ ] Define mission, task, approval, and spending state machines
- [ ] Define objective states and objective/task dependencies
- [ ] Define optimizer inputs, operations, invariants, and stale-plan behavior
- [x] Draft optimizer knowledge, decision, prohibition, explanation, and safety contract
- [ ] Define resource types, constraints, allocations, and capability vocabulary
- [ ] Define explainable Mission Health states, evidence rules, and confidence
- [ ] Define command, canonical append, projection, outbox, and safe replay semantics
- [ ] Define canonical event envelope and demo event catalog
- [ ] Decide orchestration approach and agent execution contract
- [ ] Define Aegis responsibility and failure behavior
- [ ] Prove or reject Aegis deployment-policy feasibility; do not invent spend
- [ ] Reduce and validate the candidate technical stack and deployment shape
- [ ] Design deterministic reset, fixtures, and fallback path
- [ ] Design 8-second replay projection that never reissues effects
- [ ] Create risk register with owners and mitigations

## Approval gate

- [x] Product brief explicitly approved
- [x] Demo script explicitly approved
- [x] Architecture explicitly approved
- [x] First execution plan explicitly approved

## Later: implementation milestones

The implementation sequence, estimates, dependencies, visible artifacts, acceptance criteria, stretch cuts, and risks are maintained in `PLANS.md`.

No additional planning artifact should be created unless it resolves a concrete blocker in that execution plan.

Acceptance criteria will be added only after the product and architecture decisions are made.

## Explicitly parked

- Authentication and user management
- General workflow editor
- Multi-tenant data isolation
- Production billing
- Agent marketplace
- Broad integrations catalog
- Multiple concurrent mission management
- Enterprise analytics and permissions
