# Mission Agent release signing controls

## Trust boundary

Mission Agent release manifests use Ed25519. Artifact construction and
release signing are separate duties. Build systems produce immutable bytes
and a checksum; a human-authorized AWS KMS role signs the canonical manifest. Mission
Control, onboarding, and the updater accept only an explicitly trusted public
key and approved version/checksum mapping.

Current key identifier:

```text
ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a
```

The identifier is the SHA-256 of the DER-encoded public SPKI bytes. It contains
no private material.

## Custody record

The replacement private key remains non-exportable inside AWS KMS. No PEM,
private-key backup, access key, or session token belongs in repositories,
production images, Project Brain, Mission Agents, CI, or signing receipts.

Future production signing should require two people where practical:

1. a build reviewer confirms source commit, reproducible artifact checksum,
   protocol versions, and completed tests;
2. a release signer confirms approvals, authenticates with MFA, and calls KMS
   using short-lived credentials.

## KMS signing ceremony

1. The release owner approves the exact source commit and unsigned candidate
   record.
2. Rebuild with the recorded command in the approved Node 22 environment.
3. Require the artifact checksum to equal the candidate record.
4. Confirm manifest v2, the Release Authority key ID, and protocol fields.
5. Authenticate through IAM Identity Center with the registered FIDO2 factor.
6. Assume the dedicated signer role and run the interactive KMS command.
7. Verify locally and through AWS KMS.
8. Run modified-artifact, modified-checksum, modified-version, wrong-key,
   invalid-signature, replay, stale-capability, unknown-key, manifest-mismatch,
   and onboarding-equality tests.
9. Have a reviewer compare the signature, source commit, checksum, version,
   path, manifest version, identity protocol `2`, and activation
   acknowledgement version `1`.
10. Prepare onboarding and latest-manifest changes without publishing them.
11. Record the ceremony in the restricted audit system and stop for explicit
    publication authorization.

AWS access keys, session tokens, identity recovery data, device identifiers,
and raw environment dumps must not enter source control, logs, receipts, or
agent context.

## Key rotation when loss is confirmed

AWS KMS asymmetric keys rotate manually through a new non-exportable KMS key
and a new Release Authority key ID. Automatic key-material rotation does not
apply to asymmetric KMS signing keys.

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

The restricted audit record captures approvals, key identifier and ARN, signer
principal, KMS request ID, source commit, artifact checksum, canonical manifest
hash, verification result, and publication decision. It must never contain AWS
credentials or recovery secrets.

If AWS, Identity Center, MFA, or the signer role is unavailable, stop with
publication blocked. Unavailability does not authorize a weaker signing path.
