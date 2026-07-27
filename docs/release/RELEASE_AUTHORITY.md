# Release Authority

## 1. Purpose and scope

Release Authority protects the identity and integrity of distributable Mission
Agent artifacts. A valid signature proves that an approved release signer used
the governed AWS KMS key to sign the exact canonical manifest bytes and that the
manifest binds an artifact checksum and source commit. It does not prove that
the artifact is defect-free, approved for publication, deployed, or safe for a
particular environment.

Mission Control and Mission Agent consume manifest v2 and the public trust
records. Private signing material never enters either system. Project Brain
uses the resulting Mission Agent identity and capability evidence but does not
hold release-signing authority.

## 2. Architecture

```text
Human signer with FIDO2 MFA
→ AWS IAM Identity Center
→ Temporary MissionAgentReleaseSigner role
→ AWS KMS Ed25519 key
→ Canonical Release Authority v2 manifest
→ KMS signature and non-secret receipt
→ Mission Control verification
→ Mission Agent verification
→ separately authorized publication and rollout
```

Release Authority v2 uses manifest v2, raw Ed25519 signatures, and explicit key
IDs. Key administration, signing, verification, publication, deployment, and
fleet rollout are separate authorities. A signing authorization is never a
publication authorization.

## 3. Production identities

- `MissionAgentReleaseAdmin` may inspect and govern the KMS key policy and key
  lifecycle. Its identity and key policies deny signing.
- `MissionAgentReleaseSigner` may inspect the exact key and invoke only
  `DescribeKey`, `GetPublicKey`, `Sign`, and `Verify`. Signing is constrained to
  `ED25519_SHA_512`, `RAW`, and the reviewed production-key identity.
- Application, worker, CI, Mission Agent, and deployment roles cannot sign.
- Account root is break-glass recovery authority, not a normal signer.

Use individual Identity Center users with MFA. Never share sessions or create
long-lived IAM-user signing credentials.

## 4. Current production key

- Release key ID: `mission-agent-release-2026-01`
- KMS key ID: `cd9ebd3d-f2c6-44cb-83d6-fd4893008fee`
- ARN: `arn:aws:kms:us-east-1:661452835066:key/cd9ebd3d-f2c6-44cb-83d6-fd4893008fee`
- Region: `us-east-1`
- Spec and usage: `ECC_NIST_EDWARDS25519`, `SIGN_VERIFY`
- Origin and topology: `AWS_KMS`, customer managed, single-region
- Fingerprint: `ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b`
- Rotation: manual and governed
- Repository trust state: `pending`
- 0.7.1 embedded bootstrap state: `active`
- Key-policy checksum: `4e7a8e177eb46c4c173a777e3e150c639b846fc5a0f026196f8a97b15e7d4bb7`

The ARN, public key, fingerprint, algorithms, and public policy evidence are
non-secret. Credentials, session tokens, MFA recovery material, and internal
incident details are not publishable.

## Bootstrap Trust and the First Signed Release

Mission Agent 0.7.0 remains immutable and unsigned at SHA-256
`3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e`.
It contains the intended signing key ID as metadata but not the production
public key in its embedded runtime trust store, so its default updater cannot
authenticate a manifest signed by that key.

Mission Agent 0.7.1 is the bootstrap release. It embeds the approved production
Ed25519 public key as the only active/bootstrap key while retaining the
historical key in retiring state for compatibility. The artifact cannot sign or
activate anything; it only contains public verification material. Repository
trust remains `pending` until the separate
activation-and-signing authorization. At signing time, Mission Control trust
must first become active so both verifiers agree.

This avoids circular trust: the governed source build embeds a previously
validated public key, reproducibility proves the artifact bytes, and a later
human KMS action signs those exact bytes. No artifact supplies or modifies its
own signing authority at runtime. Silent external trust-store replacement is
rejected, and the real updater invokes the default embedded store. The exported
test override requires the explicit `allowTestTrustStoreOverride` flag and is
not a production trust-decision API; production update code never supplies it.

Future releases inherit an already deployed public root and follow the normal
active-key path. Rotation introduces a new public key as pending, distributes
compatible verifier support, activates it separately, and only then signs.
Revocation remains fail-closed. Historical 0.6.8 verification retains its
historical public key; 0.7.0 is never represented as KMS-signed.

Before signing 0.7.1, confirm the exact artifact and manifest checksums,
reproducibility, embedded key/fingerprint, repository activation evidence,
live KMS policy checksum, signer identity, four-path verification plan, and
separate publication hold.

## 5. Normal release procedure

1. Build the artifact deterministically from a recorded source SHA.
2. Build again in an independent clean environment and compare bytes.
3. Record the artifact checksum, byte length, platform, toolchain, and lockfile.
4. Run tests, dependency audit, secret scan, and independent security review.
5. Construct and review strict canonical manifest v2 bytes.
6. Authenticate to Identity Center using FIDO2 MFA and the signer profile.
7. Run `aws sts get-caller-identity`; stop on account, Region, role, or session
   mismatch.
8. Reconfirm key metadata, public fingerprint, and live policy checksum.
9. Sign the exact canonical bytes once with KMS `ED25519_SHA_512` and `RAW`.
10. Verify through KMS, local Ed25519, Mission Control, and Mission Agent.
11. Record signature and manifest hashes, request IDs, signer ARN, and
    CloudTrail evidence.
12. Independently review the signed release.
13. Obtain separate publication authorization.
14. Publish exact reviewed bytes, then use a separately authorized staged
    rollout.
15. Monitor and retain evidence.

Safe command patterns use named profiles and exact ARNs:

```bash
aws sts get-caller-identity --profile wallyweb-kms-production-signer --region us-east-1
aws kms describe-key --profile wallyweb-kms-production-signer --region us-east-1 --key-id <exact-key-arn>
aws kms sign --profile wallyweb-kms-production-signer --region us-east-1 \
  --key-id <exact-key-arn> --message fileb://<canonical-manifest> \
  --message-type RAW --signing-algorithm ED25519_SHA_512
```

Never place credentials or session tokens in commands, files, or receipts.

## 6. Trust lifecycle

- `pending`: recorded and reviewable but ineligible for production verification.
- `active`: eligible after explicit activation evidence and approval.
- `retiring`: preserved for governed compatibility while replacement proceeds;
  not used for new signing unless policy explicitly permits it.
- `retired`: preserved for historical verification and rejected for new
  releases.
- `revoked`: rejected because compromise or invalidity is suspected or proven.

Valid transitions require reviewable evidence. Normal flow is
`pending → active → retiring → retired`; emergency flow may move a key to
`revoked`. Activation and signing are separate governed actions.

## 7. Key rotation

1. Create one approved KMS key.
2. Derive the DER SPKI fingerprint independently.
3. Introduce the public record as pending.
4. Ship verifier support without activating or signing.
5. Validate Mission Control and Mission Agent behavior.
6. Activate with explicit evidence.
7. Sign a new release with the new key.
8. Confirm old and new verification behavior.
9. Retire the previous key only after compatibility is proven.
10. Preserve historical public keys.
11. Schedule deletion only after the approved retention and migration criteria.

Deleting and recreating an Identity Center permission set changes its generated
role ARN. Re-review and update the exact key-policy principal before relying on
the new role.

## 8. Emergency freeze

First remove or suspend the signer’s Identity Center assignment. Stop
publication and rollout, preserve evidence, and inspect CloudTrail. If needed,
update the key policy to deny signing. Disable the KMS key only with explicit
emergency authorization because it is more disruptive. Mark trust state
through the governed incident process; never erase evidence.

## 9. Suspected signer compromise

Stop signing, revoke active sessions, remove the signer assignment, inspect
CloudTrail, and freeze KMS signing access. Determine whether the human identity
or the AWS account/key boundary is affected. Revoke the trust record when
warranted, introduce a replacement key through the normal governed process,
and withdraw or replace affected releases. Notify maintainers or users when
release integrity may be affected. KMS private-key material is non-exportable.

## 10. Lost MFA device or unavailable signer

Use approved Identity Center recovery or a registered backup MFA device. Do not
weaken KMS policy, substitute long-lived IAM credentials, combine administrator
and signer duties, or bypass approval. Record any emergency recovery use.

## 11. AWS account incident

Freeze releases and treat all signer and administrator sessions as untrusted.
Preserve CloudTrail externally where authorized. Investigate the suspected
window, rotate or replace the trust root through the emergency governance
process, update both verifier trust bundles, and reassess every release signed
during the window.

## 12. Key deletion and recovery warning

KMS deletion is destructive and is never routine production cleanup. Local
verification can continue with preserved public keys, but KMS verification and
operational recovery are lost. Before deletion, review historical manifests,
public-key evidence, retention rules, root recovery, administrator recovery,
and migration completion. Do not destructively roll back trust history.

## 13. Adding a second maintainer

Create an individual Identity Center user, require MFA, and assign either
signer or administrator responsibility according to need. Never share
credentials. Test positive and denied boundaries, record custody approval, and
remove access promptly when responsibility ends.

## 14. Audit and evidence

Expected CloudTrail events include `GetPublicKey`, `GetKeyPolicy`,
`PutKeyPolicy`, `Sign`, `Verify`, and governed lifecycle actions. Commit only
non-secret receipts: artifact and manifest hashes, signature hash/encoding,
request IDs, public fingerprints, exact principals, policy hashes, test
results, and review disposition.

Policy and trust-record checksums use:

```bash
jq -cS . <file.json> | shasum -a 256
```

For signed canonical manifests, hash the compact canonical UTF-8 bytes without
the evidence file’s trailing newline. Compare live `GetKeyPolicy` output using
the same normalization. Retain evidence for at least the supported lifetime of
every affected artifact and longer when incident or compliance policy requires.

## 15. Failure modes and troubleshooting

- Wrong role, account, Region, or missing temporary session: stop and
  reauthenticate; never switch to a broader profile.
- Expired SSO session: renew through Identity Center with MFA, then reconfirm.
- Key-policy mismatch: stop; review and apply only the committed policy through
  the administrator role.
- Fingerprint or artifact mismatch: stop; never sign substitute bytes.
- Canonicalization mismatch: regenerate with canonical tooling; do not hand-edit.
- Signature failure: stop and preserve evidence; do not retry signing until the
  cause is understood.
- Trust still pending: stop; obtain explicit activation authorization.
- Signer denied: verify exact generated role ARN and assignment; do not broaden
  permissions casually.
- Administrator can sign: freeze and repair separation before proceeding.
- CloudTrail delay: keep the release blocked and poll read-only until correlated.
- Permission-set recreation: discover the new role ARN and govern a key-policy
  update before using it.

## 16. Current known values

- AWS account: `661452835066`
- Region: `us-east-1`
- KMS key ID: `cd9ebd3d-f2c6-44cb-83d6-fd4893008fee`
- KMS key ARN: `arn:aws:kms:us-east-1:661452835066:key/cd9ebd3d-f2c6-44cb-83d6-fd4893008fee`
- Public fingerprint: `ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b`
- Administrator: `arn:aws:iam::661452835066:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_MissionAgentReleaseAdmin_240a7ff2222406d1`
- Signer: `arn:aws:iam::661452835066:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_MissionAgentReleaseSigner_6d0f08fa6781c70d`
- KMS policy checksum: `4e7a8e177eb46c4c173a777e3e150c639b846fc5a0f026196f8a97b15e7d4bb7`
- Release Authority / manifest: `2` / `2`
- Pending repository trust-record checksum:
  `91e8774f38bb64b4715169928fec4fe4a03ca861c687241795c93e706a3f7b6b`
- Active repository trust-record checksum: not available; activation is blocked
- Unsigned 0.7.1 canonical manifest checksum:
  `8fc90fb63b1b6440e590a58e7c3eda5318b2fbd7c96c41a6cb97636bc9882275`
- Signed 0.7.1 manifest checksum: not available; signing is blocked
- 0.7.1 artifact checksum:
  `279365e5d1bcd18ce9bd8ac84d4b7e512cd3ff2f7f559e9892cd6fda3bf17803`
