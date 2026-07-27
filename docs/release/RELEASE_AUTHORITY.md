# Release Authority

## 1. Purpose and scope

Release Authority protects the identity and integrity of distributable Mission
Agent artifacts. A valid signature proves that an approved release signer used
the governed AWS KMS key to sign the exact canonical manifest bytes and that the
manifest binds an artifact checksum and source commit. It does not prove that
the artifact is defect-free, approved for publication, deployed, or safe for a
particular environment.

Mission Control and Mission Agent consume Manifest v3 and the public trust
records. Private signing material never enters either system. Project Brain
uses the resulting Mission Agent identity and capability evidence but does not
hold release-signing authority.

For the five-minute operator flow, use
[`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md). This document remains the
authoritative architecture, policy, recovery, and troubleshooting reference.

## 2. Architecture

```text
Human signer with FIDO2 MFA
→ AWS IAM Identity Center
→ Temporary MissionAgentReleaseSigner role
→ AWS KMS Ed25519 key
→ Canonical Release Authority v2 / Manifest v3
→ KMS signature and non-secret receipt
→ Mission Control verification
→ Mission Agent verification
→ separately authorized publication and rollout
```

Release Authority v2 uses Manifest v3, canonicalization
`release-manifest-json-v3`, raw Ed25519 signatures, and explicit key ID plus
public-key fingerprint binding. Key administration, signing, verification,
publication, deployment, and fleet rollout are separate authorities. A signing
authorization is never a publication authorization.

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
- Repository trust state: `active` as of `2026-07-27T16:58:06.000Z`
- 0.7.1 and 0.7.2 embedded bootstrap state: `active`
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

Mission Agent 0.7.1 embeds the approved production
Ed25519 public key as the only active/bootstrap key while retaining the
historical key in retiring state for compatibility, but it understands only
Manifest v2. Pre-signing review found that v2 did not directly bind the public
fingerprint, Release Authority version, canonicalization version, platform,
artifact length, or structured compatibility/build metadata. It was therefore
never signed or published.

Mission Agent 0.7.2 is the first production KMS-signed release candidate with both the embedded
production bootstrap trust and native Manifest v3 verification. The artifact
cannot sign or activate anything; it contains public verification material
only. Repository trust was activated under the separate activation-and-signing
authorization. The signed candidate remains unpublished and unadvertised until
a separate publication authorization.

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

The 0.7.2 signing ceremony confirmed the exact artifact and Manifest v3 checksums,
reproducibility, embedded key/fingerprint, repository activation evidence,
live KMS policy checksum, signer identity, four-path verification plan, and
separate publication hold.

## Manifest v3 contract

Manifest v3 signs every release-acceptance input: manifest, Release Authority,
and canonicalization versions; release version; artifact name, checksum, and
byte length; build ID and source commit; signing key ID and public fingerprint;
creation and expiration timestamps; structured platform metadata; and
identity, activation, and minimum Mission Control compatibility. It also binds
the builder, lockfile, schema, reproducibility-evidence hashes, exact Node
version, and container image digest. Test results and human review remain
separately authenticated Git evidence rather than runtime selection inputs.

`createdAt` is the governed release-candidate effective timestamp, not the KMS
ceremony timestamp. A candidate may be signed before that scheduled timestamp;
it remains unpublished and must not be made available before `createdAt`.
`expiresAt` is the verifier-enforced upper validity bound. For 0.7.2,
`createdAt` is `2026-07-27T20:00:00.000Z`, after the signing ceremony at
`2026-07-27T17:02:28.756Z`; this was preserved because authorization required
signing the exact previously approved canonical bytes.

The platform is the actual portable ESM artifact target: Node.js major 22,
`darwin-linux`, `universal`, and `esm`. These exact case-sensitive values are
required. Aliases and unknown fields are rejected.

Canonicalization `release-manifest-json-v3` validates the schema before
serialization, requires UTF-8 and Unicode NFC strings, recursively orders
object keys, preserves schema-defined array order, uses compact JSON escaping,
permits only required positive safe integers, uses lowercase hexadecimal
checksums and canonical ISO-8601 timestamps, and emits no whitespace or
trailing newline. Duplicate and unknown keys are rejected before signature
verification.

The verifier selects a key by exact key ID, requires active state, compares the
signed fingerprint with the trust record, derives the fingerprint again from
the stored DER SPKI key, and verifies with that same key. Any disagreement
fails closed.

Mission Control's production release-selection boundary is
`application/mission-agent-release-selection.ts`. It requires a canonical
signed v3 bundle and checks the signature, minimum Mission Control version,
artifact name, byte length, and checksum. The operational verification command
uses this boundary. The KMS signing adapter parses only Manifest v3 for new
production signing; its v2 mode requires an explicit historical-test flag that
the human signing command does not expose.

Manifest v1 remains available only for the explicitly governed 0.6.8 rollback.
Manifest v2 remains parseable for historical fixtures but is prohibited for
new production selection. A v3 parse or verification failure never falls back
to v2.

## 5. Normal release procedure

1. Build the artifact deterministically from a recorded source SHA.
2. Build again in an independent clean environment and compare bytes.
3. Record the artifact checksum, byte length, platform, toolchain, and lockfile.
4. Run tests, dependency audit, secret scan, and independent security review.
5. Construct and review strict canonical Manifest v3 bytes.
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

## Appendix A: Current signed release candidate

Mission Agent 0.7.0 remains unchanged and unsigned because it lacked the
production trust root. Mission Agent 0.7.1 remains unchanged and unsigned
because it lacked Manifest v3. Mission Agent 0.7.2 is the first production
KMS-signed Mission Agent release candidate. It has not been published,
advertised, installed, upgraded, deployed, or rolled out.

- Version: `0.7.2`
- Artifact source commit: `31b45c98f2ffba613b56cd23819ba8b0c9c09a43`
- Artifact: `public/mission-agent-0.7.2.mjs`
- Artifact byte length: `148063`
- Artifact SHA-256: `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`
- Manifest version: `3`
- Release Authority version: `v2`
- Canonicalization: `release-manifest-json-v3`
- Canonical manifest byte length: `1386`
- Canonical manifest SHA-256: `b9f7d17b54219a50f4298817db1bcece1fec49eb9311e27aa9a6f4f9a5947ace`
- Signature byte length: `64`
- Signature SHA-256: `4c86744ec6e8749b743b9130c65f23e6e2b324d3ccac3d0bf01c828b91d1a583`
- KMS Sign request ID: `6fb8434a-668a-46d0-a883-e55a5edb810b`
- KMS Verify request ID: `54e4158f-c01c-40c0-8293-1059f2cc8eeb`
- KMS key ARN: `arn:aws:kms:us-east-1:661452835066:key/cd9ebd3d-f2c6-44cb-83d6-fd4893008fee`
- Public-key fingerprint: `ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b`
- Signer principal: `arn:aws:iam::661452835066:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_MissionAgentReleaseSigner_6d0f08fa6781c70d`
- Administrator principal: `arn:aws:iam::661452835066:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_MissionAgentReleaseAdmin_240a7ff2222406d1`
- KMS key-policy checksum: `4e7a8e177eb46c4c173a777e3e150c639b846fc5a0f026196f8a97b15e7d4bb7`
- Platform: Node.js 22, `darwin-linux`, `universal`, `esm`

The active trust-record checksum and final commit are recorded in the
repository evidence generated alongside this appendix. Manifest v2 is
prohibited for new production releases. Manifest v1 remains limited to the
governed Mission Agent 0.6.8 rollback path.

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
- Unsupported manifest version: confirm the agent advertises Manifest v3; do
  not downgrade to v2.
- Release Authority or canonicalization mismatch: stop and compare the exact
  signed values with the supported `v2` and `release-manifest-json-v3`.
- Signed fingerprint mismatch: compare key ID, signed fingerprint, trust record,
  and independently derived DER SPKI fingerprint.
- Platform mismatch: use the exact structured target values; do not normalize
  aliases after signing.
- Agent capability lacks Manifest v3: the agent is ineligible for the release.
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
- Release Authority / manifest / canonicalization: `v2` / `v3` /
  `release-manifest-json-v3`
- Pending repository trust-record checksum:
  `91e8774f38bb64b4715169928fec4fe4a03ca861c687241795c93e706a3f7b6b`
- Active repository trust-record checksum:
  `8bdc37c0030136e2d9339d87c0ca506d2cb41310fe1d5bc003ecffc4acd64fba`
- Unsigned 0.7.2 canonical manifest checksum:
  `b9f7d17b54219a50f4298817db1bcece1fec49eb9311e27aa9a6f4f9a5947ace`
- Production signature SHA-256:
  `4c86744ec6e8749b743b9130c65f23e6e2b324d3ccac3d0bf01c828b91d1a583`
- KMS Sign / Verify request IDs: `6fb8434a-668a-46d0-a883-e55a5edb810b` /
  `54e4158f-c01c-40c0-8293-1059f2cc8eeb`
- Signed candidate status: locally committed evidence pending; publication,
  advertising, installation, deployment, and rollout remain unauthorized
- Trust-enabled signed-candidate commit:
  `6894601268a6571143f6cc9fd5a3667e31507403`
- CloudTrail correlation: independently verified by the read-only
  `MissionAgentReleaseAuditor` identity for Sign request
  `6fb8434a-668a-46d0-a883-e55a5edb810b` and Verify request
  `54e4158f-c01c-40c0-8293-1059f2cc8eeb`; publication remains separately
  unauthorized
- 0.7.2 artifact checksum:
  `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`
- 0.7.2 artifact source commit:
  `31b45c98f2ffba613b56cd23819ba8b0c9c09a43`
- 0.7.1 artifact checksum:
  `279365e5d1bcd18ce9bd8ac84d4b7e512cd3ff2f7f559e9892cd6fda3bf17803`
