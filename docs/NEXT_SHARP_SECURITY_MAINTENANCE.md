# Next.js and sharp security maintenance

Date: 2026-07-24

## Scope

This maintenance change is intentionally limited to the Next.js patch release,
the matching Next.js ESLint configuration, and the transitive sharp security
floor.

| Package              | Previous                      | Selected                         |
| -------------------- | ----------------------------- | -------------------------------- |
| `next`               | `16.2.10`                     | `16.2.11`                        |
| `eslint-config-next` | `16.2.10` lockfile resolution | `16.2.11`                        |
| `sharp`              | `0.34.5`                      | `0.35.0` through an npm override |

Next.js remains pinned to the smallest patched Active LTS release. The sharp
override is required because Next.js 16.2.11 still declares `^0.34.5` as an
optional dependency even though the sharp advisory's patched range begins at
0.35.0. No unrelated package is intentionally upgraded.

## Advisory resolution

Next.js 16.2.11 resolves the July 2026 security release advisories affecting
16.2.10:

- `GHSA-6gpp-xcg3-4w24`
- `GHSA-m99w-x7hq-7vfj`
- `GHSA-89xv-2m56-2m9x`
- `GHSA-p9j2-gv94-2wf4`
- `GHSA-68g3-v927-f742`
- `GHSA-4633-3j49-mh5q`
- `GHSA-4c39-4ccg-62r3`
- `GHSA-q8wf-6r8g-63ch`
- `GHSA-955p-x3mx-jcvp`

The sharp override resolves `GHSA-f88m-g3jw-g9cj`, which covers inherited
libvips vulnerabilities `CVE-2026-33327`, `CVE-2026-33328`,
`CVE-2026-35590`, and `CVE-2026-35591`. The advisory identifies sharp 0.35.0
as the first patched version.

The post-upgrade npm audit no longer reports `next` or `sharp`. It still reports
nine development-tool findings through ESLint/minimatch/brace-expansion. npm's
suggested automatic resolution requires an ESLint 10 major upgrade and is
deliberately excluded from this narrowly scoped runtime maintenance.

## Compatibility and validation

The selected versions support the repository's Node.js 22 runtime contract.
Acceptance covers:

- lockfile installation with `npm ci`;
- runtime version enforcement;
- sharp metadata decoding, resize, and PNG output;
- Mission Control unit and database integration tests;
- authentication/session behavior and protected-route handling;
- ESLint and TypeScript;
- server rendering and route generation in `next build`;
- standalone deployment packaging and runtime smoke tests.

No application API or configuration migration is expected from these patch
updates.

## Rollback

Rollback is a single Git revert of the maintenance commit followed by:

1. `npm ci` under the supported Node.js 22 runtime;
2. `npm run build`;
3. replacement of the staged application artifact with the prior build;
4. a web process restart.

This dependency-only change contains no database migration. If it is part of a
larger release rollback, restore the prior application artifact before applying
the release's documented database compatibility procedure.
