# Mission Control 2.0 routing kernel

**Status:** Phase 1 routing-kernel spike authorized by the product owner on 2026-08-29. This is local design and
test code only. It does not authorize commit, push, merge, deployment, external API calls, database migration, or
production changes.

## Approved refinements

1. Project Constitution/configuration is initially owned by Mission Control, not copied into every repository.
2. Architect and Engineer are interfaces. Provider-specific implementations are adapters outside the routing kernel.
3. Internal persistence is limited to reconstructable bindings, processed revisions, and in-flight dispatch identity.
4. `DISCUSS` routes to the Architect through ChatGPT. Mission Control does not provide a chat interface.

## Spike boundary

The spike contains five initial contracts, one internal CTO-decision signal, deterministic transition and dispatch
logic, capability-oriented CTO escalation validation, revision-based idempotency, a local Agent Payment Risk Check
fixture, and tests using fake adapter identifiers.

The spike deliberately contains no GitHub client, Codex client, OpenAI client, provider credentials, network access,
database state, UI, worker, repository mutation, signing, transaction, or deployment behavior.

## Reconstruction model

The kernel is a pure function of the Mission Control-owned project constitution, current durable mission envelope,
new structured signal, last processed revision, and—only for a CTO decision—the pending request revision. Its result
contains the next mission envelope and at most one adapter dispatch with a deterministic idempotency key. A future
adapter may persist only the provider thread/conversation binding and in-flight delivery identity needed to resume
work; durable mission content remains externally reconstructable.
