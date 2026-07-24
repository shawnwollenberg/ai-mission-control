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
