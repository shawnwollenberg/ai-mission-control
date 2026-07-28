# V1 Database Migration 0030

Migration `0030_mission_agent_v1_production_rollout.sql` is additive and
depends on the accepted disposable replacement schema in 0029.

It adds only:

- immutable ECS production deployment identity;
- versioned production configuration;
- one named operator/agent identity;
- one rollout operation with claim generation and fencing epoch;
- append-only fencing successor evidence;
- durable rollback obligation;
- unique provider mutation/journal/receipt evidence;
- verifier-only, authenticated source evidence and atomic terminal closure.

Database constraints and triggers enforce single active deployment/operator/
rollout, exact claim/operator/agent binding, exact frozen 0.7.2 artifact,
monotonic fencing references, unique provider mutation/sequence, evidence-bound
terminal states, and delete protection for unresolved rollout/rollback state.
A deferred constraint requires the first rollback-marked mutation intent and
its rollback obligation to commit together.

The selected configuration checksum must equal the checksum independently
attested for the ECS deployment. A differently configured canary cannot start,
even when its configuration row otherwise has a valid version and state.

Migration 0030 creates three `NOLOGIN` capability roles:

- `mission_control_v1_controller` may advance fencing only after presenting the
  exact fresh ECS task identity and deployment-attestation checksum;
- `mission_control_v1_verifier` may record fresh authenticated evidence and
  atomically close a rollout;
- `mission_control_v1_runtime` has no direct evidence or closure mutation
  authority.

Production migration execution therefore requires a migration principal with
`CREATEROLE`, or these exact `NOLOGIN`, non-superuser, non-inheriting,
non-login roles must be provisioned and their attributes verified beforehand.
The production application connection must be a non-owner role. The table owner
is reserved for migrations; it must not be used by the web task or workers.
Verifier functions canonicalize and hash their payloads internally, require a
fresh authenticated provider receipt whose signed operation and result checksum
exactly bind the evidence type and canonical evidence bytes, and commit closure
evidence, rollback obligation discharge, and terminal rollout state in one
transaction. The acceptance uses a real non-owner login that is a member only
of the runtime capability role and proves it cannot write verifier evidence or
closure rows directly.

Fencing advancement is compare-and-set: the controller supplies the expected
current epoch, fresh deployment attestation, unique request message ID, and
unique nonce. A retry or parallel caller holding a stale expected epoch fails
instead of silently advancing again.

Rollback is derived from the completed canonical forward prefix. A staging-only
failure authorizes only staged-artifact removal; progressively later failures
authorize only the exact inverse operations needed to restore the prior
inventory and launch configuration. The derived plan and checksum become
immutable when recovery begins. The full restore sequence is never used as a
generic fallback.

Rehearsals:

- empty database: 0001–0030;
- production boundary: 0028, then exactly 0029 and 0030;
- representative workspace/repository checksum preserved;
- a second migration runner execution applies nothing.

Downgrade is application-only. Migration 0030 is not destructively rolled
back. Older applications must ignore the additive tables. If rollout software
is rolled back while an obligation is open, recovery state remains preserved
until a compatible recovery implementation completes it. Tables, evidence,
obligations and migration history must not be deleted.
