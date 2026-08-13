# Final Project Brain release acceptance

Date: 2026-07-24
Target: Mission Control `production`
Candidate branch: `codex/project-brain-final-release-candidate`

## Included releases

Project Brain:

- `5d80c89` — approved consumer initialization
- `09cae94` — governed consumer-write hardening

Mission Control:

- the validated Project Brain adapter series from `8c3d988` through
  `e2f1b54`;
- `3aaf190` — remote Mission Agent Project Brain transport;
- `bc76aff` — isolated Next.js/sharp security maintenance;
- `21bfd9c` — combined-acceptance repairs and reproducible local harness.

The final candidate was assembled by cherry-picking those changes onto
`production` at `6a630b9`. It was not assembled through the dirty primary
checkout.

## Dependency maintenance

The dependency-only branch is `codex/next-sharp-security` at `bc76aff`.
Next.js moved from `16.2.10` to the smallest patched Active LTS version,
`16.2.11`. The matching `eslint-config-next` resolution is `16.2.11`. An npm
override moves transitive sharp from `0.34.5` to the first patched version,
`0.35.0`, which carries libvips `8.18.3`.

This resolves the nine July 2026 Next.js advisories listed in
`NEXT_SHARP_SECURITY_MAINTENANCE.md` and sharp
`GHSA-f88m-g3jw-g9cj` (`CVE-2026-33327`, `CVE-2026-33328`,
`CVE-2026-35590`, and `CVE-2026-35591`). The production dependency audit no
longer reports Next.js or sharp.

The remaining npm audit findings are development-only
ESLint/minimatch/brace-expansion findings. npm proposes an ESLint 10 major
upgrade; that unrelated major update is not included in this runtime security
patch.

## Combined lifecycle evidence

### Local repository

The reproducible command is `npm run acceptance:project-brain:local`. It used
the governed server-repository command path, a real Codex execution in an
isolated worktree, and the installed Project Brain CLI.

```text
initial SHA:       9ffa8619b8cd0a41bb4a2540cfce87029ab86cac
initialized SHA:   07f3d5f7dc0725576aacf9265b7c2bca6cff6109
context SHA-256:   52f805210c999ec0f2842e623972f5c7f7633b5f84106c36a0b1c6372d94ce4f
context bytes:     4627
code commit:       bb790175614c4527a1fbbd6e97c9970c7b753f7c
final brain SHA:   1d7fd840beb826ab5c4cf26691c0b2350b3eea9a
projection replay: equal, 71 events, no discrepancies
```

The immutable artifact checksum, Mission Control binding, agent-received
checksum, and agent-verified checksum were byte-identical. The isolated commit
adds the requested health-response field and its test; the test passed.
Closure is `recorded`, learning is `proposed`, evaluation is `evaluated`, and
confirmed learning counts are zero in both Git and Mission Control.

Combined acceptance found and repaired two local-path defects before this
successful run:

- worker fingerprint recomputation now includes local
  `artifactVersioning: false`;
- context-binding idempotency text is converted to a deterministic UUID before
  entering the UUID-typed event store.

### Remote repository

The reproducible command is `npm run acceptance:project-brain:remote`. It used
the production build, pull-mode Mission Agent `0.6.7`, installed Project Brain
CLI, signed remote transport, live reauthorization, and real Codex execution.

```text
initial SHA:       4e909f19ad9fb877f94a7ca7154b2f013ab5bcad
code starting SHA: 2baff0046e726dd21cafee6ed198bde5586622e7
code commit:       7f1ac5edefec3f0f0d16df2348e33fd2a050a0d9
closure SHA:       2c38f5b2c3f7e8dc35c0ea072b5ee79184e87fdd
context SHA-256:   c153375e994498d90ae02f1168f01d08bcb247a8067a8ead81f07116c417ae2f
context bytes:     3888
artifacts:         30
Project Brain events: 79
projection replay: equal, 151 events, no discrepancies
```

The stored artifact, dispatched bytes, agent-received checksum, and
agent-verified checksum were identical. Closure, proposed learning, and
evaluation completed. The inbox contained the proposal and evaluation only;
confirmed learning counts remained zero.

## Validation results

- supported runtime: Node.js `22.23.1`;
- Project Brain: core `0.4.0`, adapter `0.4.0`, contract `1.0`, schema `2.5.0`,
  13 schemas, 13 allowlisted operations;
- clean `npm ci`: passed;
- sharp decode/resize/PNG path: sharp `0.35.0`, libvips `8.18.3`, passed;
- Mission Control unit tests: 106 passed;
- Mission Control integration tests: 55 passed;
- standalone Project Brain tests: 68 passed;
- TypeScript and ESLint: passed;
- changed-file formatting and `git diff --check`: passed;
- production build and route generation: passed;
- standalone deployment package: present and bootable;
- authentication/session smoke: login `200`, unauthenticated session `401`;
- migrations `0001` through `0026` from an empty PostgreSQL database: passed;
- global and workspace Project Brain projection verification: equal;
- production web and Codex configuration validation: ready, with no secrets
  printed;
- Project Brain worker startup: passed;
- Mission Agent capability advertisement: passed in the remote lifecycle;
- Project Brain unavailable behavior: fail-closed and unrelated Mission Control
  health remains available.

## Deployment rehearsal

The candidate production build started from `.next/standalone/server.js`
against the disposable migrated database. Health, server rendering, route
generation, security headers, login, and unauthenticated session handling
passed.

The exact pre-release `production` commit `6a630b9` was separately checked out,
installed, built, and started against the same forward schema containing
migrations `0025` and `0026`. Health returned `ok`, login returned `200`, and
unauthenticated session returned `401`. This proves the additive schema remains
compatible with the application rollback point.

No real customer repository, credential, object store, or production database
was used. Object-store configuration shape was validated with rehearsal-only
values; a real production bucket read/write/delete smoke remains a deployment
gate.

## Required configuration

Mission Control:

- `APP_ENV=production`
- `DATABASE_URL`
- `MISSION_CONTROL_SESSION_SECRET`
- `PUBLIC_APP_URL`
- `SECURE_COOKIES=true`
- `SECRET_PROVIDER`
- `ARTIFACT_STORAGE_PROVIDER=s3`
- `ARTIFACT_S3_BUCKET`
- `ARTIFACT_S3_REGION`
- `ARTIFACT_S3_ENDPOINT`
- either workload IAM role configuration or S3 access credentials
- stable `WORKER_ID` per worker

Codex:

- `CODEX_EXECUTABLE`
- `CODEX_API_KEY` or the approved production credential provider
- `APPROVED_REPOSITORY_ROOTS`
- `CODEX_REPOSITORY_ROOT`
- `CODEX_WORKTREE_ROOT`
- `GIT_PROVIDER`

Project Brain:

- `PROJECT_BRAIN_EXECUTABLE` as an absolute path
- `PROJECT_BRAIN_REQUIRED_VERSION=0.4.0`
- `PROJECT_BRAIN_CONTRACT_VERSION=1.0`
- optional positive `PROJECT_BRAIN_TIMEOUT_MS`
- optional positive `PROJECT_BRAIN_MAX_OUTPUT_BYTES`

The installed CLI directory must also be available to Codex/Mission Agent
subprocesses that enforce repository Project Brain instructions.

## Exact merge sequence

1. Merge `codex/project-brain-0.4.2-remote-consumer` into Project Brain
   `main`, preserving `5d80c89` then `09cae94`.
2. Publish or otherwise make that reviewed Project Brain commit available to
   the Mission Control worker image; do not install an unreviewed floating
   branch.
3. Merge `codex/next-sharp-security` only if the release process requires its
   independent maintenance history; its exact patch is already included in the
   final candidate.
4. Merge `codex/project-brain-final-release-candidate` into Mission Control
   `production`.
5. Verify the resulting tree contains migrations `0025` then `0026`, Next.js
   `16.2.11`, sharp `0.35.0`, Mission Agent `0.6.7`, and the final agent
   checksum pinned in both manifest and onboarding.

Do not separately merge the intermediate Mission Control Project Brain
branches after the final candidate; their changes are already included.

## Exact deployment sequence

1. Record the current application revision `6a630b9`, database backup/PITR
   point, worker image, Mission Agent version, and artifact image digest.
2. Enable emergency pause for new Project Brain and remote assignments.
3. Stop Project Brain, Codex, generic/outbox, action, and remote-delivery
   workers after current leases drain.
4. Install the reviewed Project Brain package in an immutable worker/runtime
   environment:

   ```sh
   python3 -m venv /opt/mission-control/project-brain-0.4.0
   /opt/mission-control/project-brain-0.4.0/bin/python -m pip install \
     "project-brain @ git+https://github.com/shawnwollenberg/project-brain.git@<MERGED_PROJECT_BRAIN_SHA>"
   /opt/mission-control/project-brain-0.4.0/bin/project-brain doctor --format json
   /opt/mission-control/project-brain-0.4.0/bin/project-brain capabilities --format json
   ```

5. Run `APP_ENV=production npm run production:validate -- migration`, then
   `npm run production:migrate`. Expect only `0025` and `0026` on an upgraded
   production database.
6. Deploy the immutable Mission Control candidate artifact and run
   `npm run production:validate -- web`.
7. Start the generic/outbox worker, then Project Brain worker, then Codex and
   action workers, then remote-delivery and remaining scheduled/notification
   workers. Verify each stable worker heartbeat.
8. Upgrade one disposable/canary Mission Agent to `0.6.7`; verify its published
   SHA-256 and Project Brain capability advertisement before rolling agents in
   bounded batches.
9. Run the production S3 artifact put/head/get/delete smoke.
10. Run the post-deployment smoke checklist below.
11. Clear emergency pauses only after all checks pass.

## Rollback

1. Pause new Project Brain and remote assignments and let or cancel active
   leases according to their durable recovery state.
2. Stop the new Project Brain/Codex/remote workers.
3. Restore the prior Mission Control application artifact at `6a630b9`.
4. Restore Mission Agent `0.6.6` if the agent rollout itself caused the fault.
5. Preserve migrations `0025` and `0026`, canonical events, receipts, and
   repository `.project-brain` artifacts. They are additive and the rehearsal
   proves `6a630b9` can run against the forward schema.
6. If Project Brain itself caused the fault, unset `PROJECT_BRAIN_EXECUTABLE`
   or stop only the Project Brain worker. Unrelated Mission Control workflows
   remain available.
7. Re-run health, login/session, worker, outbox, and projection checks before
   reopening normal traffic.

Emergency rollback to `6a630b9` temporarily restores the known vulnerable
Next.js/sharp dependency tree, so exposure must be bounded and a corrected
forward deployment prioritized.

## Post-deployment smoke checklist

- health and readiness are green;
- login succeeds and unauthenticated session remains `401`;
- schema reports no pending migrations;
- outbox drains and dead-letter rate is normal;
- all required worker heartbeats are current;
- Project Brain doctor/capabilities report the pinned versions and schemas;
- Project Brain-disabled repositories remain unaffected;
- one disposable local read operation and approved context generation pass;
- one canary Mission Agent advertises compatible capabilities;
- exact context checksum appears identically in artifact, binding, and agent
  verification evidence;
- one deliberately unavailable Project Brain check fails closed with a safe
  operator message;
- projection verification is equal;
- no proposal is automatically promoted;
- no push, merge, publication, or deployment occurs from the smoke mission.

## Known limitations

- production configuration validation checks Project Brain separately through
  doctor/capabilities rather than as a first-class `production:validate`
  process type;
- UI operation detail is evidence-rich but still exposes some raw structured
  data and could provide more tailored queued/approval/failure guidance;
- npm audit retains development-only ESLint dependency findings whose automatic
  resolution requires an unrelated major upgrade;
- production S3 connectivity was not exercised because this rehearsal used no
  production credentials or customer infrastructure.

## Disposition

The candidate is **ready to merge only**. Code, dependency, local/remote
lifecycle, migration, build, replay, and rollback evidence are complete.
Production deployment remains gated on explicit authorization, the real
artifact-store smoke, final merged SHAs, and canary environment verification.

Nothing was merged to the target branches, pushed, published, or deployed
during this acceptance.
