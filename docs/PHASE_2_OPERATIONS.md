# Phase 2 Codex Operations

Phase 2 runs the web application, generic coordinator worker, and Codex worker as separate processes. The Codex worker needs PostgreSQL access, the Codex CLI, and filesystem access only to explicitly configured repository, worktree, and artifact roots.

## Local startup

1. Set `DATABASE_URL`, owner authentication variables, `CODEX_EXECUTABLE`, `CODEX_REPOSITORY_ROOT`, `CODEX_WORKTREE_ROOT`, and `ARTIFACT_STORAGE_ROOT`.
2. Run `npm run db:up`, `npm run db:migrate`, and `npm run db:seed`.
3. Start `npm run dev`, `npm run worker`, and `npm run worker:codex` in separate terminals.
4. Sign in, open `/agents`, register a Codex worker, and register an allowlisted repository through the application registry command/API.
5. Dispatch a bounded task with `npm run execution:run-codex -- --workspace <workspace-id> --mission <mission-id> --task <task-id> --agent <agent-id> --repository <repository-id>`.

`npm run phase2:acceptance:setup` creates the controlled health-metadata fixture used by acceptance testing. It prints the IDs and environment paths needed by the workers.

## Recovery and evidence

Jobs use leases. A restarted worker reclaims an expired job, reuses the persisted worktree, recognizes an execution-owned existing commit, and stores artifacts idempotently. Terminal redelivery is a no-op. Cancellation is durable and causes the worker to terminate its controlled child process on the next heartbeat poll. Timeouts and failures retain the worktree and artifacts for review.

Operators can inspect execution state in the mission page and agent detail page. Artifact metadata is workspace-scoped and each object is verified by SHA-256 before use. Run `npm run projections:verify`; use `npm run projections:rebuild -- --workspace <workspace-uuid>` for a controlled rebuild, then verify again.

## Safety boundary

Repository paths come only from the owner-managed registry and must resolve beneath `CODEX_REPOSITORY_ROOT`. The runner uses argument arrays, a fixed executable, a minimal environment, output limits, cancellation, and timeout. Repository policy allows only the declared read/write/test/local-commit actions. Push, merge, deployment, arbitrary repository paths, destructive operations, and secrets are unavailable. Production should use a dedicated worker identity and container with separate mounted worktree/artifact volumes and no inbound public endpoint or deployment credentials.
