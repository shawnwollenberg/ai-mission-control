# Mission Agent First-Mission Production Acceptance

**Accepted:** 2026-07-19  
**Production revision:** `f26e726`  
**Application:** `https://app.missioncontrol.wallyweb.com`

## Result

A fresh production canary account completed the entire outbound-only onboarding path on the existing AWS `t4g.small` deployment. The local runtime ran behind ordinary NAT with no inbound listener or tunnel. The installed Codex CLI inspected the Mission Control public repository in read-only mode and returned checksummed Markdown artifacts through Mission Control Agent Protocol 1.0.

## Evidence

| Run           | Mission                                | Execution                              | Artifact                               | Result    |
| ------------- | -------------------------------------- | -------------------------------------- | -------------------------------------- | --------- |
| First mission | `b8e89b51-e4db-46da-bb46-2ebb082f3c1b` | `47902762-c6ba-467d-8c7a-002d0f72c903` | `e0401fa2-0053-4258-8f30-38e137e2cb61` | completed |
| Restart run   | `964c8b7a-4d59-402e-bd82-bf530be9e4c3` | `73052d91-8acf-439a-96aa-732d3bc10006` | `6860a570-b154-4431-8f1a-58e12bcd08e3` | completed |

The executions and artifacts are distinct. The second mission ran in a new CLI process, proving that protected local configuration survives process restart without reclaiming completed work.

## Acceptance sequence

1. Registered a new member and confirmed its isolated personal workspace.
2. Confirmed all five starter Mission Templates.
3. Selected Codex and generated the versioned, checksummed one-command installer.
4. Connected Mission Agent from a local Git repository.
5. Confirmed a signed heartbeat, Mission Agent `0.1.0`, Codex adapter, and pull readiness.
6. Launched `Analyze this repository` with an explicit read-only scope.
7. Observed assignment claim, acknowledgement, bounded progress, and lease renewal.
8. Received a SHA-256-verified Markdown repository-analysis artifact.
9. Confirmed execution, task, and mission completion.
10. Started a second CLI process and completed a second mission without duplicate execution or artifact identity.
11. Emergency-revoked the original credential and confirmed the next heartbeat/pull failed immediately.
12. Created a replacement owner-approved credential and confirmed heartbeat and pull readiness resumed.

## Safety evidence

- Git `HEAD` and complete working-tree status were identical before and after each Codex run.
- Codex ran with its read-only sandbox and a reduced environment allowlist.
- No file modification, package installation, commit, push, pull request, merge, deployment, secret access, transaction signing, transaction submission, or asset movement occurred.
- The assignment contained workspace-scoped resource identifiers, not a public local filesystem path.
- Status and acceptance output contained no credential material.

## Production health

Migration `0020_mission_agent_pull.sql` applied in place. The existing PostgreSQL and Caddy containers remained running; only the web container was replaced. `/api/health` and `/api/readiness` returned healthy/ready after deployment. No new database, load balancer, instance, or paid service was created.
