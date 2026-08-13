# Claude Code Mission Agent adapter

**Status:** Implemented in immutable Mission Agent 0.7.0; production release approval pending

Claude Code is a first-class provider behind the existing outbound-only Mission Agent. It does not use a Claude-specific credential, heartbeat, callback, lease, approval, or trust path. Provider credentials remain on the execution host and are never sent to Mission Control.

## Registration

Choose **Claude Code** during guided onboarding and run the generated checksummed connection command from a Git repository. This creates a distinct agent identity even if a Codex Mission Agent already runs on the same host. To run both providers, register both; do not reuse one agent ID.

The signed heartbeat advertises stable provider `claude_code`, Mission Agent version, roles, operations, runtime-selectable models, structured output, Project Brain context support, and repository mutation. Mission Control refuses capabilities that exceed the owner-approved registration profile.

## Local prerequisites

- Node.js in the repository-supported 22.x range
- Git
- Claude Code available as `claude` on the Mission Agent service `PATH`
- Local Claude authentication configured for that operating-system user
- Project Brain CLI on `PATH` when consensus planning is enabled
- Each selected repository registered with this specific Mission Agent

Run `mission-agent doctor` under the same user/service environment. Mission Control never needs the Claude API key or OAuth material.

## Planning invocation

Consensus planning invokes `claude --print` with the server-selected model, no session persistence, `plan` permission mode, and only Read/Grep/Glob. Bash, Edit, Write, NotebookEdit, WebFetch, and WebSearch are explicitly disabled. The prompt contains exact mission/assignment/snapshot/context/schema bindings plus only the source artifacts released for that phase. Output must be one bounded JSON object and is rejected if malformed, oversized, secret-like, stale, or incorrectly bound.

The host verifies the registered repository path, exact commit, status, and HEAD before and after invocation. A detected mutation fails the turn. Lease renewal, cancellation polling, progress, artifact upload, usage, and completion remain signed protocol operations with the active fencing token.

## Implementation invocation

Claude Code never implements inside `CONSENSUS_PLAN`. After human plan approval, a separate Repository Change Mission requires the executor to acknowledge the exact plan hash and then requires the normal `repository.modify` approval. Only then does Mission Agent create an isolated worktree.

Within the approved worktree Claude receives Read/Edit/Write/Grep/Glob but no Bash or web tools. Mission Agent independently runs only allowlisted validation argument arrays and creates one local commit. Push, PR creation, merge, deployment, infrastructure/credential mutation, and financial operations remain outside this approval. If Claude reports `PLAN_INVALID`, Mission Agent records a reapproval-required deviation artifact and stops.

## Troubleshooting

- **Offline or incompatible:** run `mission-agent status`, then `mission-agent doctor`; confirm the service can resolve `claude` and `project-brain`.
- **Model ineligible:** the requested model must appear in the latest signed heartbeat and owner-approved provider profile.
- **Repository unavailable:** register it with this exact Claude agent using `mission-agent repository add`.
- **Planning mutation detected:** restore the registered checkout to its pre-turn state and start a new attempt; do not override the check.
- **Malformed output:** inspect the redacted execution failure and retry within the mission retry limit. Raw secrets and hidden reasoning are never retained.
- **Stale lease/fence/snapshot/context/hash:** the result is intentionally rejected; reclaim or start the server-directed next attempt.

See `docs/MISSION_AGENT_PROTOCOL.md` and `docs/CONSENSUS_PLAN_OPERATOR_RUNBOOK.md`.
