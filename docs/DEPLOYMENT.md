# Mission Control AWS Deployment

**Environment:** Production  
**Region:** `us-east-1`  
**Canonical URL:** `https://mission.wallyweb.com`  
**Infrastructure:** AWS CDK

## Existing WallyWeb infrastructure discovered

Read-only inspection found that the root WallyWeb site is an S3 origin behind CloudFront with Route 53 DNS. That static pattern cannot run Mission Control's Next.js server routes or preserve its canonical event stream. A separate WallyWeb application already uses the compatible dynamic pattern: ECS Fargate behind an internet-facing Application Load Balancer with Route 53 and ACM in `us-east-1`. The AWS account is already bootstrapped for CDK in that region.

Mission Control does not modify the root website, its CloudFront distribution, its bucket, or any existing application service.

## Selected architecture

- Route 53 alias: `mission.wallyweb.com`
- ACM regional certificate with DNS validation
- Dedicated public Application Load Balancer with HTTP-to-HTTPS redirect
- Dedicated ARM64 ECS Fargate cluster and one desired Next.js task
- Versioned image in a dedicated ECR repository
- DynamoDB on-demand table as the canonical append-only event log
- Secrets Manager generated token for the authenticated Hermes ingestion boundary
- CloudWatch Logs with seven-day retention

This is the smallest architecture matching the existing WallyWeb container pattern while supporting Next.js 16, Node.js 22, API routes, durable events, restarts, HTTPS, health checks, and rollback.

## Event-store constitution

The production table stores only canonical events, mission append metadata, and idempotency markers. Mission Plan, Mission Log, Mission Health, recommendations, approvals, artifacts, and completion remain projections rebuilt from ordered events.

Keys:

```text
PK = MISSION#<missionId>
SK = EVENT#<zero-padded-sequence>#<eventId>
```

Each append uses a DynamoDB transaction containing:

1. An optimistic, conditional mission sequence update.
2. A conditional event put.
3. A conditional mission-scoped idempotency marker.

Concurrent writers retry after a sequence conflict. Repeated event IDs return the already-recorded event. Demo items receive a seven-day TTL; the table has point-in-time recovery and a retained deletion policy. JSONL remains the default local adapter.

## Runtime configuration

Non-secret ECS environment variables:

```text
NODE_ENV=production
PUBLIC_APP_URL=https://mission.wallyweb.com
INTERNAL_AGENT_URL=http://127.0.0.1:3000
DEMO_MODE=true
EVENT_STORE=dynamodb
MISSION_EVENTS_TABLE=mission-control-production-events
ENABLE_LIVE_CODEX=false
AWS_REGION=us-east-1
DEMO_EVENT_TTL_DAYS=7
```

`MISSION_CONTROL_AGENT_TOKEN` is generated in Secrets Manager and injected into the task. It is never stored in source, a Docker layer, or CDK context.

Production intentionally sets `ENABLE_LIVE_CODEX=false`. The bounded Hermes fixture selects the pre-validated fallback, validates it inside the isolated workspace, and publishes `validated_fallback` provenance. No public endpoint exposes a shell, repository path, or arbitrary prompt. Agent event, assignment, and claim endpoints require the secret bearer token.

## Local workflow

```bash
npm ci
npm run typecheck
npm test
npm run build
docker build -t mission-control:local .
docker run --rm -p 3000:3000 -e EVENT_STORE=jsonl -e ENABLE_LIVE_CODEX=false -e MISSION_CONTROL_AGENT_TOKEN=local-development-only mission-control:local
```

The application remains available at `http://localhost:3000`; local events remain under `.mission-control/events` unless `MISSION_CONTROL_DATA_DIR` is set.

## Initial deployment

All AWS commands use the required local profile.

```bash
aws sts get-caller-identity --profile wallyweb
npx cdk deploy MissionControlRegistry -c stage=registry --region us-east-1 --profile wallyweb --require-approval never
```

Build and push an immutable Git commit tag:

```bash
IMAGE_TAG=$(git rev-parse --short=12 HEAD)
aws ecr get-login-password --region us-east-1 --profile wallyweb | docker login --username AWS --password-stdin <repository-host>
docker build --platform linux/arm64 -t mission-control:${IMAGE_TAG} .
docker tag mission-control:${IMAGE_TAG} <repository-uri>:${IMAGE_TAG}
docker push <repository-uri>:${IMAGE_TAG}
npx cdk deploy MissionControlProduction -c stage=app -c imageTag=${IMAGE_TAG} --region us-east-1 --profile wallyweb --require-approval never
```

The registry and application are separate stacks so the versioned image can exist before ECS starts the service.

## Deploying a new version

Run checks, build and push a new commit tag, then deploy the application stack with that tag:

```bash
npm run typecheck
npm test
npm run build
IMAGE_TAG=$(git rev-parse --short=12 HEAD)
aws ecr get-login-password --region us-east-1 --profile wallyweb | docker login --username AWS --password-stdin <repository-host>
docker build --platform linux/arm64 -t <repository-uri>:${IMAGE_TAG} .
docker push <repository-uri>:${IMAGE_TAG}
npx cdk deploy MissionControlProduction -c stage=app -c imageTag=${IMAGE_TAG} --region us-east-1 --profile wallyweb --require-approval never
```

## Health and logs

Public health:

```bash
curl --fail https://mission.wallyweb.com/api/health
```

Service status and recent logs:

```bash
aws ecs describe-services --cluster mission-control-production --services mission-control-web --region us-east-1 --profile wallyweb
aws logs tail /ecs/mission-control-production --since 30m --region us-east-1 --profile wallyweb
```

The health endpoint performs a DynamoDB read in production. ALB health checks require HTTP 200 from `/api/health`.

## Rollback

List immutable images and identify the prior known-good tag:

```bash
aws ecr describe-images --repository-name mission-control --region us-east-1 --profile wallyweb
```

Redeploy that tag:

```bash
npx cdk deploy MissionControlProduction -c stage=app -c imageTag=<prior-tag> --region us-east-1 --profile wallyweb --require-approval never
```

The ECS deployment circuit breaker rolls back failed task deployments automatically. DynamoDB is retained and is independent of application revisions.

## Persistence verification

1. Launch a mission and retain its unguessable mission URL.
2. Refresh during planning, crisis, and post-approval phases.
3. Force a new ECS deployment using the same or a new image tag.
4. Reopen the retained URL and compare the ordered Mission Log and projected state.
5. Submit the same approval twice and verify only one `recommendation.approved` event exists.
6. Launch a second mission in a separate browser context and verify its URL and event stream are independent.

## Hermes connection

Hermes is not deployed as a public shell-execution service. A trusted Hermes runtime connects through HTTPS using the agent token:

```text
POST /api/agent-events
GET  /api/agents/hermes/assignments?missionId=<id>
POST /api/tasks/<taskId>/claim
Authorization: Bearer <token>
```

The token should be retrieved from Secrets Manager only by an authorized operator or runtime. Browser users never receive it.

## Forced fallback mode

Fallback is the production default. Confirm the ECS task definition contains:

```text
ENABLE_LIVE_CODEX=false
```

The UI must display `Verified fallback artifact` for fallback artifacts. Do not change provenance to `live` unless a real AWS-compatible Codex worker has passed repeated rehearsals.

## Video

The promotional MP4 remains a repository artifact for now. It is not served from the application container. S3/CloudFront video delivery is intentionally deferred because it is not required for the reliable interactive deployment.

## Known limitations

- One Fargate task is used for hackathon reliability and cost. DynamoDB safely supports multiple tasks later.
- There is no end-user authentication; isolation relies on unguessable mission IDs and mission-scoped commands.
- Demo data expires after seven days.
- Live Codex execution is disabled in the public runtime.
- Replay remains hidden and is not part of this deployment.

## Estimated recurring cost

At continuous operation, the dedicated ALB and one small Fargate task are expected to dominate at roughly USD $30–$40 per month, depending on hours, region pricing, and traffic. DynamoDB, Route 53 queries, ECR storage, Secrets Manager, and CloudWatch should remain low for hackathon traffic. Stopping the ECS desired count after judging reduces compute cost, but the ALB continues to incur charges until the stack is removed.
