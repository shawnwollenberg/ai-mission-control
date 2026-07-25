# Mission Agent release signing controls

## Trust boundary

Mission Agent release manifests use Ed25519. Artifact construction and
release signing are separate duties. Build systems produce immutable bytes
and a checksum; an offline custodian signs the canonical manifest. Mission
Control, onboarding, and the updater accept only an explicitly trusted public
key and approved version/checksum mapping.

Current key identifier:

```text
ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a
```

The identifier is the SHA-256 of the DER-encoded public SPKI bytes. It contains
no private material.

## Custody record

The repository establishes that the private key is offline and absent from
the repository and production image. It does not identify the custodian,
backup custodian, storage medium, creation date, recovery process, or an
existing signing command. Those fields must be completed in the restricted
release audit system by the release owner; no recovery secret belongs here.

Future production signing should require two people where practical:

1. a build reviewer confirms source commit, reproducible artifact checksum,
   protocol versions, and completed tests;
2. a signing custodian confirms approvals and signs in the offline
   environment.

## Existing-key ceremony

1. The release owner approves the exact source commit and unsigned candidate
   record.
2. Rebuild with the recorded command in the approved Node 22 environment.
3. Require the artifact checksum to equal the candidate record.
4. Construct only the canonical fields: `version`, `path`, `sha256`, and
   `manifestVersion`. A future key-ID contract must be introduced through an
   authenticated application release before adding `signingKeyId`.
5. Sign the canonical UTF-8 JSON bytes with the offline Ed25519 key.
6. Verify using the public key embedded in the currently trusted updater.
7. Run modified-artifact, modified-checksum, modified-version, wrong-key,
   invalid-signature, replay, stale-capability, unknown-key, manifest-mismatch,
   and onboarding-equality tests.
8. Have a reviewer compare the signature, source commit, checksum, version,
   path, manifest version, identity protocol `2`, and activation
   acknowledgement version `1`.
9. Prepare onboarding and latest-manifest changes without publishing them.
10. Record the ceremony in the restricted audit system and stop for explicit
    publication authorization.

Private-key bytes, signing environment variables, device identifiers,
recovery phrases, and raw command history must not enter source control,
application logs, or agent context.

## Key rotation when loss is confirmed

Key loss must be confirmed by the release owner or documented custodian before
rotation begins. Generate the replacement Ed25519 key offline and retain only
its public key and safe identifier in source control.

Because a replacement key cannot authorize itself, introduce it through a
reviewed and authenticated Mission Control application release. That release
must:

- retain the old public key during a bounded transition when it is not
  suspected compromised;
- declare stable key identifiers and an allowlist of trusted public keys;
- bind manifest signatures to the declared key identifier;
- record activation and retirement timestamps in a canonical key-rotation
  event;
- reject unknown keys, premature activation, retired keys, downgrade
  manifests, and mismatched key identifiers;
- preserve application rollback without restoring a revoked trust root.

Only after production trusts the new public key may that key sign a Mission
Agent release. The new-key manifest alone is never rotation authority.

## Compromise and emergency revocation

Suspected compromise stops ordinary signing. Open a security incident,
inventory releases and manifests signed by the key, ship revocation through
the authenticated application release process, and require the replacement
key for future releases. Do not use a suspected key to bridge trust.

Emergency rollback may restore application code but must not destructively
reverse schema or canonical audit events, and must not re-enable a revoked
key. Currently deployed Mission Agent artifacts remain subject to incident
assessment.

## Recovery and audit

The restricted audit record must capture approvals, key identifier, custodian,
backup custody, creation date, offline storage class, source commit, artifact
checksum, canonical manifest hash, signature verification result, and
publication decision. It must never contain private recovery secrets.

If the existing key is merely unavailable for the current session, stop with
publication blocked. Unavailability is not proof of loss and does not
authorize rotation.

