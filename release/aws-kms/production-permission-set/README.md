# Production Release Authority permission sets

These review-only policies derive from the proven disposable-conformance policy.
They do not create an AWS Identity Center permission set or change AWS.

## Bootstrap

Create `MissionAgentReleaseAdmin` with
`bootstrap-admin-policy.json`, no AWS managed policies, a one-hour session, and
assignment to the explicitly approved human Identity Center principal.

The bootstrap policy retains the unavoidable `Resource: "*"` for `CreateKey`
and constrains creation to an AWS-generated, single-region Ed25519 signing key
with exactly these tags:

- `purpose=mission-agent-release-authority`
- `environment=production`
- `authority-version=v2`
- `owner=Shawn`
- `key-id=mission-agent-release-2026-01`
- `rotation-mode=manual-governed`

IAM cannot enforce “create exactly one key.” Create one key, immediately record
its ARN, and stop if another key appears.

The administration session is explicitly denied `kms:Sign`. It may inspect and
verify, configure the key policy, disable the key, and schedule deletion. It
cannot create grants or use unrelated AWS services.

## After key creation

1. Replace `__PRODUCTION_KMS_KEY_ARN__` in
   `steady-state-admin-policy.json` with the exact recorded key ARN.
2. Update `MissionAgentReleaseAdmin` to that policy. This removes
   `kms:CreateKey` and `kms:TagResource` and removes `key/*`.
3. Create a separate production signer role from
   `production-signer-policy.json`, replacing the same placeholder.
4. Put a key policy on the key naming the exact administrator and signer role
   ARNs. The administrator must not sign; the signer must not mutate policy,
   grants, tags, enablement, or deletion state.
5. Validate the effective policies and key policy before assigning the signer.

The account/Region-wide `Resource: "*"` statements that remain are explicit
denies plus `kms:ListAliases` and `cloudtrail:LookupEvents`, APIs that do not
support key-level resource scoping.

No application role, deployment role, worker, Mission Agent, CI principal, or
unrelated developer belongs in either policy or the production key policy.
