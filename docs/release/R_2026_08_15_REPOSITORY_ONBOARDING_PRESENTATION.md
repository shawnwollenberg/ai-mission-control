# R-2026-08-15 — Repository and onboarding presentation correction

**Classification:** Routine governed application release

**Human authorization:** Approved by the operator on 2026-08-15 in response to the diagnosed repository-layout and onboarding-status defects.

## Scope

- Render registered repositories as responsive full-width cards on the agent detail page instead of placing repository content in the narrow sequence column of a log row.
- When an onboarding connection poll or connection creation receives HTTP 401, stop silent polling and show an explicit session-expired message with a sign-in link that preserves the selected agent and onboarding mode.

## Authority and non-goals

This release changes presentation only. It does not change authentication, session validation, repository registration/removal, provider/runtime authority, Mission Agent configuration, Consensus Plan behavior, execution authority, production topology, or data.

## Acceptance criteria

1. Multiple registered repositories use the available desktop width and collapse to one column on narrow screens.
2. Repository controls and canonical associations remain unchanged.
3. An expired onboarding session is visible and actionable instead of appearing frozen.
4. Successful authenticated polling and connection progress remain unchanged.
5. Focused tests, unit, integration, browser, TypeScript, ESLint, Prettier, build, and diff checks pass.

## Rollout and rollback

Deploy only the web application through the existing digest-pinned production procedure after CI passes. Preserve all workers, PostgreSQL, Caddy, Project Brain, agents, repositories, and missions. Rollback restores the immediately preceding web image; no data rollback is required.
