# Durable Browser Mission Operations

**Status:** Phase 1 durable browser slice

## Local setup

Use Node 22 and run the browser locally through the development server. Production builds intentionally mark the session cookie `Secure` and therefore require HTTPS; do not use the standalone production server over plain HTTP for interactive login.

```bash
nvm use
npm run db:up
npm run db:migrate
npm run auth:hash -- 'choose-a-local-password'
```

Set `DATABASE_URL`, `PUBLIC_APP_URL=http://127.0.0.1:3000`, `MISSION_CONTROL_OWNER_EMAIL`, `MISSION_CONTROL_OWNER_NAME`, `MISSION_CONTROL_OWNER_PASSWORD_HASH`, and a 32-or-more-character `MISSION_CONTROL_SESSION_SECRET`. Then:

```bash
npm run db:seed
npm run dev
```

The seed is idempotent and never replaces an existing credential hash. To intentionally rotate the owner password, use a separately reviewed credential-rotation operation; do not expect `db:seed` to mutate it.

## Durable request sequence

Mission creation and lifecycle commands use this transaction:

1. Validate the session, origin, request body, workspace membership, and idempotency key.
2. Load and rehydrate workspace-scoped aggregate events.
3. Decide the transition through the Mission aggregate.
4. Lock and verify the aggregate head at the expected version.
5. Append canonical event(s).
6. Update the critical mission projection.
7. Insert event-linked outbox message(s).
8. Complete the command record and commit once.

Mission list/detail pages read `mission_projections`. The safe timeline query reads workspace-scoped events and maps them to allowlisted labels and summaries. React owns only pending/error display; it does not decide canonical state.

## Manual acceptance walkthrough — completed 2026-07-18

The approved walkthrough was executed in the in-app browser against PostgreSQL 16:

1. Logged-out access to `/` and mission detail redirected to `/login` with a safe internal return target.
2. Seeded owner login opened the launch page.
3. Created `Production Mission Persistence Test`; the detail page showed aggregate version 1 and `Mission created`.
4. Planned, started simulated execution, and paused through explicit server commands.
5. Refreshed and restarted the Next.js development server; paused version 4 and all four events remained.
6. Resumed and completed; the terminal projection reached version 6 and the timeline contained six PostgreSQL events.
7. Mission archive showed the completed projection without loading its events.
8. Logout cleared access; direct mission navigation redirected to login.
9. Re-login returned to the same completed mission with all six events.

The UI labels the mode `Simulated execution` and states that no connected agent is running. Browser timers, `/advance`, `/approve`, and the legacy mission console are absent from the durable path.

## Remaining legacy compatibility

`lib/event-store.ts`, `lib/dynamodb-event-store.ts`, the legacy event types/projector, agent fixture routes, and their tests remain for the later one-way DynamoDB import and compatibility slice. They are not reachable from mission launch, list, detail, timeline, or lifecycle navigation. Remove them after import compatibility and the task/demo migration are complete.
