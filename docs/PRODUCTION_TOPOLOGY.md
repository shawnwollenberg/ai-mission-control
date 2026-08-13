# Authoritative production topology

Last reconciled: 2026-08-13 for Runtime-v6 release
8a210b2ce26555e19f2c585f6281017ae8fbec3c.

## Control planes

CloudFormation stack MissionControlProduction owns the EC2 host, launch
template, instance role/profile, security group, Elastic IP and association,
Route 53 records, encrypted artifact bucket and policy, and bootstrap secret.
The stack is UPDATE_ROLLBACK_COMPLETE, is eligible for a normal update, and its
2026-08-13 drift check reported IN_SYNC. It does not continuously reconcile
Docker containers after EC2 user data has run.

Application promotion is an operator-controlled SSM/Docker workflow on EC2
instance i-0f9f584fddf6be617. The checked-in deploy/production-compose.yml is
the target application-service definition. Deployments use ECR digests; tags
are discovery labels only.

## Current topology before Runtime-v6

| Component                            | Control plane                        | Current immutable image                                                                 | Purpose and dependencies                                                                     |
| ------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| mission-control-web                  | SSM/Docker                           | mission-control@sha256:e7db1957073c3d87775eeb05a29ecb25ba35098b37c2fbe454b2049277d8d020 | Routed Next.js application; PostgreSQL and S3; Caddy upstream                                |
| mission-control-generic-worker       | SSM/Docker                           | mission-control@sha256:cc15f758386b912ba04e660d1e087d8d07831d5509fe27812e445e230e44cbab | Generic leased jobs; PostgreSQL                                                              |
| mission-control-action-worker        | manual SSM/Docker legacy             | locally resolved image for source 423947158b11f0654b752c47a95b5750ae539204              | Approval-gated action jobs; PostgreSQL                                                       |
| mission-control-project-brain-worker | SSM/Docker                           | mission-control@sha256:362ea4df067a55eaae0d42cc4de3c0f5d4f38bcb320013181f49fc7bf41d08d9 | Independently packaged Project Brain 0.4.0 worker; PostgreSQL, S3, read-only repository bind |
| mission-control-web-ma072            | manual SSM/Docker canary             | mission-control@sha256:c01a64219adf0e315cc597e84ed9b89cab55c9e8939548d3240a647982c74d5d | Unrouted, no-restart historical Mission Agent 0.7.2 compatibility canary                     |
| mission-control-postgres             | CloudFormation bootstrap then Docker | postgres:16.4-bookworm (sha256:902c76d...)                                              | Canonical production database on /opt/mission-control/postgres                               |
| mission-control-caddy                | CloudFormation bootstrap then Docker | caddy:2.10-alpine (sha256:8f5619a...)                                                   | Ports 80/443; routes both production domains only to mission-control-web:3000                |

Exited rollback/failed containers are retained diagnostic evidence and are not
running services. There is no ECS service. Docker is the only host supervisor;
all running production containers except the canary use unless-stopped.

The heterogeneous application images are the result of sequential historical
manual promotions. They are not an intended compatibility architecture. Web,
generic worker, and action worker are built from the same repository and move
together for Runtime-v6. Project Brain is independently packaged and remains on
its verified digest. PostgreSQL, Caddy, and the unrouted canary are unchanged.

## Runtime-v6 target and ordering

Runtime-v6 application source is merge SHA
8a210b2ce26555e19f2c585f6281017ae8fbec3c. Its ARM64 ECR image is deployed by
immutable digest to web, generic worker, and action worker.

1. Record all pre-deploy container digests and the green public health baseline.
2. Require zero active executions, pull assignments, and queued/running jobs.
3. Create a timestamped logical PostgreSQL backup.
4. Stop web, generic worker, and action worker so protocol traffic is drained.
5. Wait until no unexpired legacy protocol receipt can block migration 0029.
6. Run the exact target image guarded production migration command. Only
   migrations 0029, 0030, and 0031 are expected.
7. Preserve old containers under release-specific rollback names.
8. Start generic and action workers from the target digest, validate their
   production configuration and process presence, then start the web.
9. Require internal and public health/readiness before accepting the rollout.
10. Run non-destructive authenticated smoke checks and confirm no restart loop.

Caddy and PostgreSQL remain running. The Project Brain worker is independently
versioned and remains running. The unrouted canary remains documented legacy
state and must not be used as a production endpoint.

## Runtime-v6 deployment result

Runtime-v6 was promoted on 2026-08-13 from exact application source
`8a210b2ce26555e19f2c585f6281017ae8fbec3c`. Web, generic worker, and
action worker now run the immutable ECR digest
`sha256:2fd754869f5b6e3a93a9a7cf4283175df3676104afee13cc9de85069acc1a58b`.
The image records the same source revision. Project Brain, PostgreSQL, Caddy,
and the unrouted 0.7.2 canary retained their pre-release digests.

The host has Docker Engine but no Compose CLI/plugin. The checked-in Compose
file remains the declared target topology; this release used equivalent
digest-pinned `docker run` commands through SSM after validating the target
worker configuration. The previous web, generic-worker, and action-worker
containers are stopped and retained under release-specific rollback names.
The production environment gained the documented non-secret
`GIT_PROVIDER=github` setting required by the action-worker readiness gate.

The database was quiesced before migration. A custom-format logical backup was
sealed at
`/opt/mission-control/backups/pre-runtime-v6-8a210b2-20260813.dump` with
SHA-256
`e75d3de43cb6c6f6944760748811a2bceea22bfe7f299a1ff047312425a36031`.
Migrations 0029, 0030, and 0031 passed first against a disposable restored
database and then against production; the production ledger has 31 applied
migrations and zero pending.

Post-promotion evidence includes both public health/readiness endpoints,
authenticated owner/session and protected-route checks, action/generic
configuration readiness, zero container restarts, encrypted artifact-storage
put/head/get/checksum/delete, existing Mission Agent registration and heartbeat
compatibility, repository projection reads, a completed mission read, Consensus
Plan route/schema availability, and a healthy independently versioned Project
Brain worker with successful durable operations. The signed public
`mission-agent-latest.json` remains version 0.7.2. Mission Agent 0.8 production
publication and onboarding require their own signed release-authority step;
the unsigned/disposable Runtime-v6 acceptance artifact must not be represented
as a production release.

## Rollback

Application rollback restores each renamed pre-deploy web/generic/action
container with its exact recorded image and environment. Migrations are
forward-only; 0029-0031 are retained when application rollback is
schema-compatible. No destructive down migration is part of routine rollback.
If the new web or workers cannot start or health/readiness fail, stop and retain
the new containers, restore the old names, start them, and verify both public
endpoints. Caddy, PostgreSQL, and Project Brain are not replaced.

## Follow-up infrastructure backlog

- Consolidate application promotion into one declared, digest-pinned Compose
  control plane, install/pin its execution tooling on the host, and add
  deploy/rollback automation.
- Publish Mission Agent 0.8 through the governed signed production release
  process, update the signed latest manifest, and onboard production
  capability attestations before running a real production Consensus Plan.
- Decouple the artifact-storage smoke from Codex-worker configuration (or
  provide a process-specific runner) so the documented smoke command is
  directly runnable on the reconciled web/action/generic topology.
- Retire the unrouted mission-control-web-ma072 canary after a separate
  evidence-retention decision.
- Remove exited historical containers under a separately approved cleanup.
- Reconcile EC2 user data with the post-bootstrap Compose topology without
  replacing the production host during an application release.
- Add immutable digest metadata for every independent Project Brain build.
