# R-2026-08-14 — Mission Agent 0.8 onboarding compatibility correction

**Classification:** Security-sensitive application and agent-runtime delivery release

**Human authorization:** On 2026-08-14 the human operator authorized the exact narrow production correction after a
production WalletLens mission proved that guided onboarding still installed Mission Agent 0.7.2, which cannot present
Runtime-v6 assignment fencing authority. The authorization covers documentation, focused validation, commit, push,
protected-branch review/merge, established production deployment, reconnecting the WalletLens agent, cancelling the
unrecoverable 0.7.2 execution, and creating one fresh governed mission. It does not broaden agent authority or authorize
unrelated production changes.

## Proven regression

- Mission `14bbb618-dd9e-441f-be9e-8f905e33ab9f` remained running with execution
  `4f8625d6-9996-455c-a8bf-8724abd07329` and assignment `bff237ec-caa7-43fe-833f-79482aac6ade`.
- The connected 0.7.2 agent received the assignment but failed before provider execution with
  `Assignment fencing token is stale or missing`.
- Runtime-v6 correctly requires the assignment fencing presentation. Mission Agent 0.7.2 does not send that authority;
  the signed 0.8.0 artifact does.
- The onboarding command also invoked its downloaded artifact through a noncanonical macOS temporary path and did not
  install the immutable 0.8 metadata and capability sidecars required after service start.

## Exact correction

- Keep the already signed Mission Agent 0.8.0 artifact unchanged:
  `c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494` (346937 bytes).
- Publish the already signed Manifest v3 bundle as `mission-agent-latest.json`.
- Download and verify the exact artifact, metadata sidecar
  `6455ae5f4fa0fa5c7dffd2e1069092d11b9834616fdd93ae6cdfdcc714c419a1`, and capability sidecar
  `aae4fe13b7cb613131accb870cbebb57cefbad4a955739fe85776a4488267394`.
- Preinstall both immutable sidecars in the selected `MISSION_AGENT_HOME` before service creation.
- Invoke the downloaded artifact only through `realpath` so the guarded CLI entry point executes on macOS.

No capability, provider/model assignment, lease, fencing, repository, filesystem, validation, publication, merge,
deployment, infrastructure, credential, or production authority changes.

## Acceptance criteria

1. The latest manifest is byte-identical to the signed 0.8.0 manifest.
2. Onboarding verifies all three exact downloaded byte identities before use.
3. The installer home contains immutable metadata and capability sidecars before the service can start.
4. The guarded CLI is invoked through its canonical real path.
5. Existing artifact signature/trust, onboarding, Mission Agent 0.8, type, lint, format, build, and security-focused tests pass.
6. Production health remains green; the reconnected WalletLens agent reports 0.8.0, fresh heartbeat, pull readiness, and
   the exact repository registration.
7. The old execution is cancelled through the governed product boundary, a fresh mission is created, and provider work
   begins only under the 0.8 fencing contract.

## Rollout

Merge only after protected-branch CI passes. Deploy the exact merged image through the established digest-pinned
production procedure without migrations. Verify health/readiness and the three published 0.8 files before reconnecting
the agent. Cancel/recreate only after the 0.8 heartbeat and repository registration are authoritative.

## Validation evidence

- Focused artifact/onboarding/0.8 trust slice: 27/27 passed.
- Full unit suite: 203/203 passed.
- Serial integration suite: 100/100 passed.
- Durable browser E2E, including guided onboarding and pulled repository work: 2/2 passed.
- Migration status: 31 applied, 0 pending.
- TypeScript, ESLint, Prettier, syntax/diff checks, and production build: passed.
- Signed latest manifest is byte-identical to `release/mission-agent-0.8.0/signed-manifest-v3.json`.

## Rollback

Restore the prior application image digest
`sha256:2e63603e0a614d3edba54d79f2f2ccd82e61b970fd89e524dc84e194a4a101a0`, stop new onboarding, and leave existing
credentials, repositories, events, and schema intact. The prior image remains Runtime-v6-incompatible for new 0.7.2
agents, so rollback is an availability containment measure while repairing forward, not a compatibility resolution.
