# Mission Agent V1 macOS Operator

The v1 operator is an attended, same-user, fixed-purpose process for Shawn's
single named Mission Agent. It is not a remote shell, fleet agent, privileged
helper, or general updater.

## Boundary

The executable is installed only at:

```text
/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs
```

The parent directory is owner-only mode `0700`; the artifact is owner-only mode
`0500`; root execution is rejected. Before every request the operator verifies
Darwin, the exact owner UID, path, owner, permissions, and artifact SHA-256.
The installer has one compiled source and one fixed destination. It does not
accept a destination, executable, shell fragment, launchd label, or user.

Apple Developer ID signing, notarization, hardened runtime, and unattended
distribution remain explicitly deferred for this one owner-controlled Mac.
The accepted v1 trust roots are the exact checksum, owner account, permissions,
fixed path, authenticated request, and local journal. Those deferrals become
blockers before another user's Mac is supported.

## Operation vocabulary

The authenticated protocol permits only:

```text
observe
request_drain
verify_drain
lease_intent
renew_lease
stage_artifact
verify_artifact
stop_agent
install_agent
install_launch_configuration
start_agent
verify_process
collect_heartbeats
verify_capabilities
remove_staged_artifact
restore_previous_launch_configuration
restore_previous_version
verify_rollback
release_lease
```

Control-plane operations cannot enter the host mutation provider. Host
operations map to the existing reviewed fixed-path macOS provider. It uses only
the exact Mission Agent paths, exact 0.7.2 artifact and checksums, exact rollback
inventory, fixed `launchctl`, `security`, `plutil`, `ps`, `tar`, `id`, `uname`,
and `scutil` executables, and fixed argument shapes. It exposes no general
process control, file destination, Keychain read, or command execution.

## Request and recovery

Each authenticated request binds the named agent, target artifact, prior
inventory, authorization fingerprint, fencing generation, provider mutation
ID, exact sequence, message ID, nonce, operator identity, and Mission Control
deployment identity.

Before a provider mutation, the operator atomically records an authenticated
intent in its mode-0600 journal and requires Mission Control to transactionally
confirm the exact fencing generation, request checksum, and monotonic journal
head. It inspects the exact precondition before executing. If the operator or
Mission Control stops after provider success but before receipt delivery,
restart inspection detects the postcondition, writes or reuses the
checksum-bound receipt, and does not repeat the mutation.
Contradictory or ambiguous state stops for human intervention.

Forward mutation expires normally. An expired request can never create a new
intent; only an exact request already present in the authenticated journal may
enter recovery, and it still requires a fresh controller confirmation. The
exact rollback operations remain usable only when the request carries the
durable rollback-obligation ID. Rollback authority does not permit another
forward mutation.

The journal is HMAC-authenticated and hash-chained. It rejects sequence gaps and
reuse of a nonce, request message ID, or provider mutation ID. Receipts are
write-once files indexed by provider mutation ID. Each receipt is
HMAC-authenticated over its complete result and the exact request and journal
intent checksums; recovery recomputes the result checksum before trusting it.
The process lock binds both PID and process-start identity so PID reuse cannot
strand a stale lock. Logout, restart, and temporary Mission Control loss do not
erase intent, completion, or rollback state.

## Build and install

Build:

```bash
npm run build:v1:operator
```

The command produces the bundled artifact and checksum record under `dist/`.
Installation is a separate attended action:

```bash
node scripts/install-v1-macos-operator.mjs
```

Do not install it during implementation or staging review. Installation on the
real canary requires separate explicit authorization after ECS identity,
migration, and read-only preflight gates pass.
