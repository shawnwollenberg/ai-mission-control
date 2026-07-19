# Phase 6 Human Provider Inputs

No provider resource may be created or changed until these selections are supplied. Defaults are recommendations, not purchasing decisions.

| Input                     | Why                               | Recommended default                                                                       | Lowest acceptable                                 | Tradeoff / change later                                                         |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Render account/workspace  | Owns services and access          | Dedicated production workspace                                                            | Existing restricted workspace                     | Dedicated ownership is cleaner; movable later with work                         |
| Render region             | Private latency and data location | Same region as PostgreSQL and owner                                                       | Nearest supported region                          | Region migration is disruptive                                                  |
| Web size                  | Next.js memory                    | Starter initially                                                                         | Smallest always-on paid size                      | Scale later; free sleep is unacceptable                                         |
| Worker sizes              | Eight durable processes           | Smallest paid worker; Codex at least Standard if builds require it                        | Starter                                           | Independently changeable; Codex CPU/RAM is workload-sensitive                   |
| PostgreSQL plan/region    | Durable event source              | Paid plan with at least 7-day PITR, colocated                                             | Smallest paid PITR tier                           | Storage/connection/HA tradeoffs; upgrades easier than region moves              |
| DB retention/backups      | Recovery objective                | 7+ day PITR and storage alerts                                                            | Provider paid-tier default                        | Longer retention costs more                                                     |
| Cloudflare account/bucket | Durable artifacts                 | Dedicated `mission-control-production` bucket                                             | Dedicated production prefix in an isolated bucket | Dedicated bucket has clearer IAM/retention; name/settings are costly to migrate |
| R2 jurisdiction           | Residency                         | Match business requirements                                                               | Automatic placement if acceptable                 | Decide before data is written                                                   |
| Domain/DNS                | Stable TLS origin                 | Public `missioncontrol.wallyweb.com` plus authenticated `app.missioncontrol.wallyweb.com` | Render hostname temporarily                       | Point both names to Render; `PUBLIC_APP_URL` uses the app subdomain             |
| Uptime monitor            | Independent outage detection      | Existing trusted monitor, 1-minute HTTPS check                                            | Free external HTTPS monitor                       | Alert history and integrations vary; changeable                                 |
| Notification channel      | External safety alerts            | Dedicated Slack/Discord webhook with restricted channel                                   | Email/webhook supported by current adapter        | Easily rotated; avoid personal broad-scope tokens                               |
| GitHub repo/branch        | Exact deploy source               | Current repo, protected `production` branch                                               | Exact release commit on `production`              | Branch can change with redeploy                                                 |
| GitHub auth               | Approval-gated push/PR            | GitHub App installation scoped to initial repo                                            | Fine-grained token scoped to one repo             | App is safer to rotate/audit; token simpler initially                           |
| Owner email               | Initial identity                  | Owner-controlled production email                                                         | Same                                              | Changeable through an audited identity procedure                                |
| Session secret generation | Cookie integrity                  | `openssl rand -base64 48` into a protected file/secret prompt                             | Render-generated 256-bit value                    | Rotation logs everyone out                                                      |
| Hermes location           | Signed bridge connectivity        | Isolated worker in selected Render region                                                 | Render worker in same project                     | Can move after credential rotation                                              |
| Codex repository storage  | Clone/worktree execution          | Dedicated persistent disk, 10 GB initial                                                  | Smallest disk fitting repo/build                  | Disk can grow, not shrink; durable results must go to R2                        |

## Safe one-time secret generation

Run in a private terminal with history disabled for the command. Redirect into a mode-0600 temporary file, paste into the provider secret field, then securely remove the file. Do not pass secrets on command lines.

```bash
umask 077
openssl rand -base64 48 > session-secret.txt
openssl rand -hex 32 > agent-protocol-secret.txt
openssl rand -hex 32 > encryption-key.txt
```

Notification credentials should be generated by the chosen notification provider and copied directly into Render. Supply the owner password through stdin (`read -s`, then pipe) or a mode-0600 file referenced by `MISSION_CONTROL_OWNER_PASSWORD_FILE`; never place it in shell history.
