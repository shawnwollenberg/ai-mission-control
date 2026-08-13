# AWS KMS Release Authority v2 configuration

These files are review-only templates. They create no AWS resources and grant
no permissions by themselves.

Replace every `__PLACEHOLDER__` only during an explicitly authorized AWS
change. The release key must be an asymmetric
`ECC_NIST_EDWARDS25519`/`SIGN_VERIFY` key. The exact key ARN, never an alias or
wildcard, must replace `__KMS_KEY_ARN__`.

- `release-signer-permissions.json`: attach only to the dedicated,
  human-assumed release signer role.
- `release-signer-trust-policy.json`: constrain role assumption to the
  approved AWS IAM Identity Center permission-set role.
- `kms-key-policy.json`: complete key policy. Do not merge it with default
  root-delegation statements. The exact signer is the sole principal permitted
  to sign; root and the separate administrator can administer but not sign.
- `pending-key-record.template.json`: documents the incomplete record shape.
  It is deliberately rejected until generated from `GetPublicKey`.
- `trust-activation-evidence.template.json`: a separately approved, deployed
  activation record required by the signer. A pending record alone cannot sign.
- `disposable-conformance-permission-set/`: raw IAM, CloudFormation, and
  Terraform review-only definitions for the narrowly scoped live conformance
  session.

No production application role, worker role, deployment role, Mission Agent,
Project Brain process, ordinary developer role, or CI builder may assume the
signer role or receive `kms:Sign`.
