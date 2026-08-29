# Mission Control 2.0 — Local Subscription Worker

## Decision and boundary

The initial dogfood provider topology is `LOCAL_SUBSCRIPTION_WORKER`. Mission Control's hosted web application is the
control plane. One owner-operated Mac polls it over outbound HTTPS and runs the Codex SDK Architect and Engineer using
the owner's local ChatGPT subscription sign-in. OpenAI API billing, Responses, inbound Mac connectivity, tunnels, and
ChatGPT credential transfer are excluded.

Official OpenAI documentation says Codex supports ChatGPT sign-in for subscription access and that the desktop app,
CLI, and IDE extension support it for local work: <https://learn.chatgpt.com/docs/auth>.

## Responsibilities and persistence

The hosted control plane reconciles GitHub, chooses the next actor, creates exact revision-bound dispatches, validates
results, records CTO decisions, commits accepted envelopes to GitHub, and projects worker health. PostgreSQL stores the
minimal dispatch audit and worker presence. It does not store Codex transcripts or provider credentials.

The local worker validates each configured checkout's `origin`, invokes only the selected adapter, and stores minimal
thread IDs plus a validated unuploaded result in a mode-0600 JSON file. GitHub remains durable Mission truth. Local
thread IDs are context optimizations; if a read-only Architect thread is lost it may be replaced, while an
indeterminate mutating turn fails closed.

## Protocol

- `POST /api/v2/worker/dispatches/claim` authenticates the worker, updates bounded health, synchronizes eligible
  GitHub Missions, and atomically claims one dispatch.
- `POST /api/v2/worker/dispatches/result` validates dispatch ID, idempotency key, project, Mission, revision, actor,
  schema, and provider thread before committing the result.
- `POST /api/v2/worker/health` reports only availability, current dispatch, and bounded provider state.

Dispatches contain one Mission packet, constitution, latest relevant signal, expected actor/adapter, source digest,
and idempotency key. They never contain the database, full issue history, local credentials, or Codex transcripts.

## Worker authentication

The worker uses one high-entropy bearer token dedicated to V2 coordination. The host stores only its SHA-256 digest in
`MISSION_CONTROL_V2_WORKER_TOKEN_SHA256`; the plaintext exists only in the local worker environment. Rotation is:

1. Stop the local worker.
2. Owner generates a new random secret locally and computes its SHA-256 digest.
3. Update the hosted digest through the existing secret/configuration release path.
4. Update the local plaintext secret, restart, and remove the prior values.

Provisioning the production value is intentionally not performed by this preparation mission. Removing the hosted
digest revokes all worker access. The token grants only the three V2 coordination endpoints.

## Offline and recovery behavior

Presence older than 30 seconds projects as `OFFLINE`. Eligible Missions remain in their GitHub state and dashboard
cards say the Architect or Engineer is queued. This never creates a CTO request. A claim abandoned for 45 seconds is
eligible for the same personal worker again. A locally persisted result uploads without another provider turn. An
unknown provider outcome is not retried automatically. A second live session for the same identity is rejected and
shown as an operational fault.

The CTO Inbox is independent of worker health. Approve, Reject, or Discuss writes the decision to GitHub immediately;
any provider work it enables waits in the queue while the Mac is offline.

## Local operations

Prerequisites: Node 22, this checkout, existing `codex login` subscription authentication, the V2 config file, the
hosted HTTPS endpoint, and the owner-provisioned worker token.

```sh
export MISSION_CONTROL_V2_CONFIG=/absolute/path/to/mission-control-v2.json
export MISSION_CONTROL_V2_ENDPOINT=https://mission-control.example
export MISSION_CONTROL_V2_WORKER_TOKEN='owner-provisioned-secret'
npm ci
npm run worker:v2:setup
npm run worker:v2:start
npm run worker:v2:status
```

Operations:

```sh
npm run worker:v2:stop
npm run worker:v2:reconnect
git pull --ff-only
npm ci
npm run worker:v2:reconnect
```

These commands run a reversible user process and do not install a LaunchAgent. Logs and PID state remain under
`.mission-control-v2-runtime/`, which must not be committed.

## Threat model

| Threat                     | Proportional mitigation                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Stolen worker token        | Dedicated least-authority token, hosted hash only, rotation/revocation                       |
| Replay or duplicate result | Unique idempotency key, immutable dispatch binding, result hash, idempotent GitHub append    |
| Forged/stale result        | Exact Mission digest/revision/actor/schema checks before authority transition                |
| Duplicate worker           | Local exclusive lock plus server rejection of a second recent session                        |
| Control-plane compromise   | No Codex or repository credential in AWS; local checkout and adapter constraints still apply |
| Local compromise           | Limited to owner checkouts and token scope; no production authority is implied               |
| Checkout mismatch          | Exact normalized GitHub `origin` check before every provider dispatch                        |
| Malicious issue content    | Bounded structured packet, deterministic schema/authority validation, sandboxed role prompts |
| Role confusion             | Separate threads and sandboxes; dispatch and result are actor-bound                          |

Residual risk: a stolen worker token can claim work or submit a structurally valid forged result. For a trusted
single-owner dogfood system, exact binding, GitHub authorization, audit, rapid revocation, and no provider credentials
in the control plane are accepted controls. This is not a multi-tenant worker protocol.

## Controlled deployment plan (not executed)

Hosted:

1. Review and explicitly approve the exact release commit and this plan.
2. Back up PostgreSQL and record application rollback revision.
3. Configure the existing V2 project registry and `MISSION_CONTROL_V2_WORKER_TOKEN_SHA256` via the existing secret
   path; do not add an OpenAI key.
4. Apply migration `0032_v2_local_worker.sql` with the governed production migration command.
5. Deploy the existing application image with `/v2` and worker endpoints enabled.
6. Verify V1 routes first, then authenticated `/v2`, worker unauthorized rejection, and offline presentation.
7. Provision the matching local plaintext token under owner authority, run setup, and start the worker.
8. Admit one reversible dogfood Mission, then expand to the three configured projects after evidence review.

Local configuration is prepared for Mission Control, Agent Payment Risk Check, and Meal Planning in
`config/mission-control-v2.example.json`. Tracked issue lists remain empty until the owner deliberately admits a
Mission.

## Rollback

Stop the local worker, remove/revoke the hosted worker-token digest, and roll the web application back to the recorded
V1-compatible revision. Leave migration 0032 and its audit rows in place; no database downgrade is needed. GitHub
Missions remain intact and can be reconstructed. V1 remains available throughout.

Expected incremental infrastructure cost is approximately $0: the design uses the existing web application,
PostgreSQL, GitHub access, owner Mac, and ChatGPT/Codex subscription.

## Acceptance evidence — 2026-08-29

- Local Codex reports `Logged in using ChatGPT`; no API key or Responses adapter was used.
- The immediately preceding real-provider acceptance remains the provider baseline: GitHub Mission
  [agent_payment_risk_check#3](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/3) completed at
  revision 9 through Engineer, independent Architect, remediation, simulated CTO approval, the same resumed Engineer,
  and final Architect approval. Concurrent real Missions
  [#8](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/8) and
  [#9](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/9) completed with six distinct provider
  thread IDs and no cross-Mission binding.
- The new worker boundary passes deterministic crash/replay, duplicate upload, stale/role-confused result,
  duplicate-session, three-project queue isolation, offline projection, reconnect, and PostgreSQL atomic claim/audit
  tests. The local migration applied cleanly and the production build emits all three worker endpoints.
- `worker:v2:setup` verified all three configured checkout origins and the subscription login. No persistent service,
  production credential, production migration, or production deployment was created.

This evidence composes the real provider/GitHub loop with the new transport and recovery boundary. It does not claim a
production run. The first controlled deployment must still admit one Mission before expanding the dogfood queue.
