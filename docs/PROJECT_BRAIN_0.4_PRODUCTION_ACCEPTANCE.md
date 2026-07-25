# Project Brain 0.4 production acceptance

Date: 2026-07-24
Status: superseded by final combined acceptance

The earlier adapter-only acceptance correctly stopped before execution and
identified missing worker, authorization, audit, remote transport, and context
delivery boundaries. Those findings drove the governed execution and remote
transport releases and are no longer open against the final release candidate.

The current implementation:

- dispatches local Project Brain work through a durable leased worker and
  transactional outbox;
- records canonical lifecycle events and rebuildable projections;
- gates repository writes on policy, exact approval fingerprints, current
  repository authority, and clean checkout/HEAD checks;
- binds immutable context bytes and checksums to one execution;
- verifies the checksum again in local Codex and remote Mission Agent
  execution;
- transports remote operations through signed, leased, replay-protected
  messages with live reauthorization;
- stores and independently verifies bounded artifacts;
- records closure, proposed learning, and evaluation without automatic
  promotion;
- includes migrations `0025_project_brain_governed_execution.sql` and
  `0026_remote_project_brain_transport.sql`;
- resolves the targeted Next.js and sharp runtime advisories.

The final disposable local and remote lifecycles, fresh migration results,
dependency evidence, deployment rehearsal, rollback procedure, and release
disposition are authoritative in
`PROJECT_BRAIN_FINAL_RELEASE_ACCEPTANCE.md`. Historical details remain
available in the 0.4.1 and 0.4.2 reports.

Do not interpret this supersession as deployment authorization. Production
deployment still requires explicit approval and the sequence in the final
acceptance report.
