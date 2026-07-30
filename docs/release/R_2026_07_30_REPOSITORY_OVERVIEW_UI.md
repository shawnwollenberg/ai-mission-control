# R_2026_07_30_REPOSITORY_OVERVIEW_UI

**Status:** Human authorized; local and authoritative GitHub validation complete
**Classification:** Routine governed application release  
**Production base:** `a4b873c540c1da6a271571e47d523285d4c129dc`

## Problem and intended behavior

The mission archive gives filters too much vertical space, while repository health is visible only inside the launch
flow or after navigating directly to one repository. The authenticated application needs a compact mission archive and
a repository overview that makes health, confidence, recommendations, mission history, and the existing registration
path discoverable.

The search field remains unchanged. Status, Origin, and Cost share one collapsible row. A new Repositories navigation
item opens a workspace-scoped overview. Each repository links to the existing intelligence page, and its score opens an
explanation containing the current deterministic dimensions, confidence, scoring version, and assessment timestamp.
Add repository presents the existing signed Mission Agent command; it does not move local-path or Git credentials into
the browser.

## Exact scope and non-goals

Scope is authenticated navigation markup, mission-filter presentation, one read-only repository overview query and
page, one evidence-section anchor, responsive styles, focused regression tests, and this release evidence.

Non-goals are navigation reorganization beyond one Repositories link; new mission predicates; browser-side repository
registration; changes to repository identity, registration persistence, grants, agent associations, scoring,
recommendations, Project Brain, Mission Agent, command policy, publication, merge, deployment authority, authentication,
authorization, credentials, schema, migration, signing, infrastructure, or dependencies.

## Authorization, isolation, and canonical evidence

The repository page obtains the authenticated workspace from `requirePageIdentity`. It accepts no workspace identifier
from the browser and scopes the repository, assessment, recommendation, and mission-count query to that workspace.
Disabled repositories are excluded.

The overview is a read-only projection. Scores, confidence, dimensions, scoring version, and assessment timestamp come
from the latest canonical repository-health assessment. Unknown dimensions remain visibly unknown; the page performs
no scoring and invents no explanation. The Add repository disclosure only documents the existing signed Mission Agent
registration command. Credentials and local repository paths are not submitted to or returned by this page.

## Acceptance criteria

1. Mission search retains its label, name, value, and predicate.
2. Status, Origin, and Cost occupy one collapsible row, reopening automatically when a filter is active.
3. Repositories appears in authenticated primary navigation.
4. The overview includes every active repository in the authenticated workspace and no repository from another
   workspace.
5. Every repository links to its existing detail page and shows actionable-recommendation and mission counts.
6. Clicking a score explains its current assessment dimensions and provides a link to complete evidence.
7. Unassessed repositories clearly request an analysis and do not display a synthetic score.
8. Add repository gives the existing local Mission Agent command and explains credential locality.
9. Desktop and narrow layouts remain legible and keyboard-operable.
10. Existing repository management, missions, health, Project Brain, Mission Agent, and authority tests remain green.

## Validation and release evidence

Required gates are a clean Node 22/npm install, focused UI tests, complete unit, integration, and E2E suites, lint,
formatting, typecheck, production build, migration status, production dependency audit, `git diff --check`, responsive
authenticated browser validation, and confirmation that Mission Agent 0.7.2 bytes/signature/manifest remain unchanged.

Evidence before commit, push, merge, and deployment must include exact changed files, green gate totals, rendered desktop
and narrow views, exact branch head, unchanged production base, unchanged artifacts, and a reviewed diff containing
only this scope.

Local validation on 2026-07-30:

- Runtime: Node `v22.20.0`; npm `10.9.3`.
- Clean dependency installation: passed with `npm ci`.
- Focused UI and adjacent repository/publication/onboarding tests: `21/21`.
- Complete unit suite: `169/169`.
- Complete integration suite: `73/73` on the authoritative rerun against a fresh PostgreSQL 16.4 database. The initial
  run passed `72/73` because the Project Brain governed-execution test did not observe its generic job while integration
  files were running concurrently. The unchanged test passed `3/3` in isolation and the complete unchanged suite then
  passed `73/73`; no release code touches jobs or Project Brain.
- Complete E2E suite: `2/2`.
- Lint, full formatting check, typecheck, production build, migration `0001` through `0028` with zero pending
  migrations, and `git diff --check`: passed.
- Production dependency audit: zero production vulnerabilities. The clean full development install reports nine
  high-severity development advisories that predate this release; no dependency or lockfile changed.
- Authenticated runtime rendering: `/missions` and `/repositories` returned HTTP 200 from the production build.
  Desktop Chrome confirmed the compact closed Filters disclosure, full-width unchanged search, repository navigation,
  overview card, Add repository disclosure, score disclosure, canonical dimension list, counts, and detail links.
  Responsive CSS and focused tests enforce a one-column filter/card layout below 760px; the connected Chrome control
  surface did not expose its advertised viewport override, so a separate emulated narrow screenshot was unavailable.
- Mission Agent 0.7.2 is unchanged at 148,063 bytes and SHA-256
  `108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09`; artifact, signature, manifest, protocol,
  identity, Project Brain, and release-authority files have no diff.
- Local reviewed boundary: `PLANS.md`, `app/app-navigation.tsx`, `app/globals.css`, `app/missions/page.tsx`,
  `app/repositories/page.tsx`, `app/repositories/[repositoryId]/page.tsx`, `package.json`,
  `tests/repository-index-ui.test.mjs`, and this release record.
- Production base remains `a4b873c540c1da6a271571e47d523285d4c129dc`.
- Reviewed implementation commit: `a9c51de47b20185856414568d52c6b3ec41bb515`.
- Pull request: `#12`.
- GitHub Actions validation run `30579017494`, job `90994292469`: passed in 2m00s.

## Rollout, rollback, and post-deployment verification

Roll out as an application-only deployment with no migration. After deployment verify health/readiness, deployed
revision and image, zero pending migrations, navigation, filter disclosure and filtering, workspace-scoped repository
visibility, detail links, confidence disclosure, Add repository guidance, repository launch compatibility, and absence
of secrets in rendered output and logs.

Rollback only the application revision if any required check fails. Do not delete or rewrite repositories, identities,
grants, agents, assessments, recommendations, missions, commands, events, receipts, audits, or Project Brain records.

## Risks and approval

The primary residual risk is dense score disclosure on narrow screens; responsive rendered validation is required.
Mission counts derive from repository-bound executions and may be lower than historical missions without execution
identity; this is an honest projection, not an inferred count. Registration remains a local CLI operation because the
browser cannot safely select or validate a Mission Agent filesystem path.

Human authorization was provided by Shawn Wollenberg on 2026-07-30 to implement, commit, push, merge, and deploy this
narrow UI request after validation. Authorization is invalid if the production base advances with overlapping changes,
the reviewed scope changes, a required gate becomes red, or Mission Agent/repository authority behavior changes.
