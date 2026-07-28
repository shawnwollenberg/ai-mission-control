# V1 Security Boundaries

## Trust decisions

| Boundary          | V1 authority                                                           | Failure behavior                                   |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Build             | clean Git commit, embedded provenance, lockfile and image digests      | untrusted/local build; production routes disabled  |
| Cloud runtime     | independently queried ECS/ECR control-plane state                      | wrong/stale/multiple task evidence disables routes |
| Configuration     | canonical version/digest bound to expected deployment                  | mismatch disables routes                           |
| Database          | exact TLS endpoint, database name, migration range and v1 identity row | transaction rejected                               |
| Operator          | exact checksum/path/UID/mode/credential/journal identity               | no lease or mutation                               |
| Agent/artifact    | one agent ID and exact 0.7.2 SHA                                       | authorization rejected                             |
| Forward authority | human approval, one-use credential, fingerprint, expiry and fencing    | no new mutation                                    |
| Rollback          | durable exact inverse obligation created with first intent             | recovery-only until verified closure               |

Environment variables and mounted files are corroborating inputs only. ECS/ECR
control-plane evidence and embedded provenance are authoritative for cloud
identity.

The owner-side verifier runs outside ECS and queries account, region, cluster,
service, deployment, task definition, task ARN, ECR repository/digest, roles,
configuration digest and database identity. It signs canonical
`v1-deployment-identity` bytes with a distinct asymmetric KMS key and
`MissionControlDeploymentIdentitySigner` role. The Mission Agent release key
must never sign this message and application/task/CI roles cannot sign.
The artifact binds a one-use nonce, audience, issuance/expiry (maximum 15
minutes), deployment revision and every identifier above. Runtime gates verify
the signature locally against the embedded pinned public key and exact active
trust record. Replay, stale evidence, coordinated image+environment+file
substitution, wrong audience, or any contradiction disables forward routes.
Creating this artifact is a separately authorized preflight action; no
signature is created during build, deploy, or this implementation task.

The deployment-attestation trust record pins its separate key ARN, public-key
fingerprint, canonical domain
`wallyweb/mission-control/v1-deployment-identity`, algorithm, active/revoked
status and validity. The signer accepts only that exact canonical message
schema. Key creation, public trust activation and signer assignment require a
later explicit human authorization; until completed, v1 routes remain
disabled. Rotation supports a reviewed verification-only overlap, and
revocation immediately blocks new forward attestations without erasing an
existing rollback obligation.

## Operator boundary

The operator runs as the Mission Agent owner. It may only observe,
request/observe drain, lease/renew/release, stage/verify the frozen artifact,
stop/install/configure/start the named agent, verify
process/heartbeat/capabilities, and restore/verify the exact prior inventory.
It cannot assert or establish drain. Mission Control fences assignment
eligibility, records two stabilized snapshots, invalidates the drain when
assignment/job/lease/outbox work races either snapshot, and database-gates
forward intent on `drained_verified` evidence. Inputs are typed identifiers,
never commands, paths, shell fragments, generic file writes, or generic
process names.

The executable and launch configuration are mode `0500`/`0600` or stricter,
owned by the expected UID, at fixed allowlisted paths. The journal uses
fsync plus a hash chain and records intent, mutation ID, pre/postcondition and
receipt digest. Secrets remain in the same user's protected credential store
and are never journaled.

The authoritative checksum comes from the reviewed operator release record and
is controller-pinned. Immediately before credential issuance and after every
operator restart, the owner runs a separate fixed verifier, observes the local
hash/path/UID/mode/parent-directory/PID result, and confirms it through the
authenticated owner session. A fresh one-use credential is issued only after
that attended confirmation. Operator self-report is corroborative only.
Auto-update is prohibited.

The per-user LaunchAgent domain and label are fixed, with `RunAtLoad` and
bounded `KeepAlive`. Rollout requires a stable logged-in owner session.
Authorization binds operator version/checksum and journal schema. Update or
uninstall is forbidden while rollback is open, and release evidence preserves
a checksummed compatible recovery binary. After crash, logout, or reboot,
login-time recovery fences the old PID, verifies binary and journal hash chain,
reconciles provider postconditions, acquires a higher generation, and resumes
only after new attended confirmation. Ambiguity stops for physical-owner
recovery.

## Recovery boundary

Rollback authority:

- exists only after the first mutation intent;
- has no time expiry;
- is bound to the same deployment, operator, agent, source/target inventory,
  authorization fingerprint, immutable claim generation, fencing-epoch chain
  and inverse sequence;
- cannot start or continue forward work;
- closes only with canonical success or rollback evidence.

Lost connectivity or receipts trigger observation and reconciliation, not
blind re-execution. Stale fencing always rejects. Contradictory provider/local/
server state halts for owner intervention.

`claimGeneration` never changes. `operatorFencingEpoch` is monotonic within
the action-hash-bound namespace. Restart recovery may advance only by an
authenticated database CAS from the current epoch to exactly its successor for
the same execution and open obligation. The predecessor/successor evidence is
append-only; the new epoch is bound into leases, journal entries, provider
mutation IDs and receipts. Skips, stale epochs, parallel successors, or any
scope change reject. Rollback uses the highest committed epoch in the same
chain, not immutable equality to the initial epoch.

## V1 accepted risks

- Unsigned/unnotarized local operator: acceptable only on the owner's Mac with
  exact checksum, ownership, permissions and fixed path.
- Single ECS task: simpler fencing and lower cost, but a task outage pauses the
  rollout.
- CloudWatch/PostgreSQL/checksum evidence is mutable by privileged account
  administrators; owner-controlled scope makes this tolerable temporarily.
- ECS verification is implemented in Mission Control/deployment-attestation tooling rather
  than a hosted attestation service. The verifier runs owner-side outside the
  task and its KMS-signed short-lived result is independently checked by the
  task.
- A malicious process already executing as the macOS owner can replace the
  unsigned operator or use the owner's exportable credential. V1 does not
  resist full owner-account compromise. Any suspicion of that compromise
  requires abort, credential revocation/reissuance, checksum re-verification,
  and human recovery before rollout resumes.
- Integrity of the Mac and logged-in owner account is a v1 trust root.
  Operation is attended, not autonomous. Suspected compromise requires stop,
  reimage or trusted manual recovery, and recredentialing before reuse.
