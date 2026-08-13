# Mission Agent 0.7.0 unsigned release candidate

- Version: `0.7.0`
- Source commit: `a6d867f217c6e28ce811fbb5b8bf8778fad193c4`
- Artifact: `public/mission-agent-0.7.0.mjs`
- Artifact SHA-256: `3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e`
- Unsigned manifest: `release/mission-agent-0.7.0/unsigned-manifest-v2.json`
- Manifest version: `2`
- Release Authority version: `2`
- Planned signing key ID: `mission-agent-release-2026-01`
- Public-key fingerprint: pending authorized human input
- Repository identity protocol: `2` (`stable-v2`)
- Activation acknowledgement protocol: `1`
- Project Brain: core `0.4.0`, consumer contract `1.0`, artifact schema `2.5.0`
- Reproducibility: passed; two detached clean builds were byte-identical
- Unit tests: 129 passed, 0 failed under Node 22.22.0
- Typecheck: passed
- ESLint: passed
- Independent security review: no unresolved critical or high findings
- Signing: unsigned
- Trust activation: pending
- Publication: blocked
- Deployment: blocked
- Rollback release: signed Mission Agent `0.6.8`

The artifact natively parses strict canonical v2 manifests, selects an explicit
trusted key by ID, applies fail-closed trust status and signature checks,
advertises its immutable release identity, and preserves stable-v2 repository
identity, governed activation, and Project Brain execution.

The authenticated heartbeat binds this shape inside the existing signed
protocol envelope:

```json
{
  "missionAgentVersion": "0.7.0",
  "artifact": {
    "sha256": "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e",
    "manifestVersion": "2",
    "signingKeyId": "mission-agent-release-2026-01",
    "releaseAuthorityVersion": "2",
    "sourceCommit": "a6d867f217c6e28ce811fbb5b8bf8778fad193c4"
  },
  "release": {
    "authorityVersion": "2",
    "manifestVersion": "2",
    "signingKeyId": "mission-agent-release-2026-01",
    "sourceCommit": "a6d867f217c6e28ce811fbb5b8bf8778fad193c4"
  },
  "repositoryIdentity": {
    "stableProtocolVersion": "2",
    "activationAcknowledgementVersion": "1"
  },
  "projectBrain": {
    "coreVersion": "0.4.0",
    "contractVersions": ["1.0"],
    "schemaVersions": ["2.5.0"]
  }
}
```

This record is release evidence, not a trusted release manifest. Mission
Control, onboarding, and Mission Agents must never treat it as installation
authority.

## Pending-key insertion

After the authorized human provides the DER SPKI public key, its fingerprint,
and completed custody approval, add a complete `pending` record at
`RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT` in both the Mission Control
trust store and the deterministic 0.7.0 generator. Do not set `activatedAt`.

Validate the record and unchanged historical releases with:

```sh
npm run test:release-authority
npm run test:mission-agent-070
```

An incomplete record, fingerprint mismatch, non-Ed25519 public key, activated
pending record, or unknown key ID fails closed.

The positive active-key signature fixture remains a post-ceremony gate: it
requires only the human-returned public key and signature. No private or
ephemeral signing key was generated to manufacture that fixture.
