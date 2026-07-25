# Mission Agent 0.7.0 offline ceremony package

This directory contains only public release inputs and human instructions. It
contains no private key and is not signing or publication authority.

The authorized human must:

1. Move this package to an approved offline system.
2. Generate Ed25519 key material offline.
3. Store the private key in encrypted primary custody.
4. Create an independently stored encrypted backup and verify recovery.
5. Record primary and backup custodians in the restricted custody record.
6. Derive the DER SPKI public key and its
   `ed25519-spki-sha256:<lowercase-sha256>` fingerprint.
7. Return only the public key, fingerprint, completed non-secret custody
   approval, and ceremony receipt.
8. Retain all private material offline.
9. Wait until production Mission Control trusts the returned public key.
10. Only then sign the exact canonical manifest after explicitly confirming
    checksum `3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e`.

Do not run signing or key-generation commands through Codex, CI, chat,
application environments, or network-connected release hosts.
