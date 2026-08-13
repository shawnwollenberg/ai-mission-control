# R-2026-08-13 — Mission Agent 0.8 production publication and read-only onboarding

**Classification:** Security-sensitive application release

**Human authorization:** On 2026-08-13 the human operator directed Codex to
drive governed signed Mission Agent 0.8 publication and one deliberately
non-destructive production Consensus Plan. The operator separately
authenticated to the production signer profile and explicitly approved KMS
signing of canonical manifest
`a28877d5358a9fb46848d2a2b9047848d35637427c51b2d16d35404b1e147482`
for artifact
`c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494`.
This authorization covers publication of those exact signed bytes, production
capability onboarding for the frozen Fable/Sol/Fable/Luna role assignments,
and one read-only planning mission. It does not authorize an implementation
child, repository mutation, commit, push, pull request, merge, deployment, or
broader provider authority.

## Exact release

- Version: 0.8.0
- Artifact bytes: 346937
- Artifact SHA-256:
  `c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494`
- Capability manifest SHA-256:
  `aae4fe13b7cb613131accb870cbebb57cefbad4a955739fe85776a4488267394`
- Canonical unsigned manifest SHA-256:
  `a28877d5358a9fb46848d2a2b9047848d35637427c51b2d16d35404b1e147482`
- Signed bundle SHA-256:
  `51f8f65b8e7edd9ccde544a2aac9756b2b9fb18bd8ce33c59e6366ab67fa26de`
- Signature SHA-256:
  `f125e71b8eca41a12fa176a8f436af457fa36c4cfe897ee700e98192b643974e`
- KMS Sign request: `d490053b-36c2-4ac7-ab5e-33619fab9191`
- KMS Verify request: `6c053238-280c-4919-bbee-34b63f12fc8b`
- Release key: `mission-agent-release-2026-01`
- Public fingerprint:
  `ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b`
- Validity: 2026-08-13T15:30:00Z through 2026-09-12T15:30:00Z

Two independent clean Node 22.22 builds produced identical artifact bytes.
KMS Verify, local Ed25519 verification, and Mission Control production
selection passed. Exact release evidence is retained under
`release/mission-agent-0.8.0/`.

## Production boundary

The first production Consensus Plan is planning/read-only. It may inspect the
selected repository, produce two proposals, critiques, revisions, canonical
synthesis, verdicts, validation recommendations, and Project Brain
learning/evidence. It must not receive or exercise implementation, publication,
merge, deployment, infrastructure, credential, or signing authority. Fallback
is disabled. Any later implementation path requires a separate human decision.

## Rollout and rollback

Publish the exact artifact and signed Manifest v3 at the versioned governed
distribution path. Keep the legacy guided-onboarding `latest` pointer on 0.7.2
because that path does not carry Runtime-v6's required exact model binding.
Onboard only exact capability attestations for Claude Code
2.1.224 / `claude-fable-5`, Codex CLI 0.146.0 / `gpt-5.6-sol`, Claude Code
2.1.224 / `claude-fable-5`, and Codex CLI 0.146.0 /
`gpt-5.6-luna`. For rollback, stop new claims, drain leases through the
protocol, restore signed 0.7.2, retain credentials/repositories/events/schema,
and rebuild projections. No destructive migration rollback is authorized.
