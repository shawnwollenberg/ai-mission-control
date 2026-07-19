# Phase 6 Deployment Target Review

Status: recommendation only. No infrastructure has been provisioned.

## Recommendation

Use Render for the Next.js web service, eight long-running worker processes, and managed PostgreSQL. Use a persistent disk only for the Codex worker's temporary worktrees. Store durable artifacts in Cloudflare R2 through its S3-compatible API. Terminate TLS at Render and keep PostgreSQL and worker traffic on Render's private network.

This topology keeps the modular monolith intact, gives every process an explicit restart policy and log stream, and avoids treating an ephemeral filesystem as durable storage. Fly.io remains viable, but its host-bound volumes require more owner-operated replication and recovery work. A serverless-only target is rejected because it does not fit long-running workers or controlled Codex processes.

## Inventory

| Concern          | Selected approach                                           | Notes                                                                                         |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Compute          | Render services                                             | Web plus generic, Codex, action, remote delivery, Hermes, scheduler, and notification workers |
| Database         | Render PostgreSQL (paid tier with PITR)                     | Private connection, TLS, dedicated app and migration roles                                    |
| Artifacts        | Cloudflare R2, dedicated production bucket                  | S3 API, workspace-scoped keys, checksums, encryption                                          |
| Secrets          | Render environment group and service-scoped secrets         | Separate production values; never committed                                                   |
| Domain/TLS       | Owner-selected domain, Render TLS                           | Exact domain remains unselected                                                               |
| Codex filesystem | Render persistent disk                                      | Temporary worktrees only; artifacts uploaded to R2                                            |
| Logs             | Render structured service logs                              | External retention destination must be selected before launch                                 |
| Monitoring       | Render health check plus independent external HTTPS monitor | Vendor and alert destination remain unselected                                                |
| Backups          | PostgreSQL PITR plus isolated restore drill                 | R2 durability is not a substitute for a tested DB restore                                     |

## Cost and complexity

Planning estimate, not an invoice: **$83–$140/month required baseline**. This assumes a Starter web service (about $7), six Starter light workers (about $42 total), an isolated larger Codex worker (roughly $25–$50), entry paid PostgreSQL with PITR (roughly $6–$20), and a 10 GB disk (roughly $2.50). R2 should initially remain near $0–$5 at its published storage/operation rates. A free or existing uptime monitor and low-volume webhook notification can be $0; paid monitoring, email, and extended log retention are optional upgrades of roughly $0–$50+. Bandwidth, build minutes, artifact operations, log volume, and Codex workload are usage-based or unknown.

The smallest technically possible layout puts every process on Starter and is approximately $65/month before monitoring and usage, but it is not recommended until Codex build memory has been measured. Services cannot share a Render worker instance in this Blueprint: that separation makes restarts, identity, variables, and job ownership understandable. Scheduler, notification, Hermes, remote delivery, action, and generic workers are individually small; Codex must remain isolated from web and is the first sizing variable to measure.

## Required decisions before provisioning

- Production domain and DNS owner
- Render team/region and service sizes
- PostgreSQL plan, retention, connection limits, roles, and alerts
- R2 account, region policy, bucket retention, and credentials
- External monitor and notification destination
- Log retention destination and authorized viewers
- Explicit authority to provision infrastructure, configure secrets, and deploy

## References

- https://render.com/docs/background-workers
- https://render.com/docs/disks
- https://render.com/docs/private-network
- https://render.com/docs/health-checks
- https://render.com/docs/postgresql-backups
- https://developers.cloudflare.com/r2/how-r2-works/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/reference/data-security/
