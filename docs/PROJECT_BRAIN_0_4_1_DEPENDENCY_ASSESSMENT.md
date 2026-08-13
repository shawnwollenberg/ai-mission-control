# Project Brain 0.4.1 dependency advisory assessment

Date: 2026-07-24

This assessment is intentionally separate from the governed-execution changes. No dependency was upgraded on this branch.

## Observed production dependency state

`npm audit --omit=dev --json` reports two high-severity package findings:

- `next@16.2.10` is affected by four high-severity advisories and five moderate advisories. The reported fixed release is `16.2.11`.
- Transitive `sharp@0.34.5` is affected by `GHSA-f88m-g3jw-g9cj` (`sharp <0.35.0`). npm reports upgrading Next to `16.2.11` as the available remediation.

The relevant Next findings include an App Router middleware/proxy bypass, Server Action denial of service, and two server-side request-forgery classes. This repository has Server Actions, so the denial-of-service finding is applicable. No middleware/proxy file, custom rewrites, Edge runtime declaration, or custom server was found, which reduces—but does not eliminate—the reachability of the other Next findings. No application use of Next image optimization was found; this reduces the direct sharp exposure.

## Disposition

The upgrade is not required to implement or validate the Project Brain worker architecture, so it is excluded from this branch as requested. It is a release-safety blocker for an Internet-facing production deployment because an applicable high-severity Server Action advisory remains. Open a separate maintenance branch that upgrades Next to at least `16.2.11`, confirms the resolved sharp version, and repeats unit, integration, browser, and production-build validation.

No `npm audit fix`, lockfile mutation, package publication, deployment, or dependency upgrade was performed here.
