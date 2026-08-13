# Project Brain production packaging

The production repair uses a dedicated Project Brain worker image. The web
image remains unchanged and does not contain Python or execute Project Brain
subprocesses.

## Immutable inputs

- Mission Control base:
  `242255a717fca193defeb9760dfb879981b10b6a`
- Project Brain source:
  `09cae9482712decc20f043aecb38d944beacfe20`
- Project Brain source archive SHA-256:
  `1d127947f5a0ca5497d4a06c1497e36e00057d0551839ac2855b798c275c0d26`
- reproducible Project Brain wheel SHA-256:
  `033e9f66ffffd1d87a5d5bb9b411cc7331c5bffe4f48a3352d062fe6ab640d70`
- Project Brain version: `0.4.0`
- consumer contract: `1.0`
- artifact schema: `2.5.0`
- authoritative schemas: 13
- Node base image:
  `node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`
- Debian package snapshot: `20260713T000000Z`

`Dockerfile.project-brain-worker` verifies the source archive before building
the wheel. Python dependencies are locked with SHA-256 hashes for both amd64
and arm64 and downloaded into a build-time wheelhouse. Runtime installation is
offline from that wheelhouse. Debian inputs use the dated snapshot above.
Startup performs no package installation and needs no GitHub or PyPI access.

## Production configuration

| Variable                         | Value                                  | Rationale                                         |
| -------------------------------- | -------------------------------------- | ------------------------------------------------- |
| `PROJECT_BRAIN_EXECUTABLE`       | `/opt/project-brain/bin/project-brain` | Immutable image-owned executable                  |
| `PROJECT_BRAIN_REQUIRED_VERSION` | `0.4.0`                                | Approved core version                             |
| `PROJECT_BRAIN_CONTRACT_VERSION` | `1.0`                                  | Approved consumer contract                        |
| `PROJECT_BRAIN_TIMEOUT_MS`       | `15000`                                | Validated operation timeout                       |
| `PROJECT_BRAIN_MAX_OUTPUT_BYTES` | `1000000`                              | Validated bounded output                          |
| `CODEX_REPOSITORY_ROOT`          | `/repositories`                        | Explicit non-home registered-checkout boundary    |
| `PROJECT_BRAIN_LOCAL_EXECUTION`  | `disabled` (AWS production)            | Fail closed where no shared checkout owner exists |

The worker also receives its stable worker identity, PostgreSQL connection, and
existing S3 artifact configuration. It exposes no port and receives no Docker
socket or developer-home mount.

Before presence registration or leasing, the worker verifies PostgreSQL,
repository-root accessibility, S3 bucket connectivity, doctor and
capabilities output, exact versions, contract `1.0`, schema `2.5.0`, all 13
schemas, adapter compatibility, ready runtime state, and zero implementation
drift. Failure produces structured diagnostics and exits without leasing.

Remote `mission-agent://` operations retain the existing dispatch path. The
central worker authorizes, leases, transports, and validates them; Project
Brain execution stays on the remote Mission Agent.

The current AWS production topology is deliberately remote-only because it
does not contain a checkout-owning service. Server-local operations fail
closed with a canonical denial event. Its generic worker dispatches the
existing transactional outbox into the existing leased job table. The
disposable Compose rehearsal explicitly enables local execution and mounts a
checkout root so the local path can be acceptance-tested. The review-only
Render blueprint disables Project Brain command issuance and does not declare
a Project Brain worker because Render service disks cannot provide a shared
checkout boundary.

## Rollback

1. Stop leasing by stopping the Project Brain worker; allow any currently
   leased operation to expire without deleting its job, events, or artifacts.
2. Restore the web container to image for
   `6a630b9d7be87c5cc121477b8a639ffc531cd743`.
3. Stop or restore the Project Brain worker to the recorded prior digest.
4. Do not reverse migrations 0025 or 0026. Verify the prior web image boots
   against the forward-compatible schema.
5. Confirm remote assignments remain durable, S3 checksums remain readable,
   and canonical events and projections are preserved.
6. Resume only the prior worker set after health and readiness pass.

ECR deployment references use immutable `repository@sha256:...` values. Tags
may be published for operator convenience but are never the deployment
selector.

## Known least-privilege limitation

The single-host EC2 topology exposes one instance role and one application
database credential to its containers. The Project Brain subprocess itself
receives neither; its environment is allowlisted. Per-container IAM roles and
separate database roles require a later infrastructure isolation change and
remain a documented medium-severity limitation, not a hidden image boundary.
