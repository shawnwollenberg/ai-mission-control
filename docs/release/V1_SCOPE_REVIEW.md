# V1 Scope Independent Review

Three independent read-only reviews covered trust roots and ECS identity,
macOS operator safety/recovery, scope/authorization gates, deferred controls,
and overengineering risk.

Resolved findings:

- Added an external owner-side, short-lived, nonce/audience-bound deployment
  identity signed by a distinct purpose-bound KMS key and verified by pinned
  runtime trust. The Mission Agent release key and application/task/CI roles
  cannot sign it.
- Added distinct preflight-only, migration-only, and exact canary-mutation
  human gates.
- Limited the operator to requesting/observing drain; Mission Control owns
  assignment fencing, two-snapshot verification and race invalidation.
- Made the owner account/Mac an explicit attended v1 trust root and specified
  compromise stop/reimage/recredential behavior.
- Defined independent operator checksum observation, fixed LaunchAgent
  lifecycle, compatible recovery artifact, journal verification, and
  update/uninstall prohibition during rollback.
- Separated immutable claim generation from the exact-successor monotonic
  operator fencing epoch chain.
- Aligned reproducible-build priority.

Final disposition: no unresolved critical, high, or v1-blocking finding.
