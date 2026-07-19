# Phase 6 Controlled Deployment Procedure

## Blueprint impact

Syncing `render.yaml` will create or change exactly eight Render services: one public web service and seven background workers. It disables auto-deploy, selects branch `production`, defines process-specific variables, and attaches a 10 GB persistent disk only to Codex. It references—but does not create—`mission-control-production` PostgreSQL. The human must select region and instance plans before sync. No Blueprint sync is authorized until all provider inputs are resolved.

## Release and rollout

1. Human creates/selects Render workspace, PostgreSQL/PITR, R2 bucket, domain/DNS, monitor, notification destination, region, plans, and scoped credentials.
2. Verify Node 22.20+, exact release commit, clean tree, Render/R2 resources, private DB connectivity, and secret names.
3. Run `ALLOW_PRODUCTION_MIGRATIONS=MISSION_CONTROL_PRODUCTION npm run production:migrate`; require configuration, checksum, lock, transactional migration, and zero pending migrations.
4. Pipe a 16+ character owner password to `PRODUCTION_CONFIRMATION=PROVISION_MISSION_CONTROL_OWNER npm run production:provision-owner`; verify `production.owner.provisioned`. Remove provisioning-only variables.
5. Set `PRODUCTION_CONFIRMATION=VALIDATE_MISSION_CONTROL_ARTIFACTS` only for `npm run production:validate-artifacts`. It uploads beneath `production/smoke`, verifies encryption metadata, retrieves/checksums, and deletes the object in a `finally` path. Durable execution artifacts use `production/<workspace>/<execution>/...`.
6. Manually deploy web from the exact release commit. Verify `/api/health`, `/api/readiness`, TLS, secure/HTTP-only/SameSite cookies, login/logout, CSRF, protected routes, security headers, and Operations.
7. Start generic, action, remote delivery, scheduler, notification, Hermes, then Codex. Verify identity, heartbeat, intended job type, and SIGTERM behavior individually.
8. Configure the independent HTTPS monitor and one external notification destination; test delivery and scan logs for credential patterns.
9. Register a new Hermes credential, signed heartbeat, explicit capability/resource grants, rotate once, revoke old, and prove immediate rejection.
10. Onboard one noncritical repository. Verify read/worktree/test/local commit; separate push/PR approvals; merge/deployment denial.

Rollback uses the last Phase 5 commit `f137291` only if it is schema-compatible. Migration `0018` is additive and artifact reads remain compatible with existing `local` rows. Do not roll back database schema destructively; stop new work, deploy the known-good application commit, and preserve events/projections for diagnosis.
