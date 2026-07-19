# Mission Agent CLI

Mission Agent is the outbound-only local runtime for Mission Control. The five-minute path is:

1. Create an account and choose **Codex**.
2. Open a terminal in a safe local Git repository.
3. Copy the versioned, checksummed command from onboarding and run it once.
4. Wait for **Heartbeat received** and **Assignment channel ready**.
5. Select the registered repository and launch **Analyze this repository**.

The generated command downloads `mission-agent-0.1.0.mjs`, verifies its published SHA-256 checksum before execution, stores the credential, registers the current repository by fingerprint, starts Mission Agent, sends a signed heartbeat, and begins bounded assignment polling. It does not require cloning this repository or exposing an inbound port.

## Commands

```text
mission-agent connect <one-time-config> [--repository /path] [--no-start]
mission-agent run [--once]
mission-agent status
mission-agent doctor
mission-agent repository add /path/to/repository
mission-agent logout --yes
```

The downloaded executable is stored under `~/.mission-agent/`. Invoke it with Node 22, or create a local shell alias named `mission-agent`. `status` shows the URL, agent, adapter, connected state, last heartbeat, polling state, active assignment, lease expiration, stage, last error, and version. It never prints credentials.

## Credential storage

On macOS, Mission Agent prefers Keychain and keeps nonsecret configuration in an owner-only file. On Linux, the complete configuration uses mode `0600` inside an owner-only directory. Mission Agent refuses configuration or state files readable by group or other users. Windows is experimental and not part of the first supported boundary.

`logout --yes` removes only local Mission Agent configuration and its local credential. Revoke the server credential from Agent Registry when retiring an agent. Credential rotation remains controlled from Mission Control; reconnect using the newly generated command after rotation.

## Foreground and service operation

`mission-agent run` keeps the process in the foreground for diagnostics. Normal onboarding starts it in the background. The supported service definitions use the same protected configuration and restart after failure. Logs contain bounded stages and redacted errors, never credential material, raw prompts, full source, or unrelated command output.

## Updating

Reconnect using the latest command shown by Mission Control. Each published executable has an explicit version and checksum. The installer never executes an unverified download.

## Troubleshooting

Run `mission-agent doctor`. It checks Node 22, configuration permissions, credential access, Mission Control reachability and signature acceptance, Git, Codex, repository accessibility, and the local artifact directory. Clock-skew and revoked-credential responses are actionable and secret-safe. A connected Hermes, Claude Code, or generic adapter reports that local execution support is not yet available rather than pretending to execute.
