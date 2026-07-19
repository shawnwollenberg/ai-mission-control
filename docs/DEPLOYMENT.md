# Mission Control AWS deployment

**Environment:** Production

**Region:** `us-east-1`

**Product URL:** `https://missioncontrol.wallyweb.com`

**Application URL:** `https://app.missioncontrol.wallyweb.com`

**Infrastructure:** AWS CDK

## Architecture

The current deployment intentionally favors low cost and operational clarity over horizontal scale:

- one ARM64 `t4g.small` EC2 instance;
- a Next.js web container;
- a PostgreSQL 16 container on encrypted persistent gp3 storage;
- a Caddy container for automatic HTTPS and reverse proxying;
- a versioned, encrypted S3 artifact bucket;
- ECR for immutable application images;
- Secrets Manager for the bootstrap owner credential;
- Systems Manager for administration, with no SSH ingress;
- Route 53 A records for the product and application domains.

There is no RDS database, load balancer, ECS service, or multi-instance application tier. The retained legacy DynamoDB table is not part of the current runtime authority.

PostgreSQL stores the canonical append-only event log, commands, projections, authentication state, jobs, schedules, notifications, and governance records. Application state must remain reconstructable from canonical events except for explicitly ephemeral UI state.

## Permanent safety boundary

Mission Control agents may not autonomously deploy, merge, modify infrastructure or secrets, sign transactions, or submit transactions. A human-approved release of Mission Control itself is a development activity outside that agent capability boundary.

## Required local tools

- Node.js 22
- Docker with ARM64 build support
- AWS CLI authenticated to the target account
- AWS CDK

The examples below use the local `wallyweb` profile. Replace account-specific repository values when deploying elsewhere.

## Validate and build

```bash
npm ci
npm run runtime:check
npm run typecheck
npm test
npm run build

IMAGE_TAG=$(git rev-parse --short HEAD)
AWS_PROFILE=wallyweb AWS_REGION=us-east-1 aws ecr get-login-password \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker buildx build --platform linux/arm64 \
  -t <account>.dkr.ecr.us-east-1.amazonaws.com/mission-control:${IMAGE_TAG} \
  --push .
```

## Deploy

```bash
AWS_PROFILE=wallyweb \
AWS_REGION=us-east-1 \
CDK_DEFAULT_ACCOUNT=<account> \
CDK_DEFAULT_REGION=us-east-1 \
npx cdk deploy MissionControlProduction \
  -c imageTag=${IMAGE_TAG} \
  --require-approval never
```

EC2 user data performs the initial database migration, owner provisioning, and container startup. Updating EC2 user data does not automatically replay it on an existing instance; the operator must explicitly run the current bootstrap through Systems Manager or replace the instance after reviewing the change.

## Health and readiness

```bash
curl --fail https://app.missioncontrol.wallyweb.com/api/health
curl --fail https://app.missioncontrol.wallyweb.com/api/readiness
```

Health proves the web process can reach PostgreSQL. Readiness validates the production configuration, current schema, secret handling, and artifact configuration.

Inspect the host without opening SSH:

```bash
aws --profile wallyweb --region us-east-1 ssm send-command \
  --instance-ids <instance-id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker ps"]'
```

## Owner access

The generated bootstrap secret is never printed by the application or stored in source:

```bash
aws --profile wallyweb --region us-east-1 secretsmanager get-secret-value \
  --secret-id mission-control/production/bootstrap \
  --query SecretString \
  --output text
```

The initial production workspace owner is `admin@wallyweb.com`. Every self-service registration creates an isolated personal workspace, assigns that user its `owner` role, seeds its starter Mission Templates, and appends structured workspace and owner-registration events.

## Rollback

Application images are tagged with Git commit IDs. To roll back, choose a known-good ECR image tag, deploy the stack with that `imageTag`, then deliberately restart the web container using the reviewed bootstrap procedure. Database migrations are forward-only; review schema compatibility before rolling application code backward.

The root EBS volume is encrypted and configured not to be deleted with the instance. The S3 artifact bucket is versioned and retained. These protections reduce accidental data loss but require intentional cleanup when retiring the environment.

## Cost posture

The deployment is designed to remain in the low tens of US dollars per month at light traffic. The main recurring costs are the `t4g.small` instance, public IPv4 address, 24 GB gp3 volume, Route 53, and one Secrets Manager secret. S3, ECR, and Systems Manager usage should remain small until traffic or artifact volume grows.

Scale only when observed load requires it. A future production tier can move PostgreSQL to a managed database and add multiple web instances without changing the event-sourced domain model.
