# V1 External Staging Rehearsal

This runbook covers only disposable external staging. It is not a production
deployment or canary authorization.

## Required boundary

- Use a dedicated AWS permission set constrained to staging resources. Do not
  use a general administrator session for acceptance.
- Create every dependency in the rehearsal: VPC, subnets, security groups,
  PostgreSQL, ECR, ECS, IAM roles, evidence bucket, deployment-attestation key,
  load balancer, certificate, and secrets.
- Require the `mission-control-v1-staging` prefix and the reviewed disposable
  tags on every supported resource.
- Bind runtime inputs to the exact bootstrap stack outputs and independently
  verify that both database URLs resolve to the disposable database before task
  startup.
- Build from an immutable source archive or detached clean commit and record a
  digest of the complete build context. Environment-provided provenance fields
  are not sufficient evidence by themselves.
- Keep the Mission Agent release-signing key outside the rehearsal. Use a
  separate disposable deployment-attestation key.

## Acceptance order

1. Verify caller, account, region, temporary credentials, and staging-only
   authorization.
2. Record the resource plan, expected cost, dependencies, and teardown order.
3. Create the bootstrap stack and verify exact outputs and tags.
4. Apply migrations to a fresh disposable database and rehearse the supported
   upgrade path.
5. Create runtime and controller roles and prove direct protected-table
   mutation is denied to the runtime role.
6. Build the exact accepted commit twice or from a content-addressed build
   context, compare results, and push only to the staging ECR repository.
7. Verify embedded provenance, OCI digest, ECR digest, and signed provenance
   receipt.
8. Deploy one ECS service task from digest-pinned images.
9. Require all worker diagnostics, task health, target health, and a completed
   single deployment.
10. Complete TLS from an independent client to the exact public endpoint and
    require HTTP 200 from both `/api/health` and `/api/readiness`. The native
    ALB-hostname method uses an imported, run-specific certificate and explicit
    certificate pinning; it proves network reachability, TLS negotiation,
    hostname coverage, and certificate continuity, but it is not public-Web-PKI
    browser trust. Record that limitation in the evidence.
    The in-VPC probe deliberately performs only a leaf-DER pin and reachability
    check. Its evidence is supplemental and cannot satisfy independent TLS
    acceptance.
11. Send an unauthenticated request through the explicitly enabled production
    operator route and require the exact authenticated-route `403`
    `replacement_status_rejected` response. A route-disabled `503` is not
    acceptance.
12. Collect independently verifiable AWS control-plane evidence. A KMS
    signature proves key use, not the truth of self-supplied observations.
13. Proceed to the physical macOS checklist only after the HTTPS and identity
    gates pass.

The staging deployer is used only for CloudFormation, image publication,
database preparation, and assuming the exact run collector. Before collection
or the VPC probe, assume
`arn:aws:iam::<account>:role/mission-control-v1-staging-<run>-collector` from
the deployer session and place those temporary credentials in a distinct
run-scoped collector profile. Pass that collector profile to control-plane,
log, and probe scripts. Never add ECS, ELB, or log read permissions back to the
deployer merely to avoid the handoff.

Any failed external TLS connection is a staging blocker even when ECS task and
target health are green.

## Teardown order

1. Preserve a sanitized, checksummed local evidence bundle.
2. Delete the ECS runtime stack and wait for completion.
3. Delete the bootstrap stack and wait for RDS, networking, workload IAM, ECR,
   versioned S3 data, and S3 bucket
   removal.
4. Delete the imported staging certificate while the restricted deployer still
   exists.
5. Use the separate authority owner to delete the deployment-control stack and
   its deployer, CloudFormation role, boundary, and template bucket.
6. Use the separate authority owner to delete the authority stack, including
   the signer Lambda, signer role, and signer logs.
7. Verify every exact manifest resource identifier is absent.
8. Verify the disposable KMS key is `PendingDeletion` and record its deletion
   date.
9. Run a final run-tag inventory; only the pending-deletion KMS key may remain.
10. Remove clean build worktrees, disposable builders, credentials files, and
    temporary secret material.

The evidence bucket is versioned. The bootstrap stack's reviewed auto-delete
custom resource must remove versions and delete markers before CloudFormation
deletes the bucket; teardown is incomplete unless the exact bucket is absent.
The mandatory teardown path is:

```sh
node --import tsx scripts/teardown-v1-staging.mjs \
  --profile <run-scoped-deployer-profile> \
  --authority-profile wallyweb-sso \
  --region us-east-1 \
  --manifest <bootstrap-manifest.json> \
  --manifest-digest <bootstrap-manifest-sha256> \
  --certificate-receipt <certificate-receipt.json> \
  --output <teardown-evidence.json>
```

Do not replace this with an improvised sequence. Preserve the checksummed
output and the final run-tag inventory.

The run-scoped deployer must have `s3:ListBucketVersions` on the exact evidence
bucket and `s3:DeleteObject` plus `s3:DeleteObjectVersion` on that bucket's
objects. Those permissions exist only for teardown and do not include unrelated
buckets. Teardown is restartable: if a temporary deployment session expires
while CloudFormation is deleting a stack, refresh the same exact run-scoped
role and re-run the command. It waits for an in-progress deletion and treats an
already-absent stack as complete.

## Evidence closure

Before discarding temporary material, preserve:

- a thin Git bundle containing the exact synthetic staging source commit and
  its required accepted base;
- the non-secret KMS public key and independent offline verification results;
- reviewed-versus-live authority template, signer code, and policy digests;
- a safe duplicate-receipt retry and durable-receipt recovery rehearsal;
- ordered teardown and exact-resource zero-residue results; and
- one byte-oriented SHA-256 index covering every retained evidence file.

The bootstrap manifest's canonical semantic digest is distinct from the byte
SHA-256 of its pretty-printed JSON file. Label and retain both; never present
the semantic digest sidecar as a `sha256sum -c` byte digest.
