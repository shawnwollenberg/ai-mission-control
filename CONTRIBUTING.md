# Contributing to Mission Control

Mission Control welcomes focused issues, design discussion, and pull requests around event sourcing, orchestration, approvals, policy enforcement, agent protocols, and Mission Templates.

## Before opening a pull request

1. Open an issue for substantial product or architecture changes.
2. Keep the change narrow and distinguish real behavior from simulated demo behavior.
3. Preserve the permanent safety boundary: agents may not autonomously deploy, merge, modify infrastructure or secrets, sign transactions, or submit transactions.
4. Run the relevant validation:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Every meaningful state transition should remain represented as a structured event. New milestones should include acceptance criteria and demonstrable progress.

By submitting a contribution, you affirm that you have the right to submit it. No contributor license agreement or open-source license is currently in place; discuss material contributions with the maintainer before investing substantial work.
