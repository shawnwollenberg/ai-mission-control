# Release Authority v2

Release Authority v2 separates reproducible artifact construction from
human-authorized AWS KMS signing and supports overlapping, identified Ed25519
trust roots. KMS is only the private-key custody and signing backend.

## Trust model

Key IDs use `mission-agent-release-YYYY-NN`. A key moves through `pending`,
`active`, `retiring`, `retired`, or `revoked`. Only an authenticated Mission
Control application release may add or change a trust record. A manifest can
never introduce or activate its own key.

The planned replacement ID is `mission-agent-release-2026-01`. It is not yet in
the application trust store because no authorized KMS key has been created and
its DER SubjectPublicKeyInfo has not been approved.

- `pending`: public key is installed but cannot verify release publication.
- `active`: may authorize new releases.
- `retiring`: cannot authorize a v2 manifest. Existing approved v1 releases use
  their exact legacy verification path. An overlap for new releases requires
  both keys to be independently introduced and `active`.
- `retired`: cannot authorize new releases; approved historical evidence remains verifiable.
- `revoked`: rejected for all new trust decisions. Incident policy determines
  treatment of previously signed artifacts.

Unknown keys, malformed trust configuration, missing key IDs, and inactive keys
fail closed. Rollback of application code must not reactivate a revoked key.

## Manifest v2

The unsigned manifest has exactly these fields:

```json
{
  "activationProtocolVersion": "1",
  "agentVersion": "0.6.9",
  "artifactPath": "/mission-agent-0.6.9.mjs",
  "artifactSha256": "a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af",
  "buildId": "<approved-build-id>",
  "createdAt": "<canonical-UTC-timestamp>",
  "expiresAt": "<canonical-UTC-timestamp>",
  "identityProtocolVersion": "2",
  "manifestVersion": "2",
  "minimumMissionControlVersion": "<approved-version>",
  "signingKeyId": "mission-agent-release-2026-01",
  "sourceCommit": "1c8aee72eda931f45f2dfae3db2c0f7798a67400"
}
```

Keys are serialized lexicographically with compact UTF-8 JSON. Arrays retain
order. No duplicate or unknown fields are accepted. The detached base64
Ed25519 signature covers those exact canonical bytes. A signed bundle adds only
`signature`.

The transitional v1 manifest remains supported solely for the approved 0.6.8
artifact. A v2 manifest never falls back to the old key.

## Build, sign, and verify

The connected build system may create only the unsigned manifest:

```sh
npm run mission-agent:release:build -- \
  --artifact public/mission-agent-0.6.9.mjs \
  --output /approved-transfer/mission-agent-0.6.9.unsigned.json \
  --agent-version 0.6.9 \
  --source-commit 1c8aee72eda931f45f2dfae3db2c0f7798a67400 \
  --expected-checksum a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af \
  --activation-protocol-version 1 --identity-protocol-version 2 \
  --build-id '<approved-build-id>' \
  --created-at '<canonical-UTC-timestamp>' --expires-at '<canonical-UTC-timestamp>' \
  --minimum-mission-control-version '<approved-version>' \
  --signing-key-id mission-agent-release-2026-01
```

Only the authorized human runs the sign command from an interactive terminal
using a short-lived AWS IAM Identity Center session:

```sh
npm run mission-agent:release:sign -- \
  --manifest release/mission-agent-0.7.0/unsigned-manifest-v2.json \
  --artifact public/mission-agent-0.7.0.mjs \
  --pending-key-record /approved/release-key-2026-01.pending.json \
  --trust-activation-evidence /approved/release-key-2026-01.active.json \
  --kms-key-arn '<exact-kms-key-arn>' \
  --expected-signer-role-arn '<exact-release-signer-role-arn>' \
  --expected-artifact-sha256 3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e \
  --expected-source-commit a6d867f217c6e28ce811fbb5b8bf8778fad193c4 \
  --expected-release-version 0.7.0 \
  --release-authority-key-id mission-agent-release-2026-01 \
  --approval-reference '<approved-release-record>' \
  --output-signature /approved/mission-agent-0.7.0.signature \
  --output-bundle /approved/mission-agent-0.7.0.signed.json \
  --output-receipt /approved/mission-agent-0.7.0.signing-receipt.json
```

The command checks the pending trust record, requires a release-specific human
confirmation, signs exact canonical bytes with `MessageType=RAW`, and verifies
through both Node Ed25519 and KMS Verify. It is disabled in CI and production,
never creates a key, and never activates trust or publishes.

After the public key is installed and active, connected systems may verify:

```sh
npm run mission-agent:release:verify -- \
  --bundle /approved-transfer/mission-agent-0.6.9.signed.json \
  --artifact public/mission-agent-0.6.9.mjs \
  --source-commit 1c8aee72eda931f45f2dfae3db2c0f7798a67400
```

## Rotation authorization

Activation requires a human-approved record binding the old and new key IDs,
new public fingerprint, purpose, Mission Control release SHA, deployment
evidence, activation time, overlap duration, old-key retirement policy,
approving actor, approval expiry, and a SHA-256 fingerprint of the canonical
request. Approval is invalid before the authenticated trust-store release is
deployed and verified.
