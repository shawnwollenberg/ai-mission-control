# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include secrets, credentials, private URLs, customer data, or exploit details in public discussion.

Use GitHub's private vulnerability reporting for this repository. Include the affected revision, impact, reproduction steps, and any suggested mitigation. The maintainer will acknowledge the report, assess severity, and coordinate disclosure after a fix is available.

## Permanent execution boundary

Mission Control agents must not autonomously:

- deploy software;
- merge pull requests;
- modify infrastructure;
- modify secrets;
- sign transactions; or
- submit transactions.

Human-approved releases of Mission Control itself are development activities outside the autonomous agent capability boundary.
