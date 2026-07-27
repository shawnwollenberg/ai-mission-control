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
