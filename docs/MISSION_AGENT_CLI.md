# Mission Agent CLI

Mission Agent is Mission Control's outbound-only local runtime. One Mission Agent represents one local execution environment and can manage multiple Git repositories:

```text
One local machine → One Mission Agent → Multiple registered repositories → Missions select a repository
```

## Connect

Create an account, choose Codex, and use either supported setup:

```bash
# Option 1: run from the first repository
cd /path/to/repository
<generated connection command>

# Option 2: provide the repository explicitly
<generated connection command> --repository /absolute/path/to/repository
```

The generated command downloads a checksummed immutable Mission Agent release, stores the credential, registers the first repository, installs the stable `mission-agent` command under `~/.local/bin`, sends a signed heartbeat, and starts outbound assignment polling. No inbound port is required. The stable launcher can upgrade to the current release with `mission-agent update`; the current published release is 0.6.3.

If no Git repository is found, run from inside one or provide `--repository /absolute/path/to/repository`.

## Commands

```text
mission-agent connect <one-time-config> [--repository /path] [--no-start]
mission-agent install
mission-agent run [--once]
mission-agent status
mission-agent doctor
mission-agent repository list
mission-agent repository add /path/to/repository
mission-agent repository remove <repository-id>
mission-agent repository inspect <repository-id>
mission-agent update
mission-agent logout --yes
```

The stable executable resolves the active immutable version internally. Users do not need to know the artifact filename. If `~/.local/bin` is not already on `PATH`, connection prints the directory to add.

Existing users do not reconnect when upgrading. Run `mission-agent update` to download and verify the release identified by `mission-agent-latest.json`, then reinstall the user service if the command asks you to activate the new executable there. The update preserves the existing credential, heartbeat identity, and repository configuration.

## Add repositories

Do not create another agent for another project on the same computer. Add the repository to the existing agent:

```bash
cd /path/to/another/repository
mission-agent repository add .
```

Mission Agent registers the display name, normalized remote identity, branch, commit, fingerprint, and local capabilities. The full local path stays in protected local configuration and is not displayed in Mission Control's public UI.

## Credentials and services

On macOS, Mission Agent prefers Keychain and keeps nonsecret configuration in an owner-only file. On Linux, configuration uses mode `0600` inside an owner-only directory. Normal onboarding installs a launchd or user-systemd service where available. `mission-agent run` is the foreground diagnostic mode.

`logout --yes` removes local Mission Agent configuration and its local credential. Revoke the server credential from Agent Registry when retiring a machine.

## Troubleshooting

Run `mission-agent doctor`. It checks Node, protected configuration, credential access, Git, Codex, repository accessibility, and signed Mission Control heartbeat. A heartbeat alone does not unlock a repository mission: pull readiness and at least one eligible registered repository are also required.

## Repository workflow

Repository Analysis is read-only and produces a Markdown report, structured Recommendations, and evidence-backed Repository Health observations. A Recommendation can create a Repository Change Mission with its objective, evidence, acceptance criteria, and suggested validation already linked.

A Change Mission first produces a read-only implementation plan. Mission Control requests an exact `repository.modify` approval before Mission Agent creates an isolated worktree, modifies files, validates the result, and creates one local commit. The registered source checkout remains unchanged.

When the local result is ready, **Publish for Review** is a second approval. Mission Agent 0.6.3 revalidates and pushes only the approved mission commit without force, then opens the approved pull request using the owner's local GitHub CLI authentication. Mission Control independently confirms the pull request. Merge, deployment, infrastructure or secret modification, and transaction signing or submission remain unavailable.

## FAQ

### Do I need one Mission Agent for every repository?

No. One Mission Agent can manage multiple repositories on the same machine. The first repository is registered during connection. Add more with `mission-agent repository add`.

### Do I need one agent per computer?

Usually, yes. A Mission Agent represents a local execution environment. Connect another for a different computer, server, or isolated execution environment.
