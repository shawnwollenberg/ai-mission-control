# Phase 4 Remote-Agent Operations

## Runtime and boundaries

Use Node 22.20 or newer within major version 22 and PostgreSQL. Remote agents receive only registered resources and signed protocol messages. They never receive Mission Control secrets, arbitrary local paths, repository access by implication, signing authority, transaction submission authority, merge authority, deployment authority, or production-remediation authority.

Capability, resource permission, and policy permission are independent checks. A capability says what an agent can do; a resource grant says which named input it may access; policy decides whether that exact action is allowed now. Assignment requires all three, plus workspace, credential, protocol, domain, health, and concurrency checks.

## Workers

- `npm run worker:remote-agents` claims durable outbound deliveries.
- `npm run worker:hermes` runs the Hermes bridge. Set its endpoint, credential, agent identity, and scenario through the environment produced by `npm run phase4:acceptance:setup`.
- `npm run worker:codex` runs bounded Codex tasks.
- `npm run worker:actions` executes separately approved publication actions.

All workers use leases and idempotency keys. Restarting a worker may redeliver work but must not create a second logical execution, approval decision, artifact, or downstream task.

## Credential rotation

Rotate from the agent detail page. Copy the replacement secret at creation because it is shown once and only verifier material is stored. During the configured overlap, old and replacement credentials authenticate. A heartbeat signed by the replacement marks it verified. Revoke the old credential only after verification. Revoke-all is an emergency action and immediately prevents new callbacks; an already-running remote process may continue locally, but Mission Control rejects further messages and will derive stale/offline state.

## Health and incidents

Mission Control derives health from heartbeat age, valid credentials, delivery/protocol/execution failures, saturation, and manual disablement. Thresholds are configured with `REMOTE_AGENT_HEARTBEAT_INTERVAL_MS` and `REMOTE_AGENT_OFFLINE_MS`. Protocol failures are recorded with bounded reason codes and paths, never signatures or secrets. Rate limits are per workspace, agent, category, and minute.

For a compromised credential: use revoke-all, disable the agent, inspect security events and deliveries, then issue a replacement only after the bridge is trusted. For stuck work: stop the affected worker, inspect its durable job/delivery state, correct the non-secret configuration, and restart it. Do not mutate canonical events.

## Recovery and verification

Run migrations, then `npm run projections:rebuild` and `npm run projections:verify`. Canonical events remain the source for mission, task, execution, approval, and artifact state; credential verifiers, nonce/rate windows, and delivery leases are security/operational records. Replay callbacks with the same message ID and payload to confirm the original result; a changed payload must be rejected.

The DeFi scenario is fixture-backed, read-only analysis. Its required completion statement is: `Analysis only.  No transaction was signed or submitted.` Any signing or submission request is policy-denied.
