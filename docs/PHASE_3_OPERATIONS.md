# Phase 3 Policy and Publication Operations

```bash
nvm use
node --version
npm run runtime:check
```

Node 22.20 or newer within major 22 is mandatory. Run PostgreSQL migrations/seed, then start the four processes separately:

```bash
npm run dev
npm run worker
npm run worker:codex
npm run worker:actions
```

The generic worker expires approvals and coordinates internal jobs. The Codex worker owns isolated implementation. The action worker alone revalidates policy and approval before a Git provider effect. It needs `CODEX_WORKTREE_ROOT`; GitHub repositories use an owner-configured `providerConfigurationReference` such as `local-config:/path/to/.config/gh`. Store only the reference. Never place token values in the registry, events, prompts, artifacts, or logs.

Use `/approvals` for owner decisions and `/audit` for canonical governance history. Push approval binds repository, execution, generated branch, exact commit, remote, and remote branch. Pull-request approval is separate and requires a confirmed matching push. A changed commit, parameters, target, expiry, consumed approval, scoped restriction, or policy outcome stops execution and requires a new request where applicable.

The action worker never force-pushes. Matching existing remote state is an idempotent success; a conflicting branch requires human review. GitHub PR creation queries for an existing matching PR before creation and records a URL only after provider confirmation. Merge and deployment have no executor.

Projection recovery is effect-free:

```bash
npm run projections:verify
npm run projections:rebuild -- --workspace <workspace-uuid>
npm run projections:verify
```

Disable publication by stopping `worker:actions` or disabling scoped policy/repository capabilities. Rollback is application rollback plus a compatible forward migration; do not delete canonical events or remote branches automatically.
