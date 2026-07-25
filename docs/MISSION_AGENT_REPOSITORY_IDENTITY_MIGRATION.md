# Mission Agent repository identity migration

## Decision

Legacy Mission Agent registrations use `legacy-v1`, a commit-bound fingerprint.
The target `stable-v2` identity is the SHA-256 of:

```text
<canonical remote identity>
<repository name>
```

The migration updates the active fingerprint on the existing repository row.
It does not replace the repository ID, agent association, registered checkout
path on the agent, permissions, Project Brain state, or any related mission,
execution, approval, artifact, or audit record.

The server's `mission-agent://` locator changes with the active fingerprint.
That locator is not a filesystem path. The separately approval-bound
`registered_path` remains unchanged on the Mission Agent.

## Canonicalization

- HTTPS, HTTP, SSH, Git, and SCP-style Git URLs are accepted.
- Credentials and schemes do not participate in identity.
- Hostnames are lowercase.
- Leading/trailing slashes and one trailing `.git` are removed.
- The remaining owner/path and repository name are NFC-normalized and
  case-sensitive.
- `origin` wins when present exactly once. Without `origin`, exactly one remote
  is required.
- Missing remotes, multiple non-origin remotes, renamed checkout/remote pairs,
  and local-only repositories fail closed.
- The full canonical remote path participates in the fingerprint, so forks and
  equal directory names remain distinct.

## Governed sequence

1. While the legacy agent remains installed, run the independently checksummed
   `repository-identity-migrator-1.mjs preview --repository <id>`.
2. Mission Control and the tool independently derive the stable identity.
3. The preview records a canonical event and returns the exact request
   fingerprint. It performs no identity mutation.
4. A workspace owner approves that exact fingerprint through the dedicated
   repository-identity approval endpoint. General repository approvals do not
   apply.
5. Run `repository-identity-migrator-1.mjs complete --repository <id>`.
6. The tool re-inspects the checkout. Mission Control rechecks ownership,
   authority, active work, expiry, and every approval-bound value.
7. Only then does the existing repository row activate `stable-v2`.
8. Upgrade only to an approved Mission Agent artifact that natively derives
   and advertises `stable-v2`.

The migrator keeps the pending preview in the agent's mode-0600 configuration.
On completion it preserves the old fingerprint in `identityHistory`, changes
only the active fingerprint/version, and retains the checkout path and all
other repository configuration.

## Approval binding and eligibility

The canonical request fingerprint binds repository ID, agent ID, legacy and
stable fingerprints, canonical remote, repository name, registered checkout
path, current HEAD, selected remote, every repository authority flag, and
Project Brain enablement. Approval expires after 15 minutes. Any mismatch
requires a new preview and approval.

Migration is rejected when the mapping is not owned by the authenticated
agent, the legacy identity differs, the canonical identity is ambiguous,
Mission Control derives different inputs, an execution or lease is active,
authority changed after approval, approval is stale, or callback contents
differ.

## Events, projection, and rollback

Canonical version-1 events are:

- `repository.identity_migration.previewed`
- `repository.identity_migration.requested`
- `repository.identity_migration.approved`
- `repository.identity_migration.started`
- `repository.identity_migration.verified`
- `repository.identity_migration.completed`
- `repository.identity_migration.rolled_back`

`repository_identities` retains both versions and their verification metadata.
`repository_identity_migrations` is a rebuildable projection of the governed
workflow. Replay from the canonical events produces byte-for-byte equivalent
identity and migration rows.

Before acceptance, the owner-only rollback command restores `legacy-v1` as the
active fingerprint and locator while retaining stable identity evidence and
the complete audit stream. It never changes permissions or deletes history.

## Packaging and rollback

The approved Mission Agent 0.6.8 artifact remains unchanged:

```text
e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d
```

The one-shot migration tool is versioned and checksummed separately in the
Mission Control release. It is not a Mission Agent replacement and does not
run automatically. Agent 0.6.4 remains the rollback target until the one-agent
acceptance succeeds; 0.6.7 and 0.6.6 artifacts remain available under their
existing release policy.

## Superseded pre-0.6.9 acceptance blocker

The approved byte-identical Mission Agent 0.6.8 artifact does not natively
derive canonical `stable-v2`; it still re-inspects repositories using its
earlier raw-remote hash. The one-shot migrator can prove and stage the
canonical identity, but it cannot safely make that legacy-native runtime own
the identity across refresh, restart, and Project Brain execution.

Mission Control rejects a post-migration legacy refresh rather than creating a
second repository ID. Production activation nevertheless remains blocked
until a checksum-bound Mission Agent artifact natively supports `stable-v2`
and a two-phase activation acknowledgement keeps all dispatch paths closed
during cutover. The current branch must not be deployed as a completed
migration release. The unsigned 0.6.9 release candidate implements that
two-phase behavior, but remains untrusted and blocked from publication or
installation until its manifest is signed by an approved release key.

Migrator v1 checksum:

```text
92528dbd0e6bebafbcd2d5bf9912e274aa91b2f8a05a2eab9a4f402de67551c1
```

Because the existing 0.6.8 release signing key is offline and the approved
agent artifact remains unchanged, the migrator is not part of that signed
release manifest. Operators must obtain the checksum above through the
reviewed release record, download to a fresh temporary directory, verify the
exact bytes with `shasum -a 256 -c`, and only then run it. The tool refuses to
run automatically or as a background service.
