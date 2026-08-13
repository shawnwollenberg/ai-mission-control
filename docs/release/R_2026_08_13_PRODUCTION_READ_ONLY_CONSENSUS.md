# Production read-only Consensus Plan authority

Classification: security-sensitive application release.

Human authorization: the operator explicitly authorized the exact `production_read_only_planning/1` profile and its
first non-destructive production Consensus Plan on 2026-08-13.

## Scope

- Add a separately defined, fail-closed production repository authority for planning only.
- Bind it to exact registered planning agents and the existing planning operation allowlist.
- Require at least one explicit owner-governed validation command for canonical-plan recommendations; commands are
  proposed only and receive no execution authority in this profile.
- Admit only `planningOnly=true` missions with no executor.
- Complete successful read-only consensus without approval or an implementation child.
- Reject authority rebinding while governed repository execution or assignments are active.

The profile grants repository read only. Worktree creation, writes, deletion, commit, push, pull request, merge,
publication, deployment, infrastructure mutation, and implementation execution remain structurally absent.

## Acceptance

Exact authority and projection tests reject every mutation-capability expansion. DB integration proves an
owner-authenticated receipt, durable read-only projection, read-only agent grants, owner enforcement, and continued
production prohibition of `disposable_local_implementation/1`. The production failure that exposed an empty command
set is retained as fail-closed evidence; focused integration proves an empty set rejects and the exact command arrays
persist through the same authority event/projection. Existing containment, provider eligibility, runtime
identity, lease/fencing, and protocol tests remain green. Static/build gates and security review require zero HIGH or
MEDIUM findings.

## Rollout and rollback

Promote one immutable application digest to web, generic worker, and action worker using the documented SSM/Docker
procedure. No migration is required. Retain the prior containers as rollback. Rollback restores those exact containers;
the additive authority event/receipt is inert under the prior application and grants no mutation authority.

## Production verification

Require green health/readiness, exact authority receipt/projection, active signed Mission Agent 0.8 attestations, one
read-only Consensus Plan, equal pre/post repository identity, zero changed paths, and no implementation, commit, push,
PR, publication, deployment, or surviving provider process.
