# R-2026-08-30 — V2 owner Mission amendment

## Classification and authorization

This is a security-sensitive application and routing-authority release because it permits the owner to replace a
blocked Mission's acceptance criteria. The product owner authorized implementation and local validation on
2026-08-30, then explicitly authorized commit, push, merge, and deployment of the reviewed release after validation.
Use on a real Mission remains separately unauthorized.

## Exact scope

- Add canonical `mc.owner-mission-amendment/v1` GitHub evidence.
- Permit it only from the exact current `BLOCKED_EXTERNAL` revision.
- Require owner authentication, same-origin mutation, rationale, evidence, and a complete non-empty replacement
  acceptance-criteria list.
- Preserve original criteria and every prior transition in GitHub history while deterministically projecting the
  replacement list from the amendment revision forward.
- Route the same Mission only to Architect reassessment.
- Expose the command beside owner reconciliation on the blocked Mission detail page.

## Authority boundary and non-goals

The amendment cannot change objective, constraints, Mission identity, capabilities, actor ownership, approval or
policy rules, credentials, provider authority, repository scope, external-effect authority, or historical evidence.
It cannot operate on active or completed Missions and cannot close a Mission directly. Labels remain projections, not
command authority. No Responses/API billing, provider retry, authentication ceremony, infrastructure change, database
migration, wallet/signature action, or financial effect is included.

## Acceptance

- Routing tests prove exact-revision operation, stale-revision rejection, blocked-state-only operation, immutable
  objective/constraints, complete criteria replacement, and Architect-only dispatch.
- Protocol and GitHub reconstruction tests prove strict schema validation, canonical append, historical preservation,
  deterministic rebuild, and derived label repair.
- API validation proves owner-only, same-origin mutation and rejects empty or malformed replacements.
- V2 tests, typecheck, lint, formatting, production build, dependency audit, and diff checks pass.

## Rollout and rollback

After exact human approval, commit and push the reviewed tree, merge without force, build an ARM64 image, capture the
current digest and database backup, deploy by immutable digest, verify health/readiness and worker presence, then use
the transition only against the explicitly approved blocked revision. Roll back to the prior digest without deleting
canonical amendment evidence; repair forward with another authorized revision if necessary.
