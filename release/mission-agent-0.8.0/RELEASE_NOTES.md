# Mission Agent 0.8.0

Mission Agent 0.8.0 is the signed production client for the Runtime-v6
Consensus Plan control plane.

## Capabilities

- Authenticated Claude Code and Codex provider discovery with exact supported
  CLI/runtime bindings.
- Explicit planner A, planner B, synthesizer, and executor role/model
  attestations with fallback disabled.
- Governed two-planner proposals, critiques, revisions, canonical synthesis,
  exact-plan verdicts, and Project Brain context/evidence.
- Bounded, lease- and fencing-protected execution through the existing Mission
  Agent protocol.

This release does not broaden repository, publication, merge, deployment,
infrastructure, credential, signing, or production authority. Capability
eligibility remains server-selected and attestation-bound.

## Compatibility

- Mission Control minimum version: 0.1.0.
- Runtime-v6 production control plane source:
  `8a210b2ce26555e19f2c585f6281017ae8fbec3c`.
- Identity protocol: 2.
- Activation protocol: 1.
- Runtime: Node.js 22 on supported Darwin/Linux distribution platforms.
- Exact provider runtime bindings remain Claude Code 2.1.224 and Codex CLI
  0.146.0 for the approved Consensus roles.

## Upgrade

After the signed manifest is separately published, an existing 0.7.2 client
uses `mission-agent update`. The updater must verify the Manifest v3
signature, embedded production trust key, artifact name, byte length, checksum,
platform, protocol compatibility, and minimum Mission Control version before
installing. Existing credentials and repository registrations are preserved.

## Rollback

Stop assignment claims, drain or cancel active leases through the governed
protocol, and restore signed Mission Agent 0.7.2. Preserve credentials,
repository mappings, canonical events, additive database migrations, and
Project Brain evidence. Rebuild projections and verify heartbeats after
rollback. Do not destructively reverse production schema or history.

## Initial production boundary

The first production Consensus Plan is planning/read-only. It may inspect the
selected repository and produce governed planning and Project Brain evidence.
It may not create an implementation child, mutate files, commit, push, open a
pull request, merge, deploy, or expand authority.
