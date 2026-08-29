# Mission Control 2.0 — Production Readiness and Dogfood Preparation

**Status:** Development readiness evidence complete on 2026-08-29; controlled deployment is blocked pending an exact
provider-worker topology and credential decision. No production mutation is authorized by this document.

## Readiness disposition

The V2 product model remains viable. GitHub Issues are durable Mission truth; separate Codex SDK threads implement the
Engineer and read-only Architect; Mission Control owns deterministic routing and exact CTO escalation. The readiness
work did not add a chat surface, agent platform, repository manager, or second canonical Mission database.

The application is not yet `READY_FOR_CONTROLLED_V2_DEPLOYMENT` in the existing hosted topology. Official OpenAI
documentation supports ChatGPT subscription authentication for local Codex work and directs programmatic CI/CD work to
API-key authentication with API billing. The accepted V2 runtime uses subscription authentication. The existing
production Codex worker requires `CODEX_API_KEY`, and its web/container topology does not provide an approved persistent
ChatGPT subscription session. Selecting an owner-local persistent V2 worker or authorizing an API-billed production
credential/topology is a CTO authority decision. Responses remains disabled.

## Implemented readiness controls

- Provider execution was removed from the CTO web mutation route. The route records one exact GitHub decision and a
  separate bounded V2 worker performs subsequent provider routing.
- The worker polls configured Issues, processes at most three Missions concurrently, and uses a single-process lock.
  It is intentionally not a generalized scheduler.
- A validated provider result is written atomically to temporary in-flight binding state before its GitHub append.
  Restart can finish the exact append without another provider turn.
- If a process stops before any validated result is durable, the dispatch is explicitly indeterminate. Mission Control
  retains GitHub truth, records a bounded failure, and does not automatically repeat a potentially mutating Engineer
  turn. A failed read-only Architect dispatch may be explicitly replaced from durable Mission context.
- GitHub write-success/response-loss recovery reconciles the existing comment, repairs its derived state label, and
  clears the in-flight marker without another provider call.
- A digest binds the original Mission envelope when provider work starts. Editing that source envelope during or after
  dispatch fails closed instead of silently changing the scope beneath an accepted provider result.
- File bindings serialize updates across runtime instances in one process and use owner-only atomic replacement.
  Bindings store only identity, source digest, separate thread IDs, revision, temporary in-flight result, and bounded
  failure state. Temporary provider output is removed after GitHub accepts it.
- Runtime GitHub access uses the existing `GITHUB_TOKEN` through native REST when present and falls back to the local
  authenticated `gh` CLI for development. Tokens, prompts, and raw provider responses are not logged.
- Structured operational logs identify event, Mission, revision, actor, idempotency key, provider thread, failure code,
  and resulting state. They exclude prompts, model output, credentials, and arbitrary exception details.
- Architect instructions now treat Engineer Reports as claims, compare evidence with criteria, reject scope
  redefinition and unsupported/private integrations, distinguish routine implementation choices, and prohibit
  bypassing CTO authority. A deterministic guard rejects approval backed by failing, blocked, missing, or unresolved
  CTO-owned evidence.
- Engineer instructions state that CTO approval does not expand Engineer capabilities and that CTO-only actions require
  a separate governed action path.
- Project configuration validates exact GitHub identity/URL, absolute checkout, adapter/constitution agreement,
  authorized login syntax, unique project IDs, positive Issue IDs, and cross-project duplicate Issue tracking.
- System/provider failures render gray with a concise reason and are distinct from red CTO requests. CTO detail shows
  requested action, financial effect, external/on-chain effect, reversibility, Architect recommendation, and age.
  Decision controls are double-submit guarded, wrap on narrow screens, and have 44px minimum height.

## Recovery and idempotency evidence

The V2 suite proves:

| Window                                                      | Result                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Restart with Engineer result durable but GitHub not written | Exact saved result is appended; Engineer is not called again.                    |
| Restart with Architect result durable                       | Exact decision is appended; a pending CTO request is completed if required.      |
| Crash before validated provider result is durable           | Bounded indeterminate failure; no automatic redispatch.                          |
| GitHub write succeeds but response is lost                  | Comment is reconciled, label is repaired, provider call count remains one.       |
| CTO request pending across restart                          | Exact request remains visible; `advance` does no Engineer work.                  |
| Completed Mission across restart                            | Issue remains closed/complete; no provider dispatch.                             |
| Duplicate/out-of-order GitHub delivery                      | Identical duplicates are no-ops; conflicts, gaps, and invalid transitions fail.  |
| Double/stale CTO decision                                   | Only the exact pending request revision is accepted; later/stale decisions fail. |
| Issue body edited while provider is running                 | Source digest mismatch fails before provider result commit.                      |

Provider authentication, usage limit, missing thread, malformed output, process failure, indeterminate dispatch, Mission
source change, and GitHub failure map to bounded operator messages. Provider context is noncanonical. Automatic
replacement is permitted only for the read-only Architect path; a potentially mutating Engineer attempt requires
explicit reconciliation because replay could duplicate a repository effect.

## Concurrency and reconstruction

Real subscription-authenticated acceptance ran three Missions concurrently in
`shawnwollenberg/agent_payment_risk_check`:

- Full workflow [Issue #3](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/3), revision 9, history
  digest `249bc54ed4f6364cf21d61738abebdba696940380e762909d4aa00f4df0c9144`; Engineer thread
  `01a04edd-933a-7ae2-abb4-fd2f63716780`; Architect thread `01a04edd-fa11-72a3-8b34-855a35879789`.
- Isolation [Issue #8](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/8); Engineer thread
  `01a04ee0-c664-7432-877b-27487b46b518`; Architect thread `01a04ee1-2728-7330-bd0d-f3593399c0b5`.
- Isolation [Issue #9](https://github.com/shawnwollenberg/agent_payment_risk_check/issues/9); Engineer thread
  `01a04ee0-c6ab-7723-821f-7d2a7a26f004`; Architect thread `01a04ee1-27b0-77b0-b166-d545c18507e7`.

All six provider thread IDs were distinct. The two isolation lanes ran Engineer and Architect turns concurrently and
closed independently. The full lane exercised `REMEDIATE`, same Engineer thread, `CTO_REQUIRED`, a paused revision-6
request, exact simulated approval at revision 7, same Engineer thread, final Architect `APPROVE`, Issue closure,
dashboard `COMPLETE/NONE/BLACK`, and fresh GitHub reconstruction. No human carried a message between providers.

Mission state, actor, revision, CTO request/decision, summaries, transitions, completion, and dashboard state rebuild
from GitHub without local history. Only provider thread continuity, source-envelope binding, unresolved in-flight result,
and bounded operational failure cannot be reconstructed and remain in the minimal binding file.

## CTO and mobile experience

Authenticated browser review used the real completed Issue at desktop `1280×800` and mobile `390×844`. Dashboard
content, Open/GitHub links, actor, and status remained visible with no horizontal overflow. The project detail initially
overflowed to 448px because a long code token could not wrap; responsive word wrapping and a clamped heading reduced
the measured body width to exactly 390px. Project and GitHub links remained visible. CTO controls are designed to wrap,
remain at least 44px high, and disable during submission.

## Project registry

To add a controlled project:

1. Confirm the repository and checkout are nonproduction or separately authorized for dogfood.
2. Add one active entry to the Mission Control-owned V2 JSON configuration with project ID, display name, exact
   `owner/repo`, absolute local checkout, exact repository URL, `codex-sdk` adapters, and constitution.
3. Assign every capability to exactly one of Engineer, Architect, or CTO. Do not grant CTO capabilities to Engineer.
4. Create a bounded Mission Issue with the V2 envelope and approved `mc:*` labels.
5. Add its positive Issue number to `trackedMissionIssues` and run configuration/V2 validation before starting the
   single V2 worker.

No managed repository installs Mission Control files or enters the V1 repository registry.

## V1 isolation

V2 imports only shared authentication/security utilities (`requirePageIdentity`, `requireApiIdentity`,
`requireMutationOrigin`, and session-backed owner identity) from the application shell. V2 does not import V1 Mission,
task, execution, agent registry, Project Brain, Hermes, consensus, Mission Agent, event-store, projection, worker, or
database domain modules. The production build emits `/v2` and its one CTO-decision API beside all unchanged V1 routes.

## Controlled deployment plan — prepared, not authorized

Prerequisites:

1. Record human approval for the exact security-sensitive V2 release commit and this deployment scope.
2. Choose and approve one supported provider topology:
   - an owner-controlled persistent local V2 web/worker runtime using ChatGPT subscription authentication; or
   - the existing hosted worker topology with a separately authorized API credential and billing; or
   - a future supported Workspace Agent bridge after its own reviewed implementation.
3. Prove the chosen topology supplies persistent minimal bindings, exact project checkouts, native GitHub access,
   single-worker fencing, restart behavior, and redacted logs. Do not copy local ChatGPT session files into a hosted
   container.
4. Record the exact 1–3 dogfood projects and Issues. Keep Responses disabled.

After prerequisites, the proposed rollout is:

1. Build the reviewed commit with the existing Node 22 production build.
2. Deploy the web artifact with `/v2` enabled alongside V1; redirect no V1 traffic and migrate no V1 data.
3. Configure native GitHub REST using the existing least-privilege credential and owner-authorized logins.
4. Start exactly one V2 worker only in the approved provider environment.
5. Verify authentication, `/v2`, project detail, GitHub reconciliation, worker lock, provider auth, and one read-only
   smoke Mission before enabling real dogfood Issues.
6. Observe bounded logs and failure presentation through one full Mission before adding a second or third project.

Expected incremental infrastructure cost is zero only for an owner-local worker using the existing subscription and
existing application/GitHub infrastructure. API-key worker usage has usage-based cost and requires separate approval.

## Rollback

1. Stop the V2 worker first so no new provider turns begin.
2. Remove/disable all `trackedMissionIssues` and active V2 projects in configuration.
3. Restore the previous compatible application artifact or disable `/v2` routing at the existing deployment layer.
4. Leave GitHub Issues, comments, and labels intact as durable evidence. Do not delete or rewrite them.
5. Retain the minimal binding file until every in-flight dispatch is reconciled; then archive it under the approved
   operational retention policy.
6. Confirm V1 routes, database, workers, and traffic are unchanged. No database down migration exists or is required.

## Dogfood plan

Run several real work sessions before considering V1 deletion:

1. **Mission Control:** bounded V2 reliability/documentation work in its development checkout.
2. **Agent Payment Risk Check:** small test/fix Missions with no wallet/signature action.
3. **One additional active software project:** add only after the first two complete without manual message carrying.

For each, the CTO creates or approves a GitHub Mission envelope, adds the Issue to the registry, and uses `/v2` for
status and exact decisions. Measure: manual Architect↔Engineer messages carried by the CTO, Missions completed, genuine
CTO interruptions, provider/system failures, recovery actions, and whether the dashboard answered the four core
questions quickly. Success means message carrying approaches zero without increased unsafe retries or false approvals.

## Validation evidence

- `npm run test:v2`: 26/26 pass after readiness additions.
- Relevant shared authentication/repository integration: 4/4 pass.
- `npm run typecheck`, `npm run lint`, formatting, and `git diff --check`: pass.
- `npm run build`: pass; `/v2`, detail, and CTO-decision routes emitted.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- Full `npm audit --audit-level=high`: zero vulnerabilities after compatible `aws-cdk-lib` update.
- Full `npm test`: 213 pass, 5 fail only because historical V1 Mission Agent 0.7.1/0.7.2 manifests are expired. The
  failures are isolated from V2 and remain deliberately unmodified under the V2 mission boundary.
- Fixture repository remained clean. No wallet, signature, money movement, production access, merge, deployment, V1
  mutation, permission expansion, or credential creation occurred.
