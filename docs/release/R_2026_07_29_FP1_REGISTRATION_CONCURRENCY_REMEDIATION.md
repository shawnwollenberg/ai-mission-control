# R_2026_07_29_FP1_REGISTRATION_CONCURRENCY_REMEDIATION

**Status:** Human-approved for the exact reviewed release; deployment pending

**Date:** 2026-07-29

**Merged release under remediation:**
`57e4757265a86ea4ab3dc9f940663ca92107342a`

**Current production application:** rolled back and healthy at
`e70c86e4a7ed6326616c8fbdb47d4b9542539e41`

**Classification:** Security-sensitive application remediation. Repository
registration, workspace isolation, signed protocol receipts, agent aggregate
concurrency, and resource grants are authorization-sensitive. This release
does not change authentication, signing authority, command execution authority,
or infrastructure.

**Authorization:** On 2026-07-29, the human release authority approved the
exact four-file reviewed remediation, unchanged Mission Agent 0.7.2 checksum,
green validation evidence, and production base
`57e4757265a86ea4ab3dc9f940663ca92107342a`. The approval authorizes commit,
push, governed pull request and merge, application deployment, and documented
post-deployment verification. It does not authorize scope expansion, Mission
Agent publication or signing, migration application, or unrelated production
mutation. Approval is invalid if the reviewed diff, production base, or
required validation changes before deployment.

## Production failure and corrected diagnosis

Production acceptance launched two independent Mission Agent CLI processes from
separate protected local homes. Both used the same authenticated agent identity
and registered the same canonical repository. One CLI returned:

`The aggregate changed before this command could be applied`

Retained evidence proves that repository registration itself completed before
that error:

- both local configurations contained the same canonical repository ID;
- the repository, stable identity, active grant, canonical event, and completed
  registration command were durable; and
- Mission Agent 0.7.2 calls signed `AgentHeartbeat` after persisting the
  repository response.

The escaping conflict came from the post-registration heartbeat. Both clients
read agent aggregate version 5. The winner appended three events and committed
version 8. The loser then acquired the aggregate-head row lock, compared its
stale expected version 5 with actual version 8, and returned HTTP 409. Mission
Agent had already stored the repository response, explaining why the failed
client contained the repository ID.

Investigation also found a separate registration response-path defect at higher
fan-in. Registration retried only four times and did not reload the complete
requested state after a conflict. Ten synchronized protocol callers therefore
produced four HTTP 201 responses and six HTTP 409 responses in the baseline
reproduction; the recorded losing comparison was expected version 3 versus
actual version 4.

The required two-distinct-agent scenario passed 100/100 even on the baseline.
The earlier direct two-agent integration test therefore did not expose either:

1. more than four callers contending on one repository aggregate; or
2. the signed heartbeat that follows a successful CLI registration.

The authoritative remediation covers both defects without changing Mission
Agent bytes.

## Authoritative transaction and locking contract

Stable repository IDs are deterministically derived from workspace ID and the
server-derived stable-v2 fingerprint. No registration advisory lock exists.
Every append uses the production PostgreSQL event-store path:

1. insert a unique command row in `processing` state;
2. create the aggregate head if absent;
3. lock that workspace/repository head using `SELECT ... FOR UPDATE`;
4. compare the supplied expected version with the locked head;
5. append consecutive aggregate-versioned events;
6. project repository, stable identity, agent association, and read grant in
   the same transaction;
7. update the aggregate head and mark the command completed with its exact
   result event IDs; and
8. commit.

PostgreSQL uniqueness protects the active repository fingerprint, repository
identity, agent-resource grant, event aggregate version, and command identity.
Serialization, deadlock, uniqueness, and expected-version failures remain
explicit `ConcurrencyConflictError` outcomes. Optimistic concurrency is not
removed or weakened.

Signed protocol authentication independently binds method, path, timestamp,
nonce, message ID, protocol version, agent credential, body checksum, and
workspace. The route reserves a protocol receipt before registration and marks
it completed only after the authorized response is available.

## Remediation and bounded convergence contract

Repository registration permits at most 16 attempts. On an aggregate conflict,
it reloads authoritative state and returns success only if all of these facts
already exist:

- the exact workspace and deterministic repository ID;
- active stable-v2 identity and fingerprint;
- the server-derived credential-free canonical remote and selected remote;
- the requested sanitized name, default branch, and observed commit;
- an active association for the requesting agent;
- an unrevoked read grant;
- a canonical registration or association-refresh event for that agent,
  repository, fingerprint, and canonical remote; and
- a completed command whose result-event IDs include that event.

An exact already-converged request returns the canonical repository directly.
An incomplete new-agent association retries against the current aggregate
version. A different remote, identity, workspace, repository state, grant,
commit, or evidence set cannot be treated as success. Non-concurrency errors,
injected projection failures, authorization failures, and exhausted retries
remain failures.

The registration code performs a second convergence check after loading the
event stream. This closes the window where the initial repository query saw no
row but another transaction committed before the event load. A new agent in
that window emits `repository.registration_refreshed`, never a second
`repository.registered` event.

Signed heartbeat and capability appends receive the same 16-attempt bound, but
only for `ConcurrencyConflictError`. Each retry reloads the current agent
aggregate version and reuses the same deterministic command ID. Validation,
signature, compatibility, workspace, capability, credential, and policy errors
remain fail-closed.

## Event, receipt, and audit semantics

- The first successful stable identity creates one
  `repository.registered` event.
- Each newly authorized agent association creates one
  `repository.registration_refreshed` event and one merged read grant.
- An exact same-agent duplicate creates no misleading duplicate repository
  lifecycle event. Its distinct signed protocol message receives its own
  completed `agent_protocol_receipts` acknowledgement referencing the same
  canonical repository response.
- A changed observed commit is not an exact duplicate and creates a refresh
  event through the existing governed path.
- Ten same-agent concurrent calls produced one association event and ten
  completed protocol receipts.
- Heartbeats remain separately auditable agent facts. Concurrent heartbeats
  append causally ordered aggregate events and receive separate completed
  protocol receipts.
- Failed validation and cross-workspace attempts retain bounded security audit
  evidence without storing request secrets.

## Reviewed scope

Implementation:

- `app/api/agent-protocol/v1/messages/route.ts`
- `application/registry.ts`

Tests:

- `tests/repository-management-forward-port.integration.test.mjs`

Evidence:

- `docs/release/R_2026_07_29_FP1_REGISTRATION_CONCURRENCY_REMEDIATION.md`

There is no migration, package, dependency, UI, recommendation-policy,
execution-policy, Project Brain, release-authority, KMS configuration, or
Mission Agent artifact change.

## Security and failure analysis

Workspace identity always comes from the verified agent credential. The
convergence query includes workspace, agent, repository, identity, grant,
event, and completed-command predicates. A signed body that substitutes a
different workspace is rejected before registration.

Credential-bearing and malformed remotes remain rejected before persistence.
A signed credential-bearing protocol request was scanned across repository,
identity, grant, event, command, protocol receipt, security-audit, agent, and
credential records; the marker appeared zero times. Captured warning output and
the public error response also contained no marker.

Projection failure remains atomic. Injected failures after repository,
identity, and grant transitions leave no repository, identity, grant, event, or
command. In a concurrent winner/failure case, the failed caller retained no
grant and the successful caller retained one complete repository, identity,
grant, event, and command.

The generic event store still rejects stale versions and simultaneous
non-idempotent mutations. This remediation does not convert arbitrary
concurrency conflicts into success.

## Acceptance criteria and validation

Required behavioral evidence:

- two authorized agent identities, same workspace, same canonical repository:
  100/100 synchronized production-route iterations returned HTTP 201 and the
  same repository ID;
- ten distinct agents: all ten returned HTTP 201, with one repository, one
  stable identity, ten grants, and ten causally ordered repository events;
- ten calls from one agent: all returned HTTP 201 and the same repository ID,
  with one association event and ten completed receipts;
- two independent clients sharing one authenticated agent completed
  registration followed by concurrent signed heartbeats with HTTP 201/202 and
  no escaping aggregate conflict;
- SSH and HTTPS normalization variants converged;
- cross-workspace protocol identity substitution returned validation failure;
- duplicate registration preserved existing write permission and the
  repository Project Brain flag while adding the second read grant;
- failure injection, stale-version event-store behavior, duplicate command,
  projector rollback, replay, and projection reconstruction passed; and
- no migration was introduced.

Runtime and gate results:

- Node: `v22.20.0`
- npm: `10.9.3`
- clean install: `npm ci`, including the repository Node runtime guard, exit 0
- focused repository/protocol test: 14/14, exit 0
- production-route two-agent stress: 100/100, exit 0
- same-agent outer repetition: 10/10, exit 0
- focused policy, KMS, and artifact tests: 34/34, exit 0
- focused event-store, Mission Agent pull, and repository tests: 27/27 after
  the final secret-scan addition, exit 0
- complete unit suite: 164/164, exit 0
- complete integration suite: 73/73 after the final secret-scan addition,
  exit 0
- complete E2E suite: 2/2, exit 0
- real-Codex production-representative E2E: 2/2, exit 0; the repository mission
  completed in 146.1 seconds on the final reviewed diff
- production build: exit 0
- typecheck: exit 0
- migration status: zero pending through `0028`, exit 0
- production dependency audit: zero vulnerabilities, exit 0
- full lint: exit 0, zero warnings
- full formatting check: exit 0
- typecheck: exit 0
- signed Manifest v3 verification: exit 0; version, checksum, source commit,
  signer key, and exact latest-manifest bytes matched
- `git diff --check`: exit 0
- final reviewed diff boundary: two application files, one integration test
  file, and this release record only
- production remained rolled back: external health returned `ok`, readiness
  returned `ready`, PostgreSQL was reachable, no readiness checks failed, and
  `secretsPrinted` remained false

## Previously skipped acceptance checks

- Arbitrary inline `node -e` recommendation: rejected; allowlist unchanged.
- Unsupported older agent: rejected before mission or execution creation.
- Production and CI KMS signing without explicit authority: rejected.
- Test-only signer outside `NODE_ENV=test`: unavailable and rejected.
- Secret scan: passed across UI-safe response/log capture and durable
  repository, identity, grant, command, event, receipt, audit, agent, and
  credential records.
- Preservation: repository Project Brain enablement and existing write grant
  survived duplicate association; full unit/integration/E2E replay and
  migration tests preserved repositories, identities, grants, events,
  missions, receipts, audit behavior, and Project Brain state.

## Artifact and dependency impact

Mission Agent 0.7.2 remains unpublished and unchanged:

- filename: `public/mission-agent-0.7.2.mjs`
- byte size: 148,063
- SHA-256:
  `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`
- signature, Manifest v3, trust root, identity protocol v2, and updater
  behavior: unchanged

Project Brain source, image, capabilities, projections, and state are
unchanged. Production dependency audit reports zero findings. The full
development audit retains the previously reviewed development-tool findings
and this release changes no dependency.

## Rollout, rollback, and post-deployment acceptance

After human approval bound to an exact reviewed commit and successful
authoritative CI:

1. Confirm production remains healthy on
   `e70c86e4a7ed6326616c8fbdb47d4b9542539e41`.
2. Confirm this four-file scope, zero migrations, exact 0.7.2 bytes/signature,
   and unchanged Project Brain/release-authority boundaries.
3. Build one immutable application image from the approved commit.
4. Deploy web and generic worker only through the reviewed application
   procedure. Do not publish Mission Agent or apply a migration.
5. Verify health/readiness, image identity, and zero pending migrations.
6. In a disposable authenticated workspace, run two separate 0.7.2 clients,
   two separate authorized agent identities, same-agent duplicates, ten-way
   registration, canonical normalization, cross-workspace rejection, malformed
   and credential-bearing rejection, real-Codex mission completion, signed
   heartbeat, inline-command rejection, unsupported-agent rejection, KMS
   fail-closed behavior, secret scan, and preservation comparison.

If any required check fails, restore application revision
`e70c86e4a7ed6326616c8fbdb47d4b9542539e41`. Do not reverse schema, delete
repositories, identities, grants, events, commands, missions, receipts, audits,
artifacts, or Project Brain records. Preserve additive failure and audit
evidence.

## Residual risks and approval

The 16-attempt bound supports the reviewed ten-caller contract while remaining
finite. Workloads above that bound may still receive an explicit concurrency
conflict and require a later request. No claim is made that arbitrary fan-in is
wait-free.

Heartbeat retries preserve every distinct signed heartbeat as a canonical
event. A later optimization could coalesce operationally redundant heartbeats,
but that is outside this release and must not weaken auditability or agent
freshness.

**Human approval: granted on 2026-07-29 for this exact reviewed release.**
