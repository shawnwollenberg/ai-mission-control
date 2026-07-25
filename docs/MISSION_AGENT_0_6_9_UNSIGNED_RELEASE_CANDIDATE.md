# Mission Agent 0.6.9 unsigned release candidate

## Disposition

This record preserves an **unsigned — not trusted for publication or
installation** release candidate. It is not a release manifest and is not
consumed by runtime verification.

- Version: `0.6.9`
- Source commit: `1c8aee72eda931f45f2dfae3db2c0f7798a67400`
- Artifact: `public/mission-agent-0.6.9.mjs`
- Artifact SHA-256:
  `a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af`
- Build command: `node scripts/build-mission-agent-069.mjs`
- Acceptance runtime: Node.js `22.20.x`, as required by `package.json`
- Reverification host: Darwin `25.5.0` arm64
- Identity version: `stable-v2`
- Identity protocol version: `2`
- Activation acknowledgement version: `1`
- Mission Agent artifact manifest version: `1`
- Required database migration: `0028_repository_identity_migration.sql`
- Required Project Brain compatibility: core `0.4.0`, consumer contract
  `1.0`, artifact schema `2.5.0`
- Signing status: missing
- Publication status: blocked
- Deployment status: blocked

The detached `.artifact.json` file records bytes and version only. It does not
contain a release signature and does not authorize installation.

## Validation evidence

- TypeScript typecheck: passed.
- ESLint with zero warnings: passed.
- Existing unit suite: 112 of 112 passed.
- Focused repository-identity suite: 15 of 15 passed after migration; the
  final executable conformance-only rerun passed 14 of 14.
- Production Next.js build: passed with Next.js `16.2.11`.
- Empty PostgreSQL database migrations `0001` through `0028`: passed.
- Two-phase identity integration: passed.
- Artifact syntax and checksum verification: passed.
- Shared stable-v2 fixtures were executed against both Mission Control and
  the exported implementation in the exact artifact.
- Independent acceptance rereview: no unresolved critical or high findings
  in the two-phase implementation.
- Independent supply-chain review: signing remains blocked because no signed
  0.6.9 release manifest exists.

Production continues to advertise the signed 0.6.8 manifest. Version 0.6.9 is
absent from the approved runtime artifact registry until signing and
supply-chain acceptance are complete.

## Trusted release key

- Safe key identifier:
  `ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a`
- Public key location: embedded as the Ed25519 SPKI verification key in
  `public/mission-agent-0.6.8.mjs` and the unsigned 0.6.9 candidate.
- Last successfully signed release: Mission Agent `0.6.8`.
- Expected custody: offline release-signing environment, outside this
  repository and production images.
- Documented custodian: not recorded in the repository.
- Existing signing command or ceremony: not recorded in the repository.
- Private-key availability: unconfirmed; it was not made available to Codex.
- Loss status: not established.
- Compromise status: no evidence or allegation of compromise was found.
- Backup and multi-custodian status: not recorded in the repository.

The approved next path is recovery of the existing trusted signing authority.
An authorized custodian must confirm availability without exposing key
material, then perform the offline ceremony described in
`MISSION_AGENT_RELEASE_SIGNING.md`. If custody confirms that the key is lost,
the separately authenticated application trust-root rotation path in that
document applies. A new key cannot self-authorize.

