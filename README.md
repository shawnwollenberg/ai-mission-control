# Mission Control

Mission Control is the executive layer for AI teams: a command center where a human can launch a mission, watch an AI organization assemble around the work, understand emerging risk, and approve consequential organizational changes.

- **Live application:** [mission.wallyweb.com](https://mission.wallyweb.com)
- **Source repository:** [github.com/shawnwollenberg/ai-mission-control](https://github.com/shawnwollenberg/ai-mission-control)

## The demo

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

## Architectural constitution

Mission Control has exactly one source of truth: the event log. Mission Plan, Mission Log, Mission Health, recommendations, approvals, artifacts, and the final debrief own no independent business state. Replaying a mission's events from an empty projection reconstructs every user-visible fact except ephemeral UI state.

The public deployment uses:

- Next.js 16, React 19, and TypeScript
- AWS ECS Fargate behind an HTTPS Application Load Balancer
- DynamoDB transactional appends for durable, ordered, idempotent mission events
- Route 53, ACM, ECR, CloudWatch, and Secrets Manager
- AWS CDK for reproducible infrastructure and immutable image rollback

Public demo sessions receive independent, unguessable mission IDs. A completed mission survives application replacement and reconstructs from DynamoDB without projection tables.

## How Codex and GPT-5.6 built Mission Control

Mission Control was built end to end with **Codex powered by GPT-5.6**, used through both the Codex Desktop experience and the Codex CLI.

Codex was not used only for isolated code completion. It operated as the engineering partner across the complete delivery lifecycle:

- Inspected and translated the product brief into an event-sourced architecture and demo-oriented milestones.
- Implemented the Next.js application, interaction states, Mission Log, Mission Health, recommendation, approval, debrief, and ServicePilot preview.
- Built the canonical event model, projections, JSONL development store, and DynamoDB production adapter.
- Wrote and ran projection-rebuild, refresh, idempotency, concurrency, and preview tests.
- Iterated on the visual design using real browser screenshots and product feedback.
- Created and rendered the HyperFrames submission video with ElevenLabs narration.
- Inspected the existing WallyWeb AWS environment using the local AWS CLI profile.
- Designed and deployed the production ECS, ALB, DynamoDB, Route 53, ACM, ECR, Secrets Manager, and CloudWatch stack.
- Diagnosed failures discovered during real hosted rehearsals, shipped immutable container revisions, and verified persistence after terminating the running application task.
- Maintained deployment documentation, rollback instructions, status reporting, Git commits, and the remote repository.

The two Codex surfaces served complementary roles:

- **Codex Desktop** provided the collaborative product-development loop: visual browser review, screenshots, design iteration, long-running implementation work, and demo-quality validation.
- **Codex CLI** provided a focused repository and terminal workflow for code inspection, implementation, automated tests, builds, Git operations, AWS inspection, container publishing, deployment, and operational verification.

The repository history and documentation preserve that process rather than presenting the project as a one-shot generated artifact.

## How ChatGPT shaped the product

ChatGPT was the product-planning partner before and throughout implementation. It helped turn the initial command-center idea into the product judges see:

- Reframed progress around demo capability instead of internal milestone completion.
- Identified the Mission Log as the visible heartbeat of a living AI organization.
- Established the event-sourcing rule that every screen is a projection of canonical history.
- Prioritized the emotional demo arc: mission, organization, crisis, recommendation, human judgment, and payoff.
- Refined product language such as **Mission Plan**, **Mission Log**, **Mission Health**, and **Approve Reorganization**.
- Kept developer tooling and architecture subordinate to the audience-facing experience.
- Helped define honest boundaries between live execution and a verified fallback artifact.

That planning collaboration is encoded in the source-of-truth documents under [`docs/`](docs/) and in [`PLANS.md`](PLANS.md).

## Honest execution boundary

The AWS demo defaults to `ENABLE_LIVE_CODEX=false`. Its bounded Hermes workflow validates a known fallback artifact and records the provenance as `validated_fallback`; the UI never presents that artifact as live Codex execution. Agent-ingestion endpoints require a secret bearer token, and the public runtime exposes no shell, arbitrary prompt, or repository path.

This distinction matters: Codex and GPT-5.6 built and deployed the product, while the reliable public demo explicitly labels whether an artifact inside a demonstrated mission was produced live or selected from the validated fallback.

## Run locally

Requirements: Node.js 22 and npm.

```bash
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
