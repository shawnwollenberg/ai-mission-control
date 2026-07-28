# Future Hardening Roadmap

Each item lists risk, deferral reason, trigger, rough effort, dependencies and
priority.

## Recommended shortly after first production use

- Reproducible application/image build: supply-chain ambiguity; deferred for
  rollout speed; trigger after first accepted canary; medium effort; hermetic
  CI required; P1.
- Independent deployment-attestation service: shared verifier compromise;
  deferred for solo operation; trigger second engineer; medium; workload
  identity and trust-store design; P1.
- Immutable audit bucket with short Object Lock period: evidence deletion;
  deferred because owner-only; trigger recurring production operations;
  medium; S3 lifecycle/KMS; P1.
- Secure Enclave operator host key: copied credential risk; deferred while the
  existing owner credential is adequate; trigger repeated rollout use; medium;
  key registration/recovery; P1.

## Required before managing other users' Macs

- Apple Developer ID signing, notarization and hardened runtime: binary
  substitution/malware warnings; high effort; Apple account/entitlements; P0.
- Signed installer/update channel, operator release governance and revocation:
  malicious/downgraded operator; medium-high; release authority; P0.
- Customer-specific host/operator identities and tenant isolation:
  cross-customer authorization; high; tenancy model; P0.
- Stronger secrets storage and recovery: credential theft/loss; medium; Secure
  Enclave/Keychain lifecycle; P0.
- Support and incident workflow: unresolved rollback/customer impact; medium;
  staffing/escalation; P0.
- Managed-device/MDM distribution, tamper detection, protected logs/journal,
  and operator auto-update with rollback: unmanaged drift; high; signed
  releases and MDM; P1.

## Required before multi-agent or fleet rollout

- Fleet-scoped authorization, waves, concurrency limits, blast-radius policy,
  canary groups and automatic pause: mass mutation; high; fleet data model; P0.
- Rich health evaluation and operator-version governance: unhealthy rollout;
  medium; telemetry/version policy; P0.
- Multi-task elected controllers with database fencing: split brain; high;
  controller epochs and HA tests; P0.
- Regional/account separation and formal disaster-recovery tests: regional or
  account failure; high; infrastructure-as-code/backups; P1.

## Stronger supply-chain hardening

- Signed OCI artifacts and Sigstore/equivalent verification: registry
  substitution; medium; CI identity/transparency log; P0 before customers.
- SLSA-aligned provenance and isolated CI release environment: compromised
  builder; high; CI redesign; P1.
- Two-person approval and hardware-backed release signing: insider/key risk;
  medium; multiple engineers/custody; P1 when team grows.
- Dependency/base-image policies and automated rebuild review: vulnerable or
  drifting inputs; medium; SBOM/scanner; P1.

## Stronger cloud runtime assurance

- Stronger workload identity and dedicated attestation service: compromised
  task self-report; medium; ECS/IAM; P1.
- Hardware-rooted measurement where required: host/runtime substitution; high;
  Nitro/enclave or alternative architecture; P2 unless threat model changes.
- Cross-account verification, AWS Organizations and SCP controls: account
  administrator blast radius; high; multi-account organization; P1 commercial.

## Stronger audit and compliance

- Dedicated immutable audit bucket, Object Lock, long-term retention,
  centralized monitoring and escalation: deletion/non-detection; medium-high;
  security account/SIEM; P0 before regulated customers.
- Periodic access reviews, evidence export and legal hold: compliance and
  discovery gaps; medium; identity governance/legal policy; P1.
