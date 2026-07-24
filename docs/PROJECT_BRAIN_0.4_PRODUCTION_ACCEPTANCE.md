# Project Brain 0.4 production acceptance

Date: 2026-07-24  
Disposition: **Requires targeted repair**

## Release inputs

- Project Brain core `0.4.0`, consumer contract `1.0`, schema `2.5.0`, Codex adapter `0.4.0`.
- Project Brain commit range: `eb35f92..6708a0f` on canonical `main`.
- Mission Control target: `production` at `6a630b9`.
- Validated isolated range: `2c9e7f2..7fa6c23`.
- Acceptance branch: `codex/project-brain-0.4-production-acceptance`.
- Applied acceptance commits: `8c3d988`, `bf28c97`, `528eb99`, `56b7d02`, `cd1f4e9`,
  `d04f97a`, `f13fc88`.

The isolated range applied without conflicts and has no base divergence. It changes ten scoped files: one adapter
package, one UI component, two existing page surfaces, one integration document, one test file, and the test script.
There are no database migrations, lockfile/runtime dependency changes, new routes, or existing-worker changes.

## Corrective acceptance changes

Uncommitted acceptance repairs add:

- explicit executable, version, contract, timeout, and output configuration;
- absolute executable-path enforcement;
- optional health metadata;
- generic user-facing error mapping;
- checkout and HEAD correlation;
- concurrent HEAD-change rejection;
- unverified context labeling and regeneration guidance;
- graceful malformed-configuration handling without failing unrelated page or database health;
- configured contract-version consistency across discovery and execution;
- repository-relative artifact paths, hexadecimal SHA-256 validation, and nonzero-exit rejection;
- local/production install, upgrade, rollback, and troubleshooting documentation.

These repairs do not resolve the worker, audit-persistence, permission, or context-delivery blockers below.

## Validation evidence

### Project Brain

| Check                                                  | Result                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| `python3 -m unittest discover -s tests -p 'test_*.py'` | Pass, 64 tests                                     |
| Clean virtual environment and `pip install .`          | Pass                                               |
| `project-brain doctor` in clean virtual environment    | Ready; versions compatible; 13 schemas; zero drift |
| `project-brain capabilities --json`                    | Core `0.4.0`, contract `1.0`, schema `2.5.0`       |
| `python3 scripts/install_skill.py validate`            | Pass, adapter `0.4.0`                              |
| `project-brain validate --repo .`                      | Valid at `6708a0f`                                 |

### Mission Control

All commands ran with Node `22.22.0`.

| Check                                                 | Result                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `npm test`                                            | Pass, 85 tests                                                     |
| `npm run typecheck`                                   | Pass                                                               |
| `npm run lint`                                        | Pass                                                               |
| Changed-file Prettier check                           | Pass after formatting                                              |
| `npm ci`                                              | Pass from lockfile                                                 |
| `npm run build`                                       | Pass; 29 static pages generated and dynamic routes compiled        |
| `npm run db:migrate` against disposable PostgreSQL 16 | Pass; migrations `0001`–`0024`; zero pending                       |
| `npm run test:integration`                            | Pass, 45 tests after documented seed setup                         |
| `npm audit --omit=dev --audit-level=high`             | Fail: two high-severity advisories in unchanged Next.js/sharp tree |

The first build attempt failed before compilation because a temporary `node_modules` symlink pointed outside the
Turbopack project root. Installing the locked dependency tree locally resolved that setup condition and the build
passed. The first integration attempt lacked a seeded owner; after recreating only the disposable database volume
and seeding the documented local owner, all 45 tests passed.

The dependency audit findings are evidenced as pre-existing: this integration changes neither `package-lock.json`
nor the Next.js/sharp versions. They remain deployment blockers and require a separately reviewed dependency update.

## Production-like lifecycle

A disposable JavaScript health repository was created and registered through the existing Mission Control Phase 2
acceptance command path. Project Brain initialization was explicitly previewed, then applied and committed.
Detection, validation, summary, knowledge health, context preview, and final context generation succeeded.

Mission `1fdff5a6-f64b-41d1-bf2e-4bb44d2629ce` and execution
`352ad8a2-4acd-4637-9f17-c78d04a3d5a0` were used for binding.

### Context evidence

| Metric                        |                                                              Value |
| ----------------------------- | -----------------------------------------------------------------: |
| Candidate files               |                                                                 27 |
| Candidate bytes               |                                                             27,006 |
| Initially selected files      |                                                                 12 |
| Initial selected bytes        |                                                             12,101 |
| Final selected files          |                                                                 12 |
| Final selected bytes          |                                                             12,101 |
| Byte reduction                |                                                             55.19% |
| Revision count                |                                                                  0 |
| Missing-context additions     |                                                                  0 |
| Sources rejected for budget   |                                                                  0 |
| Sources excluded as unrelated |                                                                 10 |
| Explicit-source completeness  |                                                               true |
| Relevant-source precision     |                                                     not measurable |
| Optimality claimed            |                                                              false |
| Serialized artifact bytes     |                                                              5,040 |
| Artifact SHA-256              | `26089f2bbe5b1efd09f689b7fffce42e0a7adc467df69e15f9243ec3002e9ce3` |
| Bound starting SHA            |                         `54bc24877ffcc7b63daeb9b235987202f3f7b34e` |

No token measurement was collected, so no token-savings claim is made.

### Acceptance stop

The mission was stopped before connected-agent execution. The Mission Control execution had already been requested
before Project Brain initialization and context generation, and the Codex worker has no durable field or artifact
delivery path for the Project Brain pack. Executing would not prove that the agent received the verified pack.
Additionally, the selected source list did not contain the two expected health implementation/test files, despite
their being supplied as expected-file hints. Treating that pack as sufficient would be unsafe.

Consequently the following were not performed in this acceptance run:

- agent execution using verified Project Brain context;
- deterministic validation of that context-informed change;
- verified Project Brain mission closure;
- proposed-learning creation and evaluation;
- display of that evaluation through a durable Mission Control projection.

No evidence or SHA was fabricated to fill these gaps.

## Independent review findings

### Critical/high blockers

1. Project Brain processes and repository writes execute synchronously in the Next.js web tier instead of a leased
   worker/outbox workflow.
2. The generated adapter audit object is discarded; successes and failures are not durably appended to Mission
   Control's canonical event log.
3. Context generation does not enforce repository `write_allowed`, location mode, agent/resource permission,
   policy, or approval.
4. `mission-agent://` repository registrations are incorrectly treated as local filesystem paths.
5. The execution dispatch contract does not carry the verified Project Brain context artifact/checksum to the
   assigned agent.
6. Repository status operations are coupled to page rendering and do not use durable cached projections or bounded
   retry/backoff.
7. The unchanged dependency tree has two high-severity production audit findings.

### Repaired during acceptance

- explicit pinned runtime configuration and absolute executable requirement;
- sanitized user-facing errors;
- checkout and starting-HEAD correlation;
- concurrent HEAD-change rejection;
- unverified packs no longer labeled as verified;
- malformed optional configuration no longer takes repository/mission pages or database health down;
- configured consumer contract is honored consistently by discovery and execution;
- artifact paths and SHA-256 values receive stronger structural validation;
- a nonzero process exit cannot masquerade as a successful envelope;
- installation, upgrade, rollback, and troubleshooting documentation.

## Required targeted repair

Before merge:

1. Add an explicit Project Brain enablement/location mode to repository registration.
2. Enqueue allowlisted Project Brain operations through the existing durable job/outbox infrastructure.
3. Run the adapter only in a dedicated worker with approved local repository roots and least-privilege environment.
4. Append success/failure audit events transactionally and persist display-only projections plus artifact
   path/checksum/schema metadata.
5. Gate write operations on repository permission and policy; context generation must be an explicit authorized
   command.
6. Bind the final pack to the execution before dispatch and deliver verified contents/checksum to the agent.
7. Make pages read projections and issue commands only; do not spawn processes during render.
8. Add integration tests for worker retry/dead-letter behavior, failed-operation auditing, permission denial,
   non-local repositories, projection rebuild, and agent context receipt.
9. Resolve the high-severity production dependency advisories through a separately reviewed upgrade.
10. Rerun the complete lifecycle from context preview through evaluated proposal and read-only inbox display.

## Deployment and rollback

Do not deploy this branch.

After the targeted repair passes acceptance, deploy through the normal reviewed Mission Control release procedure:
install Project Brain `0.4.0` in the worker image/runtime, configure the absolute executable and pinned contract,
apply verified migrations, start the Project Brain worker, deploy the web application, and verify health plus one
disposable repository before broader enablement.

Rollback by disabling Project Brain job intake, stopping its worker, unsetting `PROJECT_BRAIN_EXECUTABLE`, and
restoring the prior Mission Control application revision. Preserve all checked-in `.project-brain` artifacts; this
range has no database migration to reverse. Never delete or promote repository knowledge during rollback.

## Release recommendation

**Requires targeted repair.**

The contract and adapter mechanics validate successfully, but the current Mission Control integration violates the
production worker/event authority boundary and cannot prove agent context receipt. It is not ready to merge or
deploy. No commits were merged to `production`, pushed, published, or deployed.
