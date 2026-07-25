# Offline Mission Agent release-key ceremony

Codex, CI, Mission Control, and application environments must not perform this
ceremony or receive its private-key material.

## Human-operated creation

On an offline, approved system, an authorized custodian should:

1. Generate an Ed25519 private key with an approved offline cryptographic tool.
2. Derive the DER SPKI public key and calculate
   `ed25519-spki-sha256:<sha256-of-DER-SPKI>`.
3. Assign `mission-agent-release-2026-01`.
4. Encrypt the private key into the approved primary offline custody medium.
5. Create a separately encrypted offline backup.
6. Decrypt the backup and derive its public fingerprint; confirm it matches.
7. Have a second person compare the two public fingerprints where practical.
8. Complete the checklist below and export only the public SPKI, fingerprint,
   key ID, and non-secret ceremony receipt.

Exact tool commands belong in the restricted human ceremony procedure because
copying them through an agent session risks accidental private-key disclosure.
The repository sign tool consumes an existing key; it never generates one.

## Custody checklist — human completion required

- [ ] Primary custodian: `<human-entered>`
- [ ] Backup custodian: `<human-entered>`
- [ ] Primary offline storage class and media ID: `<human-entered>`
- [ ] Separate backup storage class and media ID: `<human-entered>`
- [ ] Encryption method and parameters: `<human-entered>`
- [ ] Backup decrypt-and-fingerprint test completed: `<human-entered>`
- [ ] Signing approval quorum: `<human-entered>`
- [ ] Recovery procedure exercised: `<human-entered>`
- [ ] Emergency revocation approver and channel: `<human-entered>`
- [ ] Rotation cadence and next review date: `<human-entered>`
- [ ] Creation time and approving actors: `<human-entered>`

Trust activation is blocked until every item is completed in the restricted
audit system. No secret, device unlock value, recovery phrase, or private-key
byte belongs in this repository.

Key loss immediately blocks signing and starts a custody investigation.
Suspected compromise additionally blocks publication and requires an
authenticated application trust-store revocation release.
