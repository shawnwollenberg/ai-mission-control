# Disposable KMS conformance permission set

Review-only definitions for the human AWS Identity Center session used by the
Release Authority v2 disposable Ed25519 conformance test. Nothing in this
directory applies itself.

Files:

- `iam-policy.json`: raw inline IAM policy for the permission set.
- `cloudformation.yaml`: permission set and one explicit human assignment.
- `main.tf`: equivalent Terraform resources and assignment.

The policy is fixed to account `661452835066` and Region `us-east-1`.
Post-creation actions require all four resource tags:

- `purpose=release-authority-conformance`
- `environment=disposable`
- `owner=Shawn`
- `cleanup-intent=schedule-deletion-7-days`

Creation is restricted to AWS-generated, single-region
`ECC_NIST_EDWARDS25519`/`SIGN_VERIFY` keys carrying exactly those tag keys.
Signing and verification additionally require `ED25519_SHA_512` and `RAW`.
Deletion can only be scheduled with a seven-day waiting period.

`Resource: "*"` remains only where AWS does not support a narrower resource:

1. `CreateKey`, because the key ARN does not exist yet. AWS documents this as
   required for `kms:CreateKey`.
2. `TagResource` during tagged key creation.
3. `ListAliases`, an account/Region list operation.
4. `cloudtrail:LookupEvents`, which has no resource-level authorization.
5. The final explicit `Deny` using `NotAction`.

IAM cannot enforce a cardinality of exactly one created key. The operator must
create one key, record its ARN immediately, and stop if any second key appears.
The tag restrictions prevent the session from operating on unrelated KMS keys,
but tag-on-create permission should still exist only for this one-hour session.

The explicit `DenyEveryUnrelatedAwsAction` denies every AWS API except the
listed KMS lifecycle and CloudTrail inspection actions. No managed policy is
attached. The assignment must target the exact human Identity Store principal,
and MFA remains an Identity Center authentication-policy responsibility.

Before application, independently review the rendered inline policies from all
three forms and confirm they are semantically identical. Remove the account
assignment and permission set after the disposable key has been disabled and
scheduled for deletion.
