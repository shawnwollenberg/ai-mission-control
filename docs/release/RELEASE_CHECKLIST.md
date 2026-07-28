# Mission Agent Release Checklist

Use this checklist for each Mission Agent production release. For architecture,
failure handling, rotation, and recovery details, see
[`RELEASE_AUTHORITY.md`](./RELEASE_AUTHORITY.md).

## 1. Prepare the candidate

- [ ] Confirm the release version, source commit, target branch, and authorization scope.
- [ ] Start from a clean worktree and the approved immutable source commit.
- [ ] Build twice in clean Node 22 environments.
- [ ] Confirm both artifacts are byte-identical.
- [ ] Record the artifact path, byte length, SHA-256, source commit, and build provenance.
- [ ] Confirm prior release artifacts and manifests remain unchanged.

**Stop if:** the builds differ, the worktree is dirty, or any approved identity
value changed.

## 2. Review the manifest

- [ ] Generate strict canonical Manifest v3 bytes with no trailing newline.
- [ ] Confirm Release Authority `v2` and canonicalization `release-manifest-json-v3`.
- [ ] Verify artifact name, byte length, SHA-256, source commit, version, platform, compatibility, and protocol fields.
- [ ] Record the canonical manifest byte length and SHA-256.
- [ ] Run schema, canonicalization, downgrade, mutation, and updater tests.
- [ ] Complete independent review with no unresolved critical, high, or acceptance-blocking medium findings.

**Stop if:** reconstructing the manifest does not produce the exact reviewed
bytes.

## 3. Authorize and sign

- [ ] Obtain explicit authorization to activate trust, if required.
- [ ] Obtain separate explicit authorization to sign the exact reviewed manifest.
- [ ] Confirm the repository key record is active and matches the embedded Mission Agent trust record.
- [ ] Authenticate only with the production signer Identity Center profile.
- [ ] Verify temporary credentials, account, Region, signer role, key ARN, key state, public fingerprint, and key-policy checksum.
- [ ] Confirm the signer cannot administer KMS and the administrator cannot sign.
- [ ] Recalculate the artifact and canonical manifest identities immediately before signing.
- [ ] Call KMS `Sign` exactly once with `ED25519_SHA_512`, `RAW`, and the exact canonical bytes.
- [ ] Record the Sign request ID, timestamp, signer ARN, and signature SHA-256.

**Stop if:** identity, policy, trust, artifact, or canonical bytes differ. A
signing authorization is not publication authorization.

## 4. Verify and audit

- [ ] Verify through AWS KMS.
- [ ] Verify independently with local Ed25519.
- [ ] Verify through Mission Control Release Authority.
- [ ] Verify through Mission Control production selection.
- [ ] Verify through the Mission Agent verifier and default embedded-trust updater.
- [ ] Confirm artifact checksum and length before activation eligibility.
- [ ] Use the separate read-only auditor profile to correlate the exact CloudTrail Sign and Verify request IDs.
- [ ] Confirm the approved key, signer, Region, algorithm, and ceremony time.
- [ ] Confirm there was no unexpected Sign event in the ceremony window.
- [ ] Run JSON validation, secret scanning, evidence consistency checks, historical checksum checks, and `git diff --check`.
- [ ] Commit the signed candidate and completed non-secret evidence locally.

**Stop if:** any verification path disagrees or CloudTrail correlation is
incomplete.

## 5. Publish

- [ ] Obtain separate authorization to publish the exact reviewed artifact, manifest, signature, and checksums.
- [ ] Reconfirm the local evidence commit and clean worktree.
- [ ] Publish exact immutable bytes without rebuilding or force-updating history.
- [ ] Verify the remote artifact, manifest, signature, checksums, and onboarding metadata.
- [ ] Record publication evidence.

**Stop if:** remote bytes differ or publication requires an unreviewed change.
Publication does not authorize installation or deployment.

## 6. Canary

- [ ] Obtain separate authorization naming one controlled canary Mission Agent and repository.
- [ ] Confirm rollback artifact, agent identity, credentials, repository mappings, and signing keys are preserved.
- [ ] Upgrade only the named canary.
- [ ] Verify heartbeat, signed capabilities, artifact checksum, freshness, repository identity, and Project Brain compatibility.
- [ ] Deploy only separately authorized immutable Mission Control images, if required.
- [ ] Run one governed remote Project Brain lifecycle with exact context-checksum continuity.
- [ ] Verify closure, learning evaluation, zero automatic promotion, canonical events, and projection replay.

**Stop and roll back if:** health, governance, checksum continuity, worker
leasing, S3 verification, or projections fail.

## 7. Observe and roll out

- [ ] Observe the canary for the approved period.
- [ ] Check heartbeats, capability freshness, leases, outbox backlog, receipts, checksums, projections, errors, restarts, and resource pressure.
- [ ] Record the canary disposition and rollback readiness.
- [ ] Obtain explicit authorization for a staged fleet rollout.
- [ ] Roll out in approved batches, repeating checksum, heartbeat, capability, repository, and rollback checks for each batch.
- [ ] Close the release record with exact published version, commits, checksums, evidence, and final disposition.

**Never:** broaden signer permissions, rebuild after signing, reuse a signature
for different bytes, expose credentials, destructively roll back migrations,
or treat signing, publication, canary, deployment, and fleet rollout as one
authorization.

## 8. Legacy replacement trust bootstrap

This procedure is only for agents that cannot verify Manifest v3 and whose
legacy signing authority is unavailable.

- [ ] State explicitly that legacy cryptographic continuity is unavailable.
- [ ] Obtain a durable human authorization binding one agent, host, workspace,
      repository fingerprint, exact source and target bytes, expiry, one use, and
      rollback.
- [ ] Confirm no ordinary updater or Manifest v1 authorization is claimed.
- [ ] Revalidate the granted approval action hash and expiry against the
      authoritative database clock when consuming the one shot.
- [ ] Verify Manifest v3 through Mission Control and standalone Ed25519.
- [ ] Verify signed key ID, signed/recorded/derived fingerprints, signature,
      artifact length/checksum, provenance, platform, compatibility, and expiry.
- [ ] Verify the official Node 22 archive and executable checksums.
- [ ] Pin the LaunchAgent to the absolute isolated Node 22 executable.
- [ ] Inventory non-secret configuration checksums and preserve identity,
      credentials, registrations, logs, 0.6.8 bytes, and service configuration.
- [ ] Drain only the named agent and prove no active mission or lease.
- [ ] Stage and verify all files before the atomic switch.
- [ ] Verify the checksum-bound host phase journal and interruption recovery.
- [ ] Verify restart, original identity, heartbeats, capabilities, and one
      governed read-only smoke mission.
- [ ] Mark the authorization consumed and keep broader rollout blocked.
- [ ] On any failure, roll back once, verify 0.6.8 and heartbeats, and require
      new authorization before retry.
- [ ] Remove replacement controls after the bounded legacy transition ends.

**Never:** use this bootstrap for a Manifest-v3-capable agent, imply continuity
from the lost key, substitute a trust root, use an ambiguous `node` path,
automatically retry, or expose the workflow as ordinary fleet discovery.

### Historical operator commands (do not execute)

These commands are preserved only as a design record. The repaired CLI refuses
the production-bound provider from disposable mode, and no production
replacement command is authorized.

Dry-run preflight:

```text
npm run replacement-bootstrap -- --mode dry-run --authorization-id <uuid> --agent-id 0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8 --evidence-output <governed-path>
```

Disposable simulation:

```text
npm run replacement-bootstrap -- --mode disposable --authorization-id 11111111-1111-4111-8111-111111111111 --agent-id 0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8 --acknowledge operator-replacement-bootstrap-v1 --evidence-output /tmp/replacement-bootstrap-disposable.json
```

Production execution, only under a new commit-bound authorization:

```text
npm run replacement-bootstrap -- --mode production --authorization-id <uuid> --agent-id 0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8 --acknowledge operator-replacement-bootstrap-v1 --evidence-output <governed-path>
```

Evidence validation:

```text
jq empty <evidence.json> && shasum -a 256 <evidence.json>
```

Failure and rollback status inspection:

```text
jq '{disposition,transitions,hostReceipts,finalSnapshot}' <evidence.json>
```

### Local canary prerequisite commands

Inspect and validate an immutable package without mutation:

```text
npm run replacement-bootstrap:local -- --authorization-package <immutable-package.json> --dry-run
```

Validate the package file checksum independently:

```text
shasum -a 256 <immutable-package.json>
```

Mutation remains unavailable in production. For a separately authorized
disposable acceptance environment, verify the exact gate and resource
fingerprint before local execution:

```text
test "$MISSION_CONTROL_ENVIRONMENT" = disposable-test
test "$MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION" = explicitly-authorized-non-production-only
npm run replacement-bootstrap:local -- --authorization-package <immutable-package.json>
```

The command has no release, Node, plist, trust, identity, repository, rollback,
or smoke overrides. Stop if any undocumented option appears.

Inspect the authenticated host journal:

```text
npm run replacement-bootstrap:local -- --authorization-package <immutable-package.json> --inspect-journal
```

Validate local evidence and receipts:

```text
jq empty <governed-evidence-directory>/replacement-local-evidence.json
shasum -a 256 <governed-evidence-directory>/replacement-local-evidence.json
```

Inspect recovery and rollback state:

```text
jq '{phase,lastCompletedOperation,nextPermittedOperation,receiptSequence}' <governed-evidence-directory>/replacement-host-journal.json
```

Receipt submission is automatic through the package-bound HTTPS receipt path.
Never copy credentials into a curl command or manually synthesize receipts.

Before each disposable execution boundary:

- [ ] Confirm the claim owner matches authorization, execution, fingerprint,
      credential, agent, operator, provider, generation, and next sequence.
- [ ] Confirm the credential scope names no other authorization, agent,
      provider, target, runtime, operation, or execution.
- [ ] Confirm the exact mutation intent is committed before any host mutation.
- [ ] Inspect the authenticated journal and authoritative ledger together.
- [ ] Require the checksum-bound two-snapshot Mission Control drain receipt.
- [ ] Require repeated real PID/process receipts after start.
- [ ] Require three post-start heartbeats with exact 0.7.2 capabilities.
- [ ] Require matching repository identity and projection replay checksums.
- [ ] Require the deterministic governed smoke mission and acceptance receipt.
- [ ] On rollback, compare against the exact 0.6.8 inventory and require prior
      process, heartbeat, capability, identity, and projection equivalence.
- [ ] Confirm authorization, execution, and credential are terminal and cannot
      be reused.

Before accepting the isolated replacement-bootstrap repair:

- [ ] Run `npm run test:replacement:http-e2e`.
- [ ] Confirm all ten forward, rollback, and receipt-loss scenarios pass.
- [ ] Confirm every stateful provider mutation count is exactly zero or one.
- [ ] Run the authenticated PostgreSQL negative and replay matrix.
- [ ] Rehearse both empty database through 0029 and 0028 to 0029.
- [ ] Run `npm run test:replacement:migration` and confirm representative
      0028 row hashes remain identical after 0029 and a second migration run.
- [ ] Compare all full-suite failures with untouched base commit
      `9abc71da235f63c6ce2e4b0197ecfdd53d3015ed`.
- [ ] Verify the canonical smoke-template and rollback-inventory checksums
      instead of applying Prettier to those two files.
- [ ] Obtain independent security, recovery, migration, rollback, and evidence
      reviews with no unresolved critical or high finding.
- [ ] Confirm the signed 0.7.2 artifact remains
      `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`.
- [ ] Confirm no production or named-canary endpoint was contacted.

Before accepting local V1 Phase E:

- [ ] Run `npm run test:v1:migration` and verify empty 0001–0030 plus
      0028–0030 rehearsals.
- [ ] Run `npm run test:v1:https` through the built standalone server and real
      six-route contracts.
- [ ] Verify the controller database credential is present only in the web
      container definition, never generic or Project Brain workers.
- [ ] Verify an old-fence durable receipt retains its original execution fence
      after recovery-controller adoption.
- [ ] Verify revocation cannot discard an operator-confirmed in-flight
      mutation.
- [ ] Verify fresh operator subprocess recovery at provider-success/pre-receipt
      and post-receipt/pre-control-plane boundaries.
- [ ] Verify rollback closure uses fresh host-signed process observations and
      post-rollback heartbeats/projection replay, with no database-synthesized
      host evidence.
- [ ] Verify the six-handler rejection artifact records every case and equal
      before/after operational snapshot checksums.
- [ ] Obtain independent lifecycle, database-boundary, recovery, host identity,
      grant, rejection, and HTTPS-realism reviews with no unresolved critical,
      high, or V1-blocking finding.
- [ ] Stop before ECS or physical macOS staging. Request authorization only for
      non-mutating ECS staging and read-only identity/database preflight.

Recovery inspection must show the committed intent and observed host state:

```text
npm run replacement-bootstrap:local -- \
  --authorization-package <immutable-package.json> \
  --inspect-journal
```

Never retry a non-retry-safe mutation after an interrupted precondition.
When the verified postcondition already exists, submit the authenticated
recovery receipt without running the mutation again. Partial or ambiguous
state requires halt or governed rollback.

Before authorizing production, verify exact fixture assets:

```text
shasum -a 256 release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist
shasum -a 256 release/mission-agent-0.7.2/replacement-bootstrap/migration-history.json
shasum -a 256 release/mission-agent-0.7.2/replacement-bootstrap/node-runtime.json
shasum -a 256 release/mission-agent-0.7.2/replacement-bootstrap/postgresql-tools.json
plutil -lint release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist
```
