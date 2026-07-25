# Project Brain 0.4 Mission Control release notes

Status: final release candidate

This release adds governed Project Brain 0.4 integration for local server
repositories and pull-mode Mission Agent repositories.

Highlights:

- explicit repository enablement and read/write authority;
- durable outbox and leased Project Brain worker execution;
- fixed operation allowlists, bounded subprocesses, and sanitized failures;
- approval fingerprints bound to repository, mission, execution, operation,
  arguments, agent, HEAD, versions, and write scope;
- immutable context artifact storage and exact checksum verification by local
  Codex and remote Mission Agents;
- signed remote requests, capability negotiation, live reauthorization,
  idempotent receipts, restart recovery, and replay protection;
- independent artifact path, schema, size, checksum, and repository binding
  validation;
- canonical event history and deterministic projection rebuild;
- read-only learning inbox with closure, proposal, and evaluation status;
- no automatic initialization or learning promotion;
- Mission Agent `0.6.7`;
- Next.js `16.2.11` and sharp `0.35.0`.

Database migrations:

1. `0025_project_brain_governed_execution.sql`
2. `0026_remote_project_brain_transport.sql`

Required worker/runtime configuration and the exact deployment and rollback
order are documented in `PROJECT_BRAIN_FINAL_RELEASE_ACCEPTANCE.md`.

This release candidate has not been merged to `production`, pushed, published,
or deployed. Those actions require explicit approval.
