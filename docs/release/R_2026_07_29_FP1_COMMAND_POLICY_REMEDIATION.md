# R_2026_07_29_FP1_COMMAND_POLICY_REMEDIATION

**Status:** Human approved; pending governed commit, CI, merge, deployment, and
post-deployment acceptance

**Date:** 2026-07-29

**Base and preserved release:** merge
`d790937e4e40e1c32cae9a500a39671bc6886a2d`

**Current production application:** rolled back to
`e70c86e4a7ed6326616c8fbdb47d4b9542539e41`

**Classification:** Security-sensitive application remediation. The change
narrows model-generated validation guidance and preserves command-policy
rejection. It does not add execution authority.

**Approval:** Granted by the human operator on 2026-07-29 for exactly the
seven-file reviewed scope and green evidence recorded in this document. The
approval authorizes the governed commit, branch push, pull request, CI, merge,
deployment, and post-deployment acceptance. It does not authorize broader
prompt, allowlist, execution-policy, Mission Agent, or infrastructure changes.
It is invalid if the reviewed scope or evidence changes, a required gate turns
red, Mission Agent 0.7.2 changes, or production advances with an overlapping
change.

## User problem and root cause

The post-deployment disposable repository registered successfully with its own
workspace, appeared once in the account, connected through signed Mission Agent
0.7.2, and launched an analysis mission. The analysis and recommendation
artifacts were uploaded, but recommendation projection rejected a
Codex-generated validation string. Mission Agent then reported an explicit
failure, producing execution, task, and mission terminal `failed` projections.

The retained, checksum-verified production recommendation artifact contained:

```text
node -e "const fs=require('fs');const c=fs.readFileSync('.git/config','utf8');if(/github\\.com\\/example\\//.test(c)||!c.includes('[branch \"main\"]'))process.exit(1)"
```

The executable was `node`; its arguments were `-e` and one inline JavaScript
program. The proposed working directory was the registered disposable
repository root. It contained no network operation, privilege escalation,
background execution, pipe, redirection, or destructive filesystem command,
but `node -e` is arbitrary inline code execution and included quotes,
semicolons, parentheses, regular-expression syntax, and filesystem reads.

No mission-supplied validation command or acceptance criterion requested this
operation. The mission success criteria were a checksummed Markdown analysis
and no repository changes. Codex invented the command while trying to validate
its own recommendation criteria:

- the origin identifies the authoritative repository rather than a placeholder;
- `main` has an explicit remote and merge target; and
- a clean checkout resolves `main` to the intended production history.

The disposable repository was intentionally minimal and used an `example`
remote. The analysis prompt requested “safe ... node ... command strings” but
did not explicitly prohibit inline evaluation or instruct Codex to return no
validation when repository evidence was insufficient. That ambiguity caused
the inappropriate suggestion.

The first rejection occurred in Mission Control, not in Mission Agent command
normalization or execution. `domain/recommendation.ts` allowlist matching
rejected the string while `recordRepositoryRecommendations` projected the
already-uploaded `repository_recommendations` artifact. Nothing attempted to
execute the command. The agent received the rejection and submitted:

- classification: `local_adapter_failure`;
- summary: `Recommendation validation command is not allowed`;
- execution: `failed`, stage `running_codex`;
- task: `failed`, with the same progress summary; and
- mission: `failed`.

No credentials or sensitive repository content is included in this record.

## Command classification and remediation decision

**Outcome 3 — Mission/prompt correction.**

The command is not a canonical form of an existing governed validation
operation. It is direct inline evaluation and must remain prohibited. Adding
`node -e`, quoting, semicolons, or generic shell parsing would create an
arbitrary-code seam and is rejected.

The server-issued read-only analysis instructions now require recommendation
validation to use one direct supported executable with simple repository-local
arguments. They explicitly prohibit inline evaluation, shell wrappers,
chaining, separators, pipes, redirects, substitutions, environment
assignments, privilege escalation, network commands, destructive commands, and
paths outside the repository. When repository files do not evidence a governed
validation command, Codex must return an empty `suggestedValidation` array.

The domain allowlist remains fail-closed. Its error now explains the safe
alternative without echoing the rejected command. Known package-manager
lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`,
`prepublish`, and `publish`) are also rejected as recommendation validation
because they are not bounded test operations.

## Scope and non-goals

Implementation scope:

- constrain analysis instructions generated by
  `application/onboarding-mission.ts`;
- keep and clarify recommendation validation rejection in
  `domain/recommendation.ts`; and
- add policy, integration, E2E, and production-representative acceptance
  evidence.

Non-goals:

- no repository-management, identity-v2, authorization, tenant-isolation,
  registration transaction, Project Brain, release-authority, KMS, dependency,
  infrastructure, or migration change;
- no shell wrapper, arbitrary binary, inline evaluator, network command,
  privilege escalation, secret expansion, destructive command, or broader
  argument pattern;
- no execution of a recommendation merely because it was accepted as metadata;
  and
- no Mission Agent artifact, signature, manifest, or publication change.

## Threat analysis

The exact `node -e` form can read or mutate any data available to the runtime
and can encode network, process, environment, or filesystem operations inside
one argument. Quoting or decomposing its JavaScript does not make it a governed
operation. It therefore remains rejected before recommendation creation and
cannot become later change-mission validation.

Tests preserve rejection of `sh -c`, `bash -c`, command chaining (`;`, `&&`,
`||`), pipes, redirects, substitutions, path traversal, absolute executable
paths, environment assignments/expansion, network and destructive binaries,
privilege escalation, inline Node evaluation, and package lifecycle hooks.
Existing safe-process tests continue to cover repository cwd, timeout,
cancellation, environment allowlisting, and redaction. Existing remote-agent
tests continue to bind message receipts to nonce, checksum, workspace, agent,
message ID, and idempotency behavior.

Residual risk: recommendations can name allowed package scripts such as
`npm run test`; actual execution remains subject to the existing registered
repository, mission validation scope, policy, timeout, cancellation, receipt,
and audit controls. This release does not redesign package-script trust.

## Acceptance criteria

1. The exact production `node -e` command remains rejected.
2. Direct canonical commands such as `npm test`, `npm run lint`, `node --test`,
   `go test ./...`, `cargo test`, and `pytest tests/unit` remain accepted as
   recommendation metadata.
3. Model instructions prohibit unsupported syntax and prefer an empty
   validation list when no repository-defined command is evidenced.
4. Unsupported validation produces a clear terminal failure if it still
   reaches Mission Control.
5. Real Codex completes the production-representative analysis without an
   invented unsafe validation command.
6. Repository registration, identity v2, signed 0.7.2 heartbeat, artifacts,
   receipts, canonical terminal events, and Project Brain preservation remain
   green.
7. No migration or signed artifact changes.

## Validation evidence

Runtime:

- Node `v22.20.0`
- npm `10.9.3`
- install: `npm ci`

Results:

| Gate                                           | Result                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Focused command/adversarial tests              | Pass; exact production command plus canonical and adversarial matrix |
| Focused remediation and repository integration | Pass; 19/19                                                          |
| Complete unit suite                            | Pass; 164/164                                                        |
| Complete integration suite                     | Pass; 66/66                                                          |
| Complete E2E suite                             | Pass; 2/2                                                            |
| Real-Codex production-representative E2E       | Pass; 2/2, 152.9 seconds total                                       |
| Repository failure injection                   | Pass; all registration projection transitions                        |
| Repository concurrency                         | Pass; 10/10 consecutive                                              |
| Full lint                                      | Pass; zero warnings                                                  |
| Full formatting                                | Pass                                                                 |
| Typecheck                                      | Pass                                                                 |
| Production build                               | Pass                                                                 |
| Migration status                               | Pass; zero pending through `0028`                                    |
| `git diff --check`                             | Pass                                                                 |
| Signed artifact/manifest tests                 | Pass; 16/16 focused                                                  |
| Production dependency audit                    | Pass; zero production findings                                       |

The real-Codex acceptance used the same production objective, an authenticated
disposable workspace, a unique protocol-v2 repository, signed Mission Agent
0.7.2, verified heartbeat/pull readiness, the production build, and actual
Codex generation. It reached mission `completed`, execution `succeeded`, and
task `completed`; stored analysis, recommendations, and health artifacts;
persisted 43 protocol receipts; and appended `mission.completed`. All four
recommendations used an empty validation list instead of invented inline code.
Project Brain operation count remained unchanged.

## Artifact, migration, and state impact

Mission Agent 0.7.2 is unchanged:

- filename: `public/mission-agent-0.7.2.mjs`
- byte size: 148,063
- SHA-256:
  `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`
- signed Manifest v3, signature, signer identity, and updater behavior: unchanged

There is no migration. Repository identity protocol v2, repository-management
behavior, Project Brain code/state, release authority, and existing production
records are outside the diff.

## Reviewed diff boundary

- `application/onboarding-mission.ts`
- `domain/recommendation.ts`
- `tests/durable-browser.e2e.test.mjs`
- `tests/mission-agent-pull.integration.test.mjs`
- `tests/recommendation.test.mjs`
- `tests/repository-management-forward-port.integration.test.mjs`
- `docs/release/R_2026_07_29_FP1_COMMAND_POLICY_REMEDIATION.md`

## Rollout, rollback, and post-deployment acceptance

After explicit human approval bound to the exact reviewed commit and green CI:

1. Reconfirm the base, diff boundary, zero migrations, and exact signed 0.7.2
   bytes/manifest/signature.
2. Build and deploy one immutable application image only. Do not publish or
   replace Mission Agent 0.7.2.
3. Verify health/readiness, current schema, web and generic worker identity,
   and Project Brain worker/state before launching acceptance.
4. In a disposable authenticated workspace, repeat the exact production
   objective with a unique minimal repository and real Codex.
5. Require signed heartbeat, one repository after duplicate registration,
   three verified artifacts, durable receipts/events, execution `succeeded`,
   task `completed`, mission `completed`, no secret evidence, and unchanged
   existing repository/Brain counts.

If any check fails, restore the exact pre-deployment application image, keep
the additive mission/artifact/receipt/event evidence, and do not delete or
rewrite repositories, identities, grants, commands, missions, receipts, or
Project Brain records. No down migration exists or is permitted.

## Residual risks and approval

Real model output is nondeterministic. The prompt correction materially reduced
the observed ambiguity and passed a real-Codex reproduction, while the domain
policy remains the authoritative fail-closed boundary. A future unsupported
suggestion may still fail the mission; the clearer terminal explanation
identifies the safe alternative without widening execution.

**Human approval: granted for this exact reviewed state on 2026-07-29.**
