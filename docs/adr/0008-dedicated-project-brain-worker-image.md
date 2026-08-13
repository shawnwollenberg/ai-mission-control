# ADR 0008: Dedicated Project Brain worker image

## Status

Accepted for the production-packaging repair.

## Decision

Package Project Brain in a dedicated, non-public worker image. The image
contains the existing Mission Control leased worker runtime, Python, Git, and a
Project Brain wheel built from approved commit
`09cae9482712decc20f043aecb38d944beacfe20`.

The build downloads only that immutable source archive, verifies SHA-256
`1d127947f5a0ca5497d4a06c1497e36e00057d0551839ac2855b798c275c0d26`,
builds the wheel reproducibly, verifies wheel SHA-256
`033e9f66ffffd1d87a5d5bb9b411cc7331c5bffe4f48a3352d062fe6ab640d70`,
and installs it into an immutable virtual environment.
Runtime startup does not access GitHub or install packages.
Python wheels are hash-locked and Debian packages come from a dated immutable
snapshot.

The existing web image remains unchanged and contains neither Python nor
Project Brain. The Project Brain worker uses the existing
`project_brain_operation` job type, database lease implementation, event
authority, artifact store, and remote Mission Agent transport.

## Rationale

The dedicated image is the smallest model that preserves the established
worker boundary without adding Python to the public web tier or coupling
Project Brain availability to action publication. It provides an independent
diagnostic, restart, scaling, and rollback boundary while introducing no new
queue or execution path.

## Security boundary

- no public listener or inbound port;
- non-root runtime user;
- no Docker socket or developer-home mount;
- only the registered repository root is mounted;
- PostgreSQL and S3 access use the existing worker credentials;
- `mission-agent://` operations remain remote and are never checked out by the
  central worker;
- startup refuses leasing until Project Brain doctor, capabilities, version,
  contract, schema, implementation-drift, repository-root, and S3 checks pass;
- AWS production is remote-only until a checkout-owning service exists, while
  local execution is enabled only in the mounted acceptance topology.
