# V1 Disposable macOS Staging Checklist

Use only a disposable Apple-silicon macOS VM or spare Mac. Never use the current
host, production Mission Agent, real canary identity, production Keychain
items, or production repository registrations.

## Prepare

- Create a fresh ARM64 macOS VM and a dedicated non-production user. Record the
  username and UID, then take a clean snapshot.
- Deny production network destinations. Allow only the accepted staging HTTPS
  endpoint and the package source required for the rehearsal.
- Create new staging workspace, agent, repository, operator credential, and
  Ed25519 host identity values. Do not import existing credentials.
- Assemble and verify one checksum manifest containing:
  - accepted commit `8922b5520ef0ad22b1e28240e9c55a5284a701b5`;
  - Mission Agent 0.7.2 SHA-256
    `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`;
  - operator SHA-256
    `450a11e802f6076323dd176eb56f3e48d9299f11bf1d554240ce6403f56fb82f`;
  - signed 0.7.2 manifest and signature;
  - prior 0.6.8 artifact and rollback inventory;
  - Node 22.22.0 archive and executable checksums;
  - target and rollback LaunchAgent plists;
  - production contract and database schema versions.

Stop on any checksum, identity, ownership, permission, or endpoint mismatch.

## Install and attest

- Install the operator at the fixed same-user path documented in
  `V1_MACOS_OPERATOR.md`.
- Verify no symlink components, exact owner, parent mode `0700`, executable
  mode `0500`, and the accepted operator checksum.
- Install the fixed Node runtime without replacing global Node. Verify its
  archive and executable checksums.
- Install only the fixed LaunchAgent label and `ProgramArguments`.
- Enroll the new host public key and verify Keychain ACL behavior from the real
  LaunchAgent session. Record only public identity and fingerprints.
- Reboot or log out/in and prove the same host identity and local journal are
  reused.

## Execute

1. Complete read-only observe and two-snapshot drain verification.
2. Issue one authorization bound to the disposable agent, exact artifacts,
   operator identity, deployment identity, fencing generation, sequence, and
   rollback inventory.
3. Stage and checksum the artifact.
4. Install 0.7.2 and verify the exact process identity.
5. Collect three fresh authenticated heartbeats and compatible capabilities.
6. Run the canonical read-only Project Brain smoke mission.
7. Close with canonical receipts and projection evidence.
8. Repeat with a forced post-mutation failure and verify exact 0.6.8 rollback.
9. Repeat crash points after provider success/before receipt and after receipt
   persistence/before delivery. Prove no duplicate mutation.
10. Restart the operator and Mission Control during recovery. Prove stale
    fencing fails and rollback remains available after forward expiry.

## Destroy

- Revoke the staging credential and host identity.
- Remove staged artifacts, journal, receipts, LaunchAgent, operator, and
  disposable Mission Agent paths.
- Verify no production path, Keychain item, agent identity, or repository was
  touched.
- Destroy or revert the VM to the clean snapshot and record the disposition.
