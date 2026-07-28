# Mission Control V1 ECS Deployment

This is implementation support for the owner-controlled v1 rollout. It is not
an authorization to deploy.

## Runtime shape

`MissionControlV1EcsStack` creates one Fargate service with desired count one
and one task definition containing:

- the web container;
- the generic worker;
- the dedicated Project Brain worker;
- the remote Mission Agent delivery worker.

Every image reference is an ECR digest. The service deployment configuration
stops the prior task before starting its replacement so the v1 single-controller
assumption is not violated. The tradeoff is a short cutover interruption. An
Application Load Balancer supplies HTTPS and health checks. PostgreSQL and the
artifact bucket remain external, explicitly supplied dependencies.

The task role can list only the `production/v1/` artifact prefix and get or put
objects only below that prefix; it has no delete permission. Because ECS task
roles are task-wide, all four containers share that narrow owner-only v1
prefix. Splitting web and worker credentials requires a later multi-task
topology. The task cannot
read ECS control-plane state or sign its own attestation. The execution role
pulls images, writes logs, and reads only the two named Secrets Manager secrets.
No deployment, IAM, RDS administration, KMS signing, or generic AWS
administration is granted to the task.

## Trusted build inputs

The production Docker build requires:

```text
MC_SOURCE_COMMIT
MC_SOURCE_STATE=clean
MC_BUILD_TIMESTAMP
MC_BUILDER_IDENTITY
MC_REPOSITORY_IDENTITY
```

`generate-v1-build-provenance.mjs` records those values with the lockfile
digest, deterministic standalone-bundle digest, production contract version,
and database compatibility range 0028–0030. The record is copied into the
runtime image at:

```text
/app/mission-control-build-provenance.json
```

A dirty or local build may be produced for disposable testing only and remains
identified as `sourceState=dirty`. Production acceptance requires a clean
source state and an ECR digest recorded after the push. The OCI image digest
cannot be embedded in its own bytes; ECS/ECR control-plane evidence binds it to
the separately embedded provenance digest.

## Independent identity evidence

The owner-side `collect-v1-ecs-control-plane-evidence.mjs` command reads:

- STS caller identity;
- ECS service, deployment, task, and task-definition state;
- the exact one running task;
- ECR presence of the task's digest;
- task and execution roles;
- configuration, application commit, and build digest from the registered task
  definition.

It compares those facts with an independently reviewed expectation file, then
signs the canonical evidence using the dedicated deployment-attestation KMS
key. The Mission Agent release-signing key must not be used for this purpose.
The command verifies the new signature before writing its mode-0600 receipt.
Evidence expires after five minutes. The expected identity file and KMS key are
owned by the operator-side release process, not by the ECS task.

The collector requires the exact four-container name, command, essential flag,
repository, and digest map. Each distinct digest must exist in ECR and have a
separately signed image-provenance receipt. That receipt is created only after
the release tool extracts the embedded provenance from the built image with
networking disabled, verifies a clean production build and expected commit, and
binds that record to the final ECR digest. The expected identity pins the
deployment-attestation key ARN and the Mission Agent release-key ARN; the two
must differ.

Evidence is issued only in steady state: one completed PRIMARY deployment, zero
pending tasks, one RUNNING and HEALTHY task, and the exact task private IP
reported healthy by the ALB target group. An old task during replacement cannot
be attested.

The validator fails closed for:

- a wrong image digest, task definition, service, or cluster;
- stale evidence;
- configuration or application-commit drift;
- build-identity contradiction;
- zero or more than one running task.

Environment variables and mounted files are diagnostic claims only. They do
not override AWS control-plane evidence.

## CDK synthesis

The stack is selected with `-c stage=v1-ecs` and requires explicit values for:

```text
vpcId
availabilityZones
publicSubnetIds
webImageDigest
projectBrainImageDigest
databaseSecretArn
runtimeSecretArn
artifactBucketName
certificateArn
productionConfigurationDigest
applicationCommit
buildIdentityDigest
```

Synthesis is safe and non-mutating. Deployment remains a separate human gate.
The first production authorization must cover only non-mutating ECS deployment
and read-only identity/database preflight. It must not authorize migration 0030
or canary replacement.

## Rollback boundary

Until ECS cutover is explicitly accepted, the current EC2/Docker deployment
remains the application rollback target. DNS or upstream traffic must be moved
back to the known EC2 endpoint; migration 0030, once separately applied, is
additive and is not destructively rolled back.
