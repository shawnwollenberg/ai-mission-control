# Mission Agent 0.7.0 KMS ceremony package

This package is unsigned. Possession of it contains no AWS credentials and is
not signing, trust-activation, or publication authority.

1. Obtain separate authorization to create the KMS key and signer role.
2. Create an `ECC_NIST_EDWARDS25519`/`SIGN_VERIFY` KMS key.
3. Generate the pending record with
   `mission-agent:release:kms-key-record`.
4. Verify source, version, artifact checksum, DER-SPKI fingerprint, and policy.
5. Deploy the public trust record as `pending` through a separately approved
   Mission Control change.
6. Activate it only through a distinct authenticated approval.
7. Sign only after trust activation and all publication gates pass.

The included verifier contacts no AWS service and does not create a key, sign,
activate trust, or publish.
