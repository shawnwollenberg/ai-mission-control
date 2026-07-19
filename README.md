# Mission Control

Mission Control is the executive layer for AI teams: a command center where a human can launch a mission, watch an AI organization assemble around the work, understand emerging risk, and approve consequential organizational changes.

- **Product and documentation:** [missioncontrol.wallyweb.com](https://missioncontrol.wallyweb.com)
- **Live application:** [app.missioncontrol.wallyweb.com](https://app.missioncontrol.wallyweb.com)
- **Source repository:** [github.com/shawnwollenberg/ai-mission-control](https://github.com/shawnwollenberg/ai-mission-control)

## What Mission Control does

Mission Control gives an AI organization one durable operating surface:

- Launch reusable **Mission Templates** instead of rebuilding prompts and task graphs.
- Delegate work to Codex, Hermes, Claude Code, or generic remote agents.
- Reconstruct mission state from an append-only event log.
- Gate consequential actions through parameter-bound human approvals.
- Enforce permanent policy boundaries around deployment, merges, infrastructure, secrets, and transactions.
- Record execution evidence, artifacts, heartbeats, failures, retries, and final outcomes.

Mission Control is free while it is evolving. It is used daily to manage a real AI organization, and feedback from people building their own agent teams is welcome.

## Mission Templates

Mission Templates are the fastest path from intent to coordinated execution. Pick a workflow, provide a few focused inputs, and Mission Control resolves the task graph, agent requirements, policies, evidence expectations, and approval boundaries.

The durable template model and initial software, operations, research, DeFi, and mixed-agent workflows are implemented today. The product direction expands that catalog around recognizable jobs such as Software Feature, Production Bug, Security Review, PR Review, Research, Architecture Design, Customer Onboarding, Daily DeFi Review, and Weekly Health Report.

## The original demo

Launch the built-in Stripe Billing mission and Mission Control will:

1. Form a Mission Plan and activate specialized agents.
2. Record every meaningful action in the canonical Mission Log.
3. Detect a believable critical-path delay.
4. Explain a reorganization that improves the estimate from 22 to 15 minutes.
5. Ask a human to approve the reorganization.
6. Record verified implementation and validation evidence.
7. Finish with an executive Mission Debrief and a controlled ServicePilot preview.

There is no fake typing or decorative terminal activity. Every visible transition corresponds to a canonical event or a projection rebuilt from those events.

## Durable local control plane

The authenticated Phase 1 path now runs on PostgreSQL canonical events and rebuildable mission, task, dependency, and approval projections. `npm run worker` advances only clearly labeled simulated tasks through leased database jobs. See [the Phase 1 completion report](docs/PHASE_1_COMPLETION_REPORT.md) and [worker operations](docs/WORKER_OPERATIONS.md). The DynamoDB demo described below remains deployed legacy compatibility evidence, not the authority for the new browser path.

Phase 2 adds a separate `npm run worker:codex` process for an owner-registered, repository-allowlisted Codex agent. It runs only in generated Git worktrees, records live heartbeats, commands, tests, checksummed artifacts, and a local commit, and never pushes, merges, or deploys. See [the Phase 2 completion report](docs/PHASE_2_COMPLETION_REPORT.md) and [Phase 2 operations](docs/PHASE_2_OPERATIONS.md).

Phase 3 adds deterministic policy, durable parameter-bound approvals, and a separate `npm run worker:actions` publication boundary. A generated branch push and pull-request creation require distinct approvals and execution-time revalidation. Merge, deployment, force push, protected-branch writes, secrets, infrastructure changes, and financial actions remain denied. See [the Phase 3 completion report](docs/PHASE_3_COMPLETION_REPORT.md) and [Phase 3 operations](docs/PHASE_3_OPERATIONS.md).

## Architectural constitution

Mission Control has exactly one source of truth: the event log. Mission Plan, Mission Log, Mission Health, recommendations, approvals, artifacts, and the final debrief own no independent business state. Replaying a mission's events from an empty projection reconstructs every user-visible fact except ephemeral UI state.

The current low-cost public deployment uses:

- Next.js 16, React 19, and TypeScript
- PostgreSQL for durable, ordered, idempotent canonical events and rebuildable projections
- One ARM-based AWS EC2 host running isolated web, PostgreSQL, and Caddy containers
- Route 53, ECR, S3, Systems Manager, Secrets Manager, and encrypted gp3 storage
- Automatic HTTPS through Caddy
- AWS CDK for reproducible, intentionally small infrastructure

The application explicitly prohibits autonomous deployment, merge, infrastructure modification, secret modification, transaction signing, and transaction submission. Releasing Mission Control itself is a separate human-approved development activity.

## How ChatGPT, Codex, and GPT-5.6 Were Used

Mission Control was built through a repeated design-and-implementation workflow involving ChatGPT, Codex, and GPT-5.6.

### ChatGPT: Architecture, Product Design, and Review

ChatGPT acted as my technical architect, product strategist, and design partner.  I used it to develop the product concept, design the event-sourced architecture, define the agent and execution model, establish safety and approval boundaries, review implementation progress, and turn each milestone into detailed instructions for Codex.

### Codex: Implementation, Testing, and Deployment

Codex acted as the primary implementation agent.  It audited the repository, wrote and refactored the application, created tests, implemented production infrastructure, fixed deployment issues, built the Mission Agent onboarding flow, and validated the system through integration tests, restarts, replay, and projection verification.

Codex was used through both Codex Desktop and the Codex CLI.  Desktop supported the collaborative product loop, browser review, screenshots, and longer implementation sessions.  The CLI provided the focused repository and terminal workflow for code inspection, tests, builds, Git operations, container publishing, deployment, and operational verification.

### GPT-5.6: The Model Powering Codex

GPT-5.6 was the language model used by Codex during implementation.  It powered Codex as it interpreted the implementation plans, inspected the codebase, wrote code, created tests, debugged failures, produced documentation, and assisted with deployment.

The workflow was:

1. I described the problem, goals, and constraints to ChatGPT.
2. ChatGPT helped me design the system and produce a detailed implementation plan.
3. I gave that plan to Codex.
4. Codex, powered by GPT-5.6, implemented and validated the work.
5. I reviewed the results with ChatGPT and planned the next phase.

The repository history, source-of-truth documents under [`docs/`](docs/), and [`PLANS.md`](PLANS.md) preserve that process rather than presenting the project as a one-shot generated artifact.

## Honest execution boundary

The AWS demo defaults to `ENABLE_LIVE_CODEX=false`. Its bounded Hermes workflow validates a known fallback artifact and records the provenance as `validated_fallback`; the UI never presents that artifact as live Codex execution. Agent-ingestion endpoints require a secret bearer token, and the public runtime exposes no shell, arbitrary prompt, or repository path.

This distinction matters: ChatGPT helped design and plan Mission Control, while Codex, powered by GPT-5.6, built and deployed it.  The reliable public demo explicitly labels whether an artifact inside a demonstrated mission was produced live or selected from the validated fallback.

## Run locally

Requirements: Node.js 22 and npm.

```bash
nvm use
npm run runtime:check
npm ci
npm run db:up
npm run db:migrate
npm run auth:hash -- 'choose-a-local-password'
npm run db:seed
npm run typecheck
npm test
npm run build
npm run dev
```

Configure the PostgreSQL and owner/session environment variables documented in [Durable Browser Mission Operations](docs/DURABLE_BROWSER_OPERATIONS.md), then open `http://localhost:3000`. New browser missions use PostgreSQL as their canonical event and projection store. JSONL and DynamoDB remain only for temporary legacy-demo/import compatibility; no AWS credentials are required locally.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the production architecture, environment variables, deployment process, health checks, logs, rollback, persistence verification, limitations, and estimated cost.

## Contributing and licensing

Issues, design discussion, and focused pull requests are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md). Please report vulnerabilities through the process in [`SECURITY.md`](SECURITY.md), not a public issue.

The repository is publicly readable, but no open-source license has been selected yet. Copyright remains with the project owner until explicit license terms are added.
