# AWS KMS Release Authority v2

## Decision and boundaries

AWS KMS replaces only private-key custody and Ed25519 signing. Manifest v2,
canonical JSON, Release Authority key IDs and statuses, public verification,
stable-v2 repository identity, Project Brain behavior, trust activation,
publication, and deployment gates are unchanged.

The release key is `ECC_NIST_EDWARDS25519`, `SIGN_VERIFY`, using
`ED25519_SHA_512` and `MessageType=RAW`. The fingerprint is
`ed25519-spki-sha256:<sha256(GetPublicKey DER SPKI)>`. The private key is
non-exportable and has no environment-variable override.

## Responsibility separation

- Builder: builds and tests artifacts and unsigned manifests. No `kms:Sign`,
  trust activation, or publication permission.
- Release signer: inspects frozen identity, assumes a human-only signer role,
  signs with one exact key, and creates evidence. No source, policy, trust,
  deployment, or publication changes.
- Approver/publisher: reviews evidence and separately authorizes trust and
  publication. It does not automatically receive `kms:Sign`.

One founder may perform all roles, but each operation remains explicit and
separately logged.

## Human authentication

1. Create an IAM Identity Center permission set dedicated to release signing.
2. Require MFA in the Identity Center authentication policy.
3. Enroll Shawn's FIDO2 Security Key NFC. It authenticates the human; it does
   not sign release artifacts.
4. Enroll a separate hardware key or independently governed backup MFA method.
5. Protect the AWS root identity with multiple separately stored MFA factors.
6. Use `aws sso login` and short-lived credentials. Never create long-lived
   access keys for release signing.

The trust-policy template requires the exact generated Identity Center
permission-set role ARN, not a name prefix or wildcard. Identity Center enforces MFA because
`aws:MultiFactorAuthPresent` is not a substitute on federated role sessions.

## Pending public key

After separately authorized key creation:

```sh
npm run mission-agent:release:kms-key-record -- \
  --kms-key-arn '<exact-key-arn>' \
  --release-authority-key-id mission-agent-release-2026-01 \
  --output /approved/release-key-2026-01.pending.json
```

This performs only `DescribeKey` and `GetPublicKey`, derives DER SPKI and the
fingerprint, validates a complete `pending` record, and creates a new file. It
does not activate trust.

## Signing and evidence

Run the command in `RELEASE_AUTHORITY_V2.md`. It requires an interactive TTY
and release-specific confirmation, an exact expected signer role, and separate
evidence that the pending public key was deployed and activated. Output paths
use exclusive creation; the authoritative bundle is written last. It cannot
run in CI or an application production environment.

The receipt contains only public release identity, exact key ARN, fingerprint,
KMS request ID, STS principal ARN, timestamp, signature checksum, approval
reference, and verification results. It excludes credentials and tokens.

CloudTrail should show `Sign`, `DescribeKey`, and `GetPublicKey` associated
with the receipt principal, key ARN, time, algorithm, and request ID. Review
also checks for `PutKeyPolicy`, `CreateGrant`, `DisableKey`,
`ScheduleKeyDeletion`, and denied signing attempts. Logs belong in the approved
immutable organization audit destination; this milestone does not provision it.

## Recovery, rotation, and freeze

- Lost security key: use separately enrolled backup MFA, revoke the lost
  factor, review activity, and enroll a replacement.
- Signer-role loss: recover through the approved account path; never create an
  access key or broaden application roles.
- Policy error: a separately controlled key-administrator role repairs policy.
- Region outage: signing stops. Do not substitute another key or region.
- Suspected misuse: disable the key through the administrator role, remove
  signer access, freeze publication, review CloudTrail, and ship revocation
  through authenticated Mission Control authority.
- Deletion: the signer is denied deletion. Administrators use deletion
  protection, a waiting period, and alerts.
- Rotation: asymmetric KMS keys rotate manually. Create a new KMS key and
  Release Authority ID, introduce it as pending, approve overlap, activate
  separately, and retire the prior key. A manifest cannot self-authorize.

There is no private-key backup because the KMS private key is non-exportable.

## Live conformance gate

Deterministic tests use a local Ed25519-backed KMS protocol double. A real
disposable KMS key test requires explicit AWS resource-creation authorization.
It must prove raw 64-byte signatures, local verification, KMS Verify,
DER-SPKI fingerprint equality, tamper rejection, wrong-key rejection, and key
cleanup evidence. A disposable key never enters the production trust store.
