# Feature Changelog

## Original Hackathon Demo

- A polished three-minute software-release mission narrative.
- Mission plan, objectives, tasks, agent roster, mission health, and structured Mission Log.
- A deterministic critical-path constraint and evidence-backed optimization recommendation.
- Human approval of a real organizational replan.
- A separate approval boundary for promotion to a demo environment.
- A fact-derived mission debrief and replayable demonstration state.
- Clearly labeled controlled, fixture-driven, or simulated agent behavior where real integrations were not present.

The original submission did not include public signup, personal workspaces, production persistence, a distributable local agent, or the current live execution protocol.

## Production Additions

- Durable PostgreSQL event sourcing with rebuildable projections and an outbox.
- Self-service signup and isolated personal workspaces.
- Real Codex execution.
- Real Hermes execution.
- Mixed-agent orchestration with vendor-neutral core events.
- Deterministic policies and contextual human approvals.
- Bounded branch push and provider-confirmed GitHub pull-request creation.
- Mission Templates.
- Recurring scheduling.
- Notifications and delivery tracking.
- Usage and budget controls.
- Attention-first operations dashboard.
- Public landing page and documentation.
- Public GitHub repository.
- One-command, versioned and checksummed agent onboarding.
- Pull-based Mission Agent execution over outbound HTTPS.
- Durable assignments, leases, acknowledgement, renewal, cancellation, release, idempotency, and restart recovery.
- Signed heartbeats, progress messages, artifact submission, and completion/failure reporting.
- macOS Keychain support and owner-only Linux credential-file fallback.
- A complete read-only Codex adapter and adapter contract for additional runtimes.

## Current Limitations

- Autonomous merge is prohibited.
- Autonomous deployment and production remediation are prohibited.
- Infrastructure and secret modification are prohibited.
- DeFi signing, transaction submission, and asset movement are prohibited.
- The Codex adapter is the first complete local Mission Agent execution adapter.
- Hermes has live execution support elsewhere in the product, but its local Mission Agent adapter is not yet the complete first-run path.
- Claude Code and Generic Remote Agent can be selected and connected, but do not yet have a production-complete local execution adapter equivalent to Codex.
- Windows credential storage and service operation are not production-supported.
- This evidence package does not include an honest single-run mixed Hermes/Codex screenshot, approval-gated publication screenshot, or live DeFi screenshot.
