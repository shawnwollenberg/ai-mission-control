# Mission Agent 0.6.8 artifact identity

Mission Agent 0.6.8 adds no execution capability. It binds the exact bytes of
`public/mission-agent-0.6.8.mjs` to every signed heartbeat through detached
immutable metadata.

Packaging computes SHA-256 over the complete `.mjs` byte stream and writes
`mission-agent-0.6.8.mjs.artifact.json`. The onboarding and updater paths
verify the downloaded bytes before installing both files. At startup the
runtime hashes its own executable and refuses to advertise when it differs
from the detached metadata. Production has no environment override.

The update manifest is signed with an offline Ed25519 release key. The agent
contains only the public verification key and validates the canonical version,
path, checksum, and manifest version before downloading or activating code.
The private signing key is not stored in this repository or production image.

The heartbeat payload includes:

```json
{
  "missionAgentVersion": "0.6.8",
  "artifact": {
    "sha256": "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
    "manifestVersion": "1"
  }
}
```

The artifact object is serialized in the existing protocol envelope before
the body SHA-256 and HMAC signature are calculated. Mission Control maps the
advertised version to its approved checksum, records verification and
five-minute freshness, and refuses remote Project Brain dispatch unless the
advertised and expected checksums match.

Rollback retains both `mission-agent-0.6.7.mjs` and
`mission-agent-0.6.6.mjs`. Those versions remain usable for permitted legacy
work but cannot satisfy checksum-bound Project Brain selection.
