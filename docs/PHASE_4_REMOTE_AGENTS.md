# Phase 4 — Generic Authenticated Remote Agents

**Status:** Approved architecture; first authenticated Hermes slice in progress — 2026-07-18

## Boundary and invariants

Phase 4 adds a generic remote transport around the existing Mission, Task, Execution, Approval, Policy, Action Request, event, and projection authority. Codex and Hermes are adapters. Neither runtime can directly update projections or invent domain transitions.

Every feature consumes canonical execution/agent/artifact/approval events and produces rebuildable projections. Transport leases, nonce retention, rate counters, and delivery attempts are bounded operational records, not business truth. Merge, deployment, production remediation, secret access, wallet signing, transaction submission, and unrestricted commands are absent or denied.

## Trust and credentials

An owner registers a workspace-scoped remote agent with endpoint, adapter type, protocol versions, domains, allowed capabilities, allowed callback actions, concurrency, and trust level. Registration creates an opaque credential ID and 256-bit secret. Mission Control returns the secret once and stores only an HMAC-derived verifier plus version/status/timestamps. Events contain IDs and lifecycle facts, never secrets, hashes, or signatures.

Rotation creates a replacement credential and configurable overlap. A heartbeat proves adoption before the owner revokes the old credential. Revocation is checked on every request and takes effect immediately. Multiple active credentials are permitted only during the recorded overlap.

Protocol 1.0 uses HMAC-SHA256. The canonical signature input is newline-joined HTTP method, request path, timestamp, nonce, message ID, lowercase SHA-256 body checksum, and protocol version. Requests carry agent, credential, timestamp, nonce, message, protocol, checksum, and signature headers. Comparisons use fixed-length buffers and `timingSafeEqual`.

## Message protocol

The versioned envelope contains `protocolVersion`, `messageId`, `idempotencyKey`, `agentId`, `workspaceId`, `sentAt`, `messageType`, `correlationId`, and `payload`. Execution messages also carry mission, task, execution, and attempt. Schemas reject unknown envelope fields and validate bounded payloads before commands run.

Outbound: `ExecutionRequested`, `ExecutionResumeRequested`, `ExecutionCancellationRequested`, `ApprovalDecisionDelivered`, and `AgentConfigurationChanged`.

Inbound: `ExecutionAccepted`, `ExecutionRejected`, `ExecutionHeartbeat`, `ExecutionProgressReported`, `ExecutionArtifactSubmitted`, `ExecutionApprovalRequested`, `ExecutionPaused`, `ExecutionResumed`, `ExecutionSucceeded`, `ExecutionFailed`, `ExecutionCancellationAcknowledged`, `AgentHeartbeat`, and `AgentCapabilitiesReported`.

Messages report observable facts and bounded summaries. Prompts, chain-of-thought, unrelated mission history, owner credentials, and raw secrets are excluded.

## Delivery and callback semantics

Requesting a remote execution appends the existing execution event and creates an outbox message in the same transaction. A leased remote-delivery worker signs the immutable body and POSTs it to the registered endpoint. A valid 2xx structured transport acknowledgement records `delivered`; it never records `accepted`. Acceptance or rejection arrives later through the authenticated callback protocol.

Delivery is at least once. Stable message and idempotency IDs let Hermes deduplicate. Attempts are bounded, use jittered exponential backoff, recover expired leases, and classify endpoint/timeouts as retryable, malformed acknowledgements as non-retryable, and authentication/replay problems as security failures requiring audit without unbounded retry.

All inbound messages use `POST /api/agent-protocol/v1/messages`. The route authenticates headers, clock, credential, signature, workspace and agent, then validates the schema, reserves nonce/message idempotency, and invokes application commands. Repeating the same message and checksum returns the stored acknowledgement. Reusing a nonce or reusing a message ID with a different checksum is rejected and audited. The route never edits a projection directly.

## Capabilities and assignment

Capabilities are versioned strings grouped as software, monitoring, DeFi analysis, and writing/research. Capability means allowed and able; it does not grant resource access. Assignment requires workspace match, enabled/healthy status, domain support, every required capability, resource grants, concurrency headroom, policy allowance, and protocol compatibility. The owner chooses among eligible agents; deterministic recommendation may rank health, recent success, and declared cost. No LLM selection is authoritative.

Financial execution capabilities (`transaction.sign`, `transaction.submit`, `funds.transfer`, `position.modify`) are not registerable in Phase 4.

## Heartbeats and health

Agent heartbeat and execution heartbeat are distinct. Canonical heartbeat-received events establish audit facts; a compact operational heartbeat row supports high-frequency freshness checks. Status is calculated by Mission Control:

- `active`: valid credential, enabled, fresh heartbeat, capacity available, no material delivery failure trend.
- `degraded`: fresh enough but saturated or showing bounded recent failures.
- `stale`: heartbeat beyond the assignment threshold.
- `offline`: heartbeat beyond the offline threshold or endpoint repeatedly unavailable.
- `disabled`: owner disabled or no valid credential; always ineligible.

Defaults: 30-second heartbeat request, stale after 90 seconds, offline after 5 minutes. Thresholds are versioned configuration and tested with a controllable clock.

## Artifacts and approvals

Small inline artifacts are capped, decoded, checksum verified, and written through `ArtifactStore`; metadata is appended canonically. Larger artifacts use a preauthorized object-store upload. External references require policy approval. Agents never select local paths. Phase 4 defaults are 256 KiB callback bodies, 128 KiB inline artifacts, and a 10 MiB preauthorized artifact limit.

A remote agent may request an approval but never decide it. The generic request includes action type, parameter summary, target, risk, evidence, reversibility, expiration, and recommendation. Policy denies prohibited actions immediately, otherwise uses the existing durable approval aggregate. An approval-decision outbox message delivers the result; policy is revalidated before any action. Remote approvals are limited to analysis and workflow decisions.

## Hermes integration

The first adapter is a small Hermes-side bridge process with a durable local inbox ledger. It implements protocol 1.0 independently of Discord, acknowledges delivery, deduplicates by message ID, recovers accepted work after restart, sends heartbeats and capability reports, and maps Hermes observable lifecycle output to generic callbacks.

The first genuine task is a read-only Mission Control operational-health report. It reads configured health and operational query endpoints, reports concise progress, submits one Markdown report, and completes. It cannot restart services, mutate infrastructure/database/policy, or access secrets. A later DeFi fixture is analysis only and must state: “Analysis only. No transaction was signed or submitted.”

## Limits and rate control

Defaults are versioned: 256 KiB callbacks, 128 KiB inline artifacts, one progress message per second with a bounded burst, six heartbeats per minute, 60-minute execution duration, five delivery attempts, four concurrent HTTP deliveries per agent, five-minute clock skew, and ten-minute nonce retention. Enforcement keys include workspace and agent. Security failures use stricter bounded counters and never echo internals.

## Local and production topology

Local development runs PostgreSQL, Next.js, the existing general/Codex/action workers, a remote-delivery worker, and the Hermes bridge as separate processes. The bridge receives only its one-time credential through process environment or an ignored local secret file.

Production keeps the same logical separation: web/control plane, PostgreSQL, object storage, remote-delivery worker, and independently deployed Hermes bridge behind TLS. A managed secret provider replaces local secret material. No inbound public callback is anonymous; network policy and rate limiting supplement protocol authentication.

## Threat model

| Threat                     | Control                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Stolen or forged message   | Per-agent versioned HMAC secret, TLS, timestamp and credential checks              |
| Replay or duplicate        | Nonce retention, immutable message checksum, idempotent command result             |
| Cross-workspace callback   | Credential/agent/workspace/execution association checks                            |
| Agent escalation           | Capability and resource separation, policy check, prohibited capability vocabulary |
| Malicious payload/artifact | Strict schema/size/type/checksum validation and encoded UI rendering               |
| Secret leakage             | One-time display, verifier-only persistence, redaction, secret-free events/logs    |
| Endpoint abuse             | Per-agent/workspace rate limits, body limits, bounded concurrency and retries      |
| Confused acceptance        | Delivery and execution acceptance are separate canonical facts                     |
| Restart duplication        | Durable outbox/inbox ledgers, leases, stable IDs, terminal-state validation        |

## Migration impact and rollback

Forward migrations add remote agent configuration/credentials, message receipts/nonces, delivery projections, heartbeat state, capability/resource grants, and indexes. Existing Codex agents and executions retain their schema and behavior. New event schemas are additive and rebuildable.

Rollback stops the remote worker and bridge, disables remote registration/callback routes, and leaves canonical events and additive tables intact for a forward-compatible application rollback. Credentials may be revoked without deleting history. No committed event is rewritten or removed.

## First boundary acceptance

The first review occurs after a genuine bridge registers and heartbeats; one durable request is delivered; Hermes accepts, reports progress, submits a verified Markdown artifact, and completes; and duplicate/replay/changed-payload cases are safely rejected. Remaining Phase 4 work then covers assignment/health depth, approvals, UI, DeFi analysis, mixed Hermes/Codex execution, recovery, and complete validation.
