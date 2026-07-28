# Release Authority

## Mission Agent 0.7.2 replacement-bootstrap V1 boundary

Release Authority proves the immutable Mission Agent artifact and manifest; it
does not by itself authorize a host mutation. The V1 replacement path adds a
single-use deployment-, operator-, host-, agent-, artifact-, fence-, and
authorization-bound grant. Provider completion is accepted only from the
enrolled host's durable signed receipt. After the first mutation intent,
forward expiry or Mission Control deployment replacement cannot remove the
exact rollback obligation.

The authoritative controller database credential is scoped to the web
component that serves the six governed routes. Worker containers receive only
the ordinary runtime database credential. Rollback closure requires fresh
host-signed restored-process observations plus authenticated heartbeat,
capability, repository identity, inventory, and projection-replay evidence.
The database never manufactures host observations.

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

## 17. Replacement Trust Bootstrap for Legacy Agents

Mission Agent 0.6.8 cannot verify Manifest v3, and its Manifest v1 private key
is presumed unrecoverable. There is no cryptographic continuity from that lost
key. A human operator may establish the new production trust root only through
the separately governed `operator-replacement-bootstrap-v1` procedure.

This is not an updater flow. The existing 0.6.8 updater authorizes nothing in
the transition. A durable human authorization binds one named agent, its exact
0.6.8 checksum, host, workspace and repository identity, the exact signed 0.7.2
release, Node 22.22.0, expiry, one execution, rollback, and evidence. It is
revocable before execution.

Mission Control requires a granted approval projection whose action hash is the
authorization checksum. It locks and revalidates that approval, its approver,
and its expiry against the database clock in the same transaction that consumes
the one-shot execution.

The operator verifies the canonical Manifest v3 and artifact through both the
Mission Control Release Authority verifier and standalone Ed25519 using the
embedded active production key. External trust roots, redirects to unknown
origins, Manifest v1/v2 targets, and substituted bytes fail closed.

The macOS service uses the absolute executable
`/opt/mission-agent/runtime/node-22/22.22.0/bin/node`. The official Darwin arm64
archive and installed executable are checksum-pinned. Global Node, shell
profiles, and unrelated services remain unchanged.

Before replacement, drain only the named agent, preserve its 0.6.8 artifact,
LaunchAgent, non-secret configuration checksums, identity, registrations,
credential storage, and logs. Stage 0.7.2 and the new LaunchAgent using
temporary paths, verify them, then atomically rename. Stop and roll back on
runtime, verification, switch, startup, identity, heartbeat, capability, or
smoke-test failure. Migration 0028 is never rolled back.

The state machine is checksummed and compare-and-set:
`prepared → approved → draining → verified → staged → replacing → starting →
connected → accepted → completed`, with explicit failure, rollback, revocation,
and expiry states. One active authorization per agent and one replacement
execution are allowed. Completion or rollback is terminal; failure never
automatically retries.

The host writes a checksum-bound phase journal before every service or
filesystem boundary. On restart, any nonterminal journal deterministically
restores the preserved 0.6.8 artifact and LaunchAgent before the operator may
request a new authorization.

After 0.7.2 connects, verify the original agent and repository identities,
stable heartbeats, Manifest v3/Release Authority v2 capabilities, and one
governed read-only smoke mission. Future updates then use only the native
Manifest v3 path. Remove the replacement controls after all authorized legacy
agents are transitioned or retired.

This procedure is transitional infrastructure and must not be used for agents
already capable of native Manifest v3 verification.

### Historical replacement-operator design (superseded and disabled)

The commands in this subsection describe the earlier design record only. They
are not executable authorization. The repaired CLI now refuses the
production-bound macOS filesystem and launchd provider in disposable mode, and
production remains disabled. A future production enablement requires a new,
commit-bound review and authorization.

The authorization checksum binds the complete `nodeRuntime`,
`serviceReplacement`, `smokeMission`, and `evidenceDestination` objects. This
includes the immutable Node URL, archive length/checksum, executable checksum,
absolute versioned installation paths, current/target/rollback LaunchAgent
checksums, fixed read-only smoke template, and governed evidence destination.
Unknown fields and mutable or relative paths fail closed. Any field change
invalidates the approval action hash.

The originally proposed entrypoint was:

```text
npm run replacement-bootstrap -- \
  --mode production \
  --authorization-id <uuid> \
  --agent-id 0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8 \
  --acknowledge operator-replacement-bootstrap-v1 \
  --evidence-output <governed-absolute-path>
```

It accepts only authorization ID, the redundant fixed agent assertion, mode,
the protocol acknowledgment, and a governed evidence location. Artifact,
manifest, signature, Node, service, trust, repository, workspace, version, and
rollback overrides are not command options.

The design called for a mutation-free preflight that loads the durable authorization, locks and
revalidates its approval fingerprint and database-clock expiry, confirms the
one-shot state, verifies the named agent and repository, verifies the exact
release through both verification paths, and requires schema 0028. The
operator owns the verified backup and exact 0029 migration before host work.

Host operations use the fixed `ReplacementHost` contract, not free-form shell
text. Each operation returns an authorization-bound structured receipt. The
operator advances the existing CAS state machine, stages Node/release/service,
drains only the named agent, switches once, verifies identity/heartbeats/
capabilities, runs the bound read-only smoke mission, observes, and completes.
After a non-idempotent boundary, ambiguous recovery always rolls back.

The checksum-bound host journal and database state are reconciled before
resumption. Only the next canonical idempotent operation may resume. A corrupt,
out-of-order, differently authorized, or terminal journal halts; any journal at
or beyond the atomic switch rolls back to exact 0.6.8. The evidence bundle
contains preflight, backup, migration, receipts, transitions, journal,
identity, heartbeat, capability, smoke, observation, and final fleet safety
state without credentials.

### Local operator-mediated canary architecture

Remote host control was rejected for this one legacy transition because there
was no reviewed authenticated transport and adding SSH automation or a new
network control plane would broaden the release surface. Mission Control owns
approval, package issuance, backup, migration, locking, the durable operation
ledger, smoke creation, state transitions, and final disposition. A human
authenticated to the named Mac invokes the reviewed local command:

```text
npm run replacement-bootstrap:local -- \
  --authorization-package <immutable-package.json>
```

The command accepts only the package path, `--dry-run`, `--inspect-journal`, and
an optional evidence directory that must exactly equal the package binding.
Agent, release, runtime, trust, Node, plist, path, repository, rollback, and
smoke overrides do not exist.

The package format is `replacement-authorization-package-v1`. Canonical JSON
binds the complete authorization and approval snapshots, authorization
fingerprint, disposable Mission Control prerequisite identity, one execution ID, one nonce,
one narrowly scoped credential ID, expiry, maximum use count one, fixed claim,
receipt, and decision paths, and receipt instructions. HMAC-SHA-256 uses a
dedicated replacement credential stored in macOS Keychain under
`com.wallyweb.mission-agent.replacement-bootstrap`; the secret is not in the
package, database evidence, command line, or logs. The credential allows only
`replacement-bootstrap-v1`, the named agent, and the authorization expiry. It
cannot create or approve authorizations or call ordinary administrative APIs.

Mission Control persists package issuance and claims in the existing protocol
receipt authority. Unique message IDs and nonces reject package and operation
replay. Each fixed local operation writes an authenticated pre-operation host
journal, executes once, submits an HMAC-authenticated checksum receipt, waits
for durable sequence acknowledgement, and then advances the journal. A local
journal one receipt behind the ledger may advance; an idempotent unconsumed
operation may resume. Larger discrepancies halt. Ambiguity at stop, artifact
replacement, plist replacement, or start always rolls back.

The exact canonical plist is
`release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist`.
It is 1,127 bytes with SHA-256
`c81d2310df79224c41d71bdac2ea458f53b86caeed8b1543a474e955fa00dde6`
and formally supersedes placeholder `a98179f5…`, for which no bytes existed.
It uses label `com.wallyweb.mission-agent`, absolute Node
`/opt/mission-agent/runtime/node-22/22.22.0/bin/node`, exact 0.7.2 artifact,
fixed agent home and working directory, deterministic PATH, existing log
paths, RunAtLoad, and KeepAlive. It has no secret, shell wrapper, or mutable
runtime alias. Install mode is 0600, owned by `shawnwollenberg:staff`. Rollback
uses the preserved LaunchAgent at the authorization-scoped rollback path with
checksum `3adfe6e3…`.

Node bindings live in `node-runtime.json`: official `nodejs.org` Darwin arm64
archive, no redirects, 49,923,798 bytes, archive checksum `5ed4db0f…`, immutable
install directory, executable checksum `913b144f…`, root:wheel ownership, and
0755 permissions. Symlinked or conflicting installations fail closed. Global
Node 24.10.0 is neither selected nor modified.

The authoritative `migration-history.json` hashes exact repository bytes in
order for migrations 0001–0029. Live production must equal exactly 0001–0028;
missing, extra, duplicated, reordered, or changed entries fail. A checked-out
PostgreSQL connection owns `BEGIN`, database clock, advisory transaction lock,
approval/fingerprint/expiry/concurrency revalidation, fixed 0029 application,
package claim initialization, evidence writes, commit or rollback, and release.
Backend PID checks before and after mutation detect session substitution.

Database tools are bound in `postgresql-tools.json` to PostgreSQL 17.4 in the
official amd64 image digest
`sha256:d4eceb7552a57997fff2e9ceb1a624210e61b6432a2a1f7934a418c27bfe1406`.
Only absolute `/usr/bin/pg_dump`, `/usr/bin/pg_restore`, and `/usr/bin/psql`
paths and enumerated arguments are permitted. Database credentials use libpq
references, never process arguments or evidence.

Before 0029, backup acceptance requires a mode-0600 custom dump, checksum and
length, positively verified encrypted storage, `pg_restore --list`, a real
restore into a disposable PostgreSQL 17 database, exact 0028 history,
required tables, representative safe counts, preserved repository
fingerprints, and absence of 0029 authorization tables. Migration is blocked
until every check passes. The disposable restore is destroyed after evidence;
off-host encrypted retention remains a separately governed follow-up.

The local operator stops only the exact launchd label, atomically installs only
the checksum-bound artifact and plist, and verifies Node, version, agent,
workspace, repository registration, heartbeat freshness, and doctor
capabilities. Mission Control—not the local command—creates the immutable
read-only smoke mission. The command waits for a checksum-bound continue or
rollback decision for the same execution. Rollback restores exact 0.6.8 and
the original plist once, restarts the same identity, and never retries 0.7.2 or
rolls back migration 0029.

### Replacement ownership, recovery, and acceptance repair

The prerequisite implementation is hard-disabled outside a fully bound
disposable environment. The server requires `NODE_ENV` to be non-production,
`MISSION_CONTROL_ENVIRONMENT=disposable-test`, the fixed disposable instance
identity, the explicit non-production gate value, a loopback PostgreSQL
endpoint whose database name begins
`mission_control_replacement_disposable_`, and the SHA-256 fingerprint of
those exact resources. The local command additionally requires a loopback
HTTPS Mission Control origin and the disposable instance identity embedded in
the authenticated package. Missing or unknown environment identity, a
production process, a non-loopback endpoint, a request-field override, or a
resource fingerprint mismatch fails before authentication or mutation. Every
replacement API route returns 503 by default and in production.

Migration 0029 now contains the durable ownership model:

- `mission_agent_replacement_credentials` binds one non-reversible verifier
  fingerprint and exact operation scope to one authorization, execution,
  agent, provider, fingerprint, expiry, and maximum sequence.
- `mission_agent_replacement_execution_claims` is the single claim owner and
  records the PostgreSQL claim time, generation, state, expiry, and last
  accepted sequence.
- `mission_agent_replacement_mutation_intents` commits each exact mutation,
  fixed-argument checksum, pre/postcondition checksums, retry policy, and
  rollback obligation before the host acts.
- `mission_agent_replacement_receipts` consumes credential, claim, request
  nonce, receipt nonce, operation, result, host-journal, and authentication
  bindings atomically with the state transition.
- `mission_agent_replacement_evidence` stores authoritative drain, process,
  heartbeat/capability, projection, smoke, and rollback-equivalence evidence.

Credential issuance, execution-claim creation, authorization consumption, and
the initial state transition occur in one transaction after locking the
authorization and approval. The database clock must show an approved,
fingerprint-matching, unexpired, unrevoked, unconsumed authorization with no
existing owner. The raw credential is returned once; only the existing
protocol verifier plus its fingerprint are persisted. Terminal completion or
rollback consumes and revokes both credential records.

The server operation table is authoritative. It defines every forward and
rollback operation, whether it mutates, retry safety, receipt requirements,
rollback obligation, recovery eligibility, and expiration behavior. A host
journal cannot authorize a transition. Skips, sequence gaps, state mismatch,
duplicate mutation, early smoke, early completion, rollback before failure,
forward progress after rollback, and terminal reuse fail closed.

For every host mutation the sequence is: committed server intent, authenticated
local pre-operation journal, observed pre/postcondition, at-most-once fixed
operation, authenticated post-operation journal, receipt, atomic server
consumption, then local acknowledgement. Recovery queries the locked server
claim and pending intent. A complete postcondition produces a recovery receipt
without repeating the mutation. An unchanged precondition may retry only for
an operation explicitly marked retry-safe. Partial or ambiguous state halts;
an ambiguous forward mutation requires governed rollback. A receipt accepted
before the HTTP response or before the local journal update is reconciled from
the authoritative sequence.

Drain is not a host assertion. The execution claim makes the named agent
ineligible for ordinary pull assignments. Mission Control checks active
assignments and leases, executions, targeted jobs/outbox messages, publication
assignments, and the latest heartbeat twice across a bounded stabilization
window, then persists a checksum-bound drain record. Only the immutable smoke
assignment is exempt, and only when its authorization ID, replacement
execution ID, and exact template checksum match.

The approved smoke bytes are in
`release/mission-agent-0.7.2/replacement-bootstrap/read-only-smoke-template.json`
with SHA-256
`9a2c0df075b182a3f8c7bbcb5f67ad05f465f4504974d3fd8ac0e517caa5fec9`.
Mission Control creates deterministic canonical mission, task, execution, and
assignment records through the existing governed command/event path. Continue
is issued only after the named agent completes exactly one execution using
that repository and template, artifacts have canonical checksums, the lease is
gone, no forbidden push/publication/deployment/approval event exists,
heartbeats span execution, and projection aggregate versions match their
authoritative event streams. A host-reported smoke result is ignored.

The local provider inspects the real launchd job and process. Process receipts
bind host, agent, service label, PID/parent PID, process start time and owner,
absolute Node executable/version, artifact path/checksum, arguments checksum,
and plist checksum. The process must start after the committed start intent.
Repeated observations must name one stable PID. Mission Control then requires
three post-start heartbeat events, version 0.7.2, the exact artifact checksum,
Node 22, Manifest v3, Release Authority v2, v3 canonicalization, fresh
capabilities, the approved repository fingerprint, one agent identity, and
matching live/reconstructed projection checksums.

Rollback inventory is immutable at
`release/mission-agent-0.7.2/replacement-bootstrap/rollback-0.6.8-inventory.json`
with SHA-256
`2e7f074a890b1b6492ac76d1786b987c0a7417e50532a1e712699963b7e5f229`.
It binds exact 0.6.8 bytes, original plist, absolute Node 24.10.0 selection,
arguments, environment-name/value checksums, config metadata, Keychain
storage, modes, ownership, logs, and restart behavior. Rollback has its own
committed intents, removes the staged target, restores exact prior bytes and
plist, starts once, observes the real 0.6.8 process twice, requires three fresh
prior-version heartbeats and capabilities, verifies repository identity and
projection equivalence, proves no target process remains, and makes the
authorization and credential terminal. Timestamps, PID, heartbeat times, and
append-only log bytes are the only permitted equivalence differences.

PostgreSQL backup tooling is checked at runtime as well as in the manifest:
the runner must attest the exact immutable image digest and linux/amd64
platform, and each absolute executable must have the expected byte checksum,
17.4 version, root ownership, 0755 mode, and non-symlink type before any backup
command is accepted.

This implementation does not authorize production use. Production still
requires a new authorization naming the final commit, final asset and package
checksums, exact production application image digest, migration 0029, backup
location and encryption proof, package issuance, the named canary, and the
single local command.

### Isolated replacement-bootstrap acceptance

The production-shaped disposable acceptance starts a real Next.js server
behind loopback HTTPS, initializes a real PostgreSQL 17 database through the
checked-in migrations, and drives only authenticated replacement-bootstrap and
Mission Agent HTTP routes. The operator process, application process, and
stateful disposable provider use separate requests and durable files. The
provider rejects a second execution of any non-idempotent mutation.

The acceptance matrix proves one forward completion, one governed
post-mutation failure followed by exact rollback, receipt loss after every
forward mutation, and receipt loss after every rollback mutation. Canonical
database claims, credentials, mutation intents, receipts, events, projections,
leases, outbox records, smoke execution, and artifacts are checked after each
scenario. Agent status and repository identity are rebuilt from authoritative
events rather than copied projection values. Repository identity is extracted
from the authenticated heartbeat event and compared independently with both
the active identity source record and repository projection; the evidence
records separate source and event-replay hashes.

Run the isolated matrix:

```text
npm run test:replacement:http-e2e
npm run test:replacement:migration
```

The sanitized committed result is
`release/mission-agent-0.7.2/replacement-bootstrap/evidence/http-e2e-acceptance.json`.
Migration evidence and the untouched-base full-suite classification live
beside it. These records contain no package secret, agent credential, private
key, raw authentication header, or disposable absolute path.

The two checksum-bound fixture files intentionally retain their canonical byte
formats and are excluded from Prettier rewriting. Their SHA-256 values must be
verified instead.

Interrupted rollback remains reachable after authorization expiry without
reopening forward execution. Only the intent, receipt, recovery-status, and
failure endpoints may authenticate an expired replacement credential; the
governance transaction then permits only operations whose state-table entry is
explicitly rollback-only and allowed after expiry. The package verifier may
verify immutable HMAC-bound bytes in recovery mode, but an expired package
cannot claim or begin a new execution. An existing forward journal with a
rollback obligation is forced into the durable rollback state before any
further host action.

Mission Agent 0.7.2 is registered as the exact approved Manifest v3 artifact
for post-restart capability verification. The registry binds version `0.7.2`,
Manifest `3`, and SHA-256
`108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`;
it does not alter the signed artifact, manifest, signature, or trust record.
