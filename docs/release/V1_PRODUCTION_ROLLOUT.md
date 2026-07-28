# Mission Agent 0.7.2 Minimum Production Rollout

Status: implementation contract for one owner-controlled canary. It does not
authorize production deployment, migration, credentials, or agent mutation.

## Fixed scope

- Mission Control runs as one ECS service with desired count one.
- The task uses an immutable ECR digest; tags are not authority.
- AWS account, region, cluster, service, deployment, task definition, running
  task, roles, ECR repository/digest, configuration digest, source commit, and
  embedded build identity must agree with independently queried ECS/ECR state.
  Owner-side deployment-attestation tooling runs outside the task, queries AWS control-plane
  APIs, and produces a canonical short-lived KMS-signed deployment identity
  using a separate purpose-bound deployment-attestation key.
  The task verifies that artifact with its embedded pinned public key; it
  cannot authorize itself with a boolean or environment value.
- Exactly one named owner-controlled macOS agent and the frozen Mission Agent
  0.7.2 artifact SHA-256
  `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`
  are eligible.
- The same-user operator has a fixed checksum, path, ownership, mode,
  credential, launch configuration, operation vocabulary, path allowlist, and
  durable journal. It never accepts a shell command or arbitrary path.
- Forward authority is one-use and expires. The first accepted mutation intent
  atomically creates a non-expiring, exact inverse rollback obligation.
- Routes are disabled by default. Runtime identity, configuration, credential,
  authorization, claim, fencing, nonce, sequence, artifact, or evidence
  contradictions fail closed.

## Required before first production use

1. V1 documentation and reviews accepted.
2. Additive migration 0030 passes empty and 0028/0029 upgrade rehearsals but is
   not applied to production.
3. Clean trusted build embeds provenance and produces an immutable ECR digest.
4. Staging ECS identity verifier proves one expected task and rejects every
   contradiction.
5. Fixed-purpose operator passes crash, receipt-loss and rollback tests in a
   disposable same-user macOS environment.
6. Authorization/rollback and six-handler matrices pass using real HTTPS,
   PostgreSQL and provider paths.
7. Successful and forced-rollback staging lifecycles pass.
8. EC2 rollback path, migration, ECS, operator and canary runbooks are
   independently reviewed.
9. A new human authorization permits only non-mutating ECS deployment and
   read-only production identity/database preflight.

Production then stops at three distinct evidence-bound human gates:

1. **Preflight-only:** deploy the non-mutating ECS runtime and collect
   read-only identity/database evidence.
2. **Migration-only:** after reviewing live migration history, backup,
   migration bytes and ECS identity, authorize only 0029/0030. It issues no
   operator credential or canary claim.
3. **Canary mutation:** after migration verification, freeze deployment,
   configuration, named agent, rollback inventory, operator checksum, artifact,
   immutable claim generation, fencing-epoch namespace and initial epoch, and
   authorization fingerprint; the owner approves their canonical action hash
   before any credential, claim or package is issued.

No earlier approval prospectively authorizes a later gate.

## Production rollout states

`disabled → read_only_preflight → migration_ready → canary_authorized →
forward_active → observing → success_verified`

After a mutation, any failure, expiry, or contradiction enters
`recovery_only → rollback_verified` or
`human_intervention_required`. Forward expiry never closes rollback.

## Evidence

V1 retains canonical PostgreSQL events/receipts, CloudWatch logs, operator
journal digests, and checksum-bound local or S3 release evidence. Evidence
contains identifiers and digests, never secrets or private paths.

## Local Phase E acceptance boundary

The local production-mode acceptance uses the standalone production Next.js
bundle over HTTPS, all six authenticated external handlers, PostgreSQL
migrations through 0030, the controller-only database role, fresh operator
subprocesses, a disk-backed disposable provider, host-signed receipts and
rollback observations, canonical heartbeats/projections, and verified terminal
success or rollback. It forces process termination both after provider success
before receipt persistence and after receipt persistence before control-plane
delivery. Recovery reloads the provider and authenticated journal from disk and
must not execute the provider mutation twice.

This proves the application protocol and local recovery model. It does **not**
prove an ECR image digest, ECS control-plane identity, a physical same-user
macOS LaunchAgent, production database connectivity, or the real canary. Those
remain external staging prerequisites and require separate authorization.

## Explicit exclusions

No fleet rollout, other agent, customer device, generic administration,
automatic remediation, arbitrary execution, root helper, sudo, cross-user
access, Apple notarization, generalized attestation service, Object Lock,
seven-year retention, multi-task controller election, or production action is
included.
