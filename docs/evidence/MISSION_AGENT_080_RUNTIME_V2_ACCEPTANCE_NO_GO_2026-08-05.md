# Mission Agent 0.8.0 runtime-v2 disposable acceptance — NO-GO

**Disposition:** permanently NO-GO for objection live/replay divergence and durable lease-token exposure
**Production authority:** none; production was not contacted
**Application server:** stopped after the failed acceptance
**Source base:** `33d4bcd62789f767a7bbe9b1f7588eee4f0f0549`

This record preserves the failed acceptance of the exact runtime-v2 candidate. It does not supersede or erase the earlier sandbox-incompatibility NO-GO packet, and it is not approval for a corrected candidate.

## Frozen candidate

- Artifact: `public/mission-agent-0.8.0-runtime-v2.candidate.mjs`
- Artifact SHA-256: `1b0c2549989b3a298bd7e510526b5fcb06e889c926a15d5c7a28b9f2a44e95ee`
- Artifact metadata SHA-256: `25a73475a7e7181e83f0e84c23f74d86074899c4bc4761232974d3f727679621`
- Capability manifest SHA-256: `95a0298a4f6fd6c40bdffdd454057959b1fa4adc25e18fbfac53343c52c63222`
- Evidence root: `/private/tmp/mission-control-runtime-v2-acceptance-20260804`
- Disposable database retained for review: `mc_runtime_v2_acceptance_20260804`

## Acceptance outcome

Real Codex and Claude Code proposal, critique, revision, synthesis, and verdict turns ran with the approved requested models. Both exact-plan verdicts were non-rejecting. The mission still ended `consensus_not_reached`; no human approval and no child implementation occurred.

Two independent release-blocking HIGH findings caused the stop:

1. Live projection inserted raw provider objection labels while replay inserted event-prefixed labels. Revision resolution therefore updated zero live rows and live/replay identities diverged.
2. Ten expired `agent_protocol_receipts.acknowledgement` rows durably retained raw assignment lease bearer tokens.

The discovery harness also used the Codex planning model for implementation-profile cancellation and timeout probes. Those lifecycle results are not accepted as executor-profile evidence.

## Secret-scope finding

The ten raw bearer tokens are retained only in the disposable database named above. Pattern scanning of the retained local evidence root found no raw `mc_lease_` value in agent state, evidence JSON, provider reports, artifacts, or logs. The packaged runtime source necessarily contains the literal protocol field and token-prefix implementation strings; those are code, not captured credentials. Mission Agent credential scans reported zero exact matches.

## Retention and destruction procedure

Retain the database and evidence root unchanged until the corrected candidate has completed its independent review and the release owner explicitly authorizes evidence destruction. Destruction is not part of this development authorization.

When separately authorized, the operator must:

1. Record final hashes and the authorization approving destruction.
2. Stop every process connected to `mc_runtime_v2_acceptance_20260804` and verify zero active sessions.
3. Drop only that exact disposable database; never use a wildcard or production connection.
4. Remove only `/private/tmp/mission-control-runtime-v2-acceptance-20260804` after confirming the path and retained hash record.
5. Verify the database and directory are absent and record completion without reproducing token values.

No cleanup step above has been executed. No repository change was staged or committed, and no artifact was signed, published, pushed, registered again, or deployed.

The corrected development migration now requires protocol traffic to be drained, rejects any unexpired legacy receipt
that does not satisfy receipt v2, deletes only expired invalid operational receipts, and validates the structural
constraint before completing. That forward-cleanup behavior has **not** been applied to
`mc_runtime_v2_acceptance_20260804`; this retained database remains frozen evidence until the separately authorized
destruction procedure above is executed.
