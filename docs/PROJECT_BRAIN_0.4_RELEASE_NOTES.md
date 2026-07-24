# Project Brain 0.4 Mission Control release notes

Status: release candidate blocked during production acceptance.

The candidate adds an optional Project Brain 0.4 consumer adapter, repository knowledge/status views, mission
context preview and evidence presentation, a read-only learning inbox projection, strict JSON envelopes, bounded
local execution, and checksum/HEAD binding.

Production acceptance confirmed the core contract, tests, build, migrations, clean installation, and disposable
context lifecycle. It also found that the adapter currently runs from the web tier, lacks durable audit/projection
persistence, bypasses repository write policy, and does not deliver the verified pack through execution dispatch.

Operators must not enable or deploy this candidate. Complete the targeted worker/outbox repair documented in
`PROJECT_BRAIN_0.4_PRODUCTION_ACCEPTANCE.md`, resolve the existing high-severity Next.js/sharp advisories, and rerun
acceptance before release.
