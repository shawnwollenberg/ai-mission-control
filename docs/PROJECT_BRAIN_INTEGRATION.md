# Project Brain integration

Mission Control consumes Project Brain through its versioned JSON consumer contract. Project Brain remains the
authority for repository knowledge, context selection, closure records, learning proposals, evaluation, and
curation. Mission Control remains the authority for missions, assignments, executions, approvals, and its event
log.

## Boundary

- Registration is explicit. A repository is never initialized automatically.
- Discovery, validation, summary, health, diagnostics, context reads, and knowledge listing are read-only.
- Context preparation and closure recording may create Git-visible artifacts and require an explicit caller
  action.
- Learning promotion is never performed by this adapter. Proposal and evaluation results are displayed in a
  read-only approval inbox.
- The adapter invokes a configured executable with a fixed argument allowlist, `shell: false`, a registered
  repository working directory, bounded output, a timeout, and a minimal environment.
- Markdown returned by Project Brain is rendered as text. It is never injected as trusted HTML.

## Event and projection model

Each adapter invocation returns a `project_brain.adapter_invoked` audit event containing the workspace,
repository, optional mission/execution identifiers, operation, argument names, starting and ending SHA, contract
version, result classification and exit status, duration, artifact references and checksums, and hashes of captured
stdout/stderr. The event contains no request values, raw stdout/stderr, secrets, or knowledge body.
The caller appends this event through Mission Control's canonical event-store transaction when the invocation is
part of a durable workflow.

Repository status, summary, context previews, and the approval inbox are read projections of Project Brain
responses. They are not Mission Control business state and must not be used to infer mission or approval
transitions.

## User flows

1. A repository operator explicitly enables the integration and configures the Project Brain executable.
2. Repository detail requests detection, compatibility, validation, summary, health, and diagnostics.
3. Before assignment, a mission planner previews a context pack with a byte budget and optional missing-context
   hints. The quality panel labels completeness and precision separately and never claims optimality.
4. On explicit confirmation, context preparation writes the pack. Its checksum, starting Git SHA, contract
   version, mission ID, execution ID, and revision become execution evidence.
5. After work, Mission Control may explicitly record closure or create a learning proposal. The approval inbox
   displays pending proposals and deterministic evaluation results but cannot promote them.

## Failure states

Missing installation, incompatible contract or schema, invalid repository state, dirty-worktree write refusal,
timeout, output truncation, malformed JSON, and non-success exit classifications are distinct typed failures.
They retain warnings, blockers, and required actions from the consumer envelope where available.

## Deliberate exclusions

There is no automatic initialization, automatic promotion, semantic or vector retrieval, repository-local daemon,
cross-repository knowledge graph, hidden write path, or replacement for Mission Control's event log.

## Installation and configuration

Project Brain is optional. With no `PROJECT_BRAIN_EXECUTABLE`, Mission Control does not invoke it and unrelated
repository and mission workflows continue normally.

| Variable                         | Required when enabled | Default   | Purpose                                                         |
| -------------------------------- | --------------------- | --------- | --------------------------------------------------------------- |
| `PROJECT_BRAIN_EXECUTABLE`       | yes                   | none      | Absolute path to the non-interactive `project-brain` executable |
| `PROJECT_BRAIN_REQUIRED_VERSION` | no                    | `0.4.0`   | Exact core version accepted by this release                     |
| `PROJECT_BRAIN_CONTRACT_VERSION` | no                    | `1.0`     | Consumer contract that capability discovery must advertise      |
| `PROJECT_BRAIN_TIMEOUT_MS`       | no                    | `15000`   | Positive per-operation wall-clock bound                         |
| `PROJECT_BRAIN_MAX_OUTPUT_BYTES` | no                    | `1000000` | Positive captured-output bound                                  |

Do not point the executable at a shell wrapper that loads an interactive profile. Install the package into a
dedicated runtime environment and configure the absolute entry-point path. The Codex skill installation is not a
Mission Control runtime dependency.

### Local development

1. Create or select a Python environment supported by Project Brain.
2. Install the canonical Project Brain package at version `0.4.0`.
3. Run `project-brain doctor` and `project-brain capabilities --json`.
4. Set the five variables above in the local service environment.
5. Restart Mission Control and inspect `/api/health` plus a deliberately registered repository.

Tests should use a synthetic executable and disposable Git repository; they must not depend on a developer home
directory or mutate a real consumer repository.

### Production-like installation

Install Project Brain in the immutable application/worker image or a dedicated read-only runtime layer. Configure
the absolute path and pinned versions through the deployment environment. Do not inject repository/provider
credentials into Project Brain operations. Ensure registered checkout roots and the executable are accessible to
the process that owns the adapter boundary.

Before rollout, run production configuration validation, database migration validation, Project Brain capability
discovery, the production build, and a disposable-repository lifecycle. This release does not deploy or initialize
repositories automatically.

### Upgrade

1. Install the candidate Project Brain package alongside the current executable.
2. Run `doctor`, capability discovery, Project Brain tests, and Mission Control adapter tests.
3. For schema changes, validate deliberately selected repositories before changing configuration.
4. Update `PROJECT_BRAIN_REQUIRED_VERSION` and the executable path together.
5. Restart and verify health/status projections. Never rewrite or promote repository knowledge as part of upgrade.

### Rollback

Restore the previous executable path and required version, then restart Mission Control. If immediate isolation is
needed, unset `PROJECT_BRAIN_EXECUTABLE`; normal Mission Control workflows remain available and Project Brain UI
surfaces become unavailable. Do not delete `.project-brain` artifacts: Git remains their authority. Roll back
application commits through the normal reviewed release workflow; this integration has no database migration.

## Operator troubleshooting

- **Not configured/not installed:** set an absolute executable path or intentionally leave the integration disabled.
- **Incompatible:** compare configured version/contract with `project-brain capabilities --json`; install a matching
  package rather than weakening validation.
- **Repository not initialized:** request explicit repository approval before running `project-brain init`.
- **Invalid repository/schema:** run `project-brain validate --repo PATH`; repair the named authoritative artifact.
- **Timeout/output bound:** inspect bounded server diagnostics, then adjust limits only after confirming the
  repository and operation are expected.
- **Dirty worktree:** use a clean isolated checkout for writing operations.
- **HEAD mismatch:** discard the stale preview/pack and prepare context again against the current execution SHA.
- **Temporary failure:** unrelated Mission Control operations remain available; retry the same allowlisted operation.

User-facing messages are deliberately generic and do not expose checkout paths or raw CLI output. Detailed causes
remain in server-side diagnostics and structured adapter results.

## Known limitations

The first release supports one repository-local Project Brain installation contract. It does not provide background
synchronization, repository initialization, promotion actions, knowledge editing, semantic retrieval, network
service discovery, or cross-repository knowledge. Project Brain invocations remain synchronous and bounded; a
future phase should move them behind the durable worker/outbox boundary before high-volume production use.
