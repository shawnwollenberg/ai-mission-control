# Internal Worker Operations

Set `DATABASE_URL`, migrate the database, then run:

```bash
npm run worker
```

Optional settings are `WORKER_ID` and `WORKER_POLL_MS`. Logs are structured JSON containing worker, job, correlation, completion, and failure identifiers.

Stop with `SIGTERM` or `SIGINT`. Jobs are leased in PostgreSQL; a process restart recovers pending work and claims whose lease expired. Failed jobs use bounded exponential backoff and move to `dead_letters` after their maximum attempts.

This worker handles only internal outbox delivery and deterministic `simulated` task jobs. It must not be configured as an external-agent runner.

Replay and verification:

```bash
npm run projections:rebuild
npm run projections:rebuild -- --workspace <workspace-id>
npm run projections:rebuild -- --projection missions
npm run projections:rebuild -- --projection tasks
npm run projections:verify
```

Legacy import:

```bash
npm run legacy:import-dynamodb -- --dry-run --fixture fixtures/legacy-dynamodb/captured-mission.json --workspace <workspace-id>
```
