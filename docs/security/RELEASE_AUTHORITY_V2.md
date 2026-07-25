# Release Authority v2

Release Authority v2 separates reproducible artifact construction from human,
offline signing and supports overlapping, identified Ed25519 trust roots.

## Trust model

Key IDs use `mission-agent-release-YYYY-NN`. A key moves through `pending`,
`active`, `retiring`, `retired`, or `revoked`. Only an authenticated Mission
Control application release may add or change a trust record. A manifest can
never introduce or activate its own key.

The planned replacement ID is `mission-agent-release-2026-01`. It is not yet in
the application trust store because no authorized human public key or completed
custody record has been provided.

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

Only the authorized human runs the sign command in the offline environment:

```sh
npm run mission-agent:release:sign -- \
  --manifest /offline-transfer/mission-agent-0.6.9.unsigned.json \
  --private-key /offline-custody/private-key.pem \
  --output /offline-transfer/mission-agent-0.6.9.signed.json \
  --confirm-artifact-sha256 a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af \
  --expected-public-key-fingerprint '<approved-ed25519-spki-sha256-fingerprint>'
```

The private-key path is illustrative and must never be copied into an agent
session, source control, CI, or an application environment. The sign tool is
disabled in CI and production and never generates a key.

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
