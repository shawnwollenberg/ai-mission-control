# Screenshot Captions

## 01-landing-page.png

- **Suggested title:** Mission Control for AI Teams
- **Caption:** The public landing page introduces the product, free evolving access, documentation, and application entry point.
- **Proof:** Crisp brand asset, complete animated wordmark, and public product positioning.
- **Timeline:** Added after the original hackathon demo.

## 02-documentation.png

- **Suggested title:** Documentation Built for First Connection
- **Caption:** The documentation home makes Quick Start, Architecture, Examples, and Connect Your First Agent immediately available.
- **Proof:** Public, task-oriented documentation exists.
- **Timeline:** Added after the original hackathon demo.

## 03-create-account.png

- **Suggested title:** Self-Service Account Creation
- **Caption:** A new user can create an account without an invitation or shared demo workspace.
- **Proof:** Public signup is implemented; the captured fields contain no personal values.
- **Timeline:** Added after the original hackathon demo.

## 04-agent-selection.png

- **Suggested title:** Start a Private AI Organization
- **Caption:** Personal workspace onboarding offers Codex, Hermes, Claude Code, and Generic Remote Agent behind one Mission Agent model.
- **Proof:** New accounts enter an isolated workspace and guided setup.
- **Timeline:** Added after the original hackathon demo.

## 05-copy-connection-command.png

- **Suggested title:** One-Command Agent Connection
- **Caption:** Mission Control generates a versioned, checksummed connection command while masking the secure one-time payload on screen.
- **Proof:** The one-command experience is production-visible without publishing a usable credential.
- **Timeline:** Added after the original hackathon demo.

## 06-agent-connected.png

- **Suggested title:** Mission Agent Connected
- **Caption:** A signed heartbeat confirms the agent, workspace, adapter, Mission Agent version, and pull-channel readiness.
- **Proof:** Genuine authenticated outbound connectivity, not a decorative connected state.
- **Timeline:** Added after the original hackathon demo.

## 07-first-mission.png

- **Suggested title:** Launch the First Mission
- **Caption:** Onboarding preselects “Analyze this repository” with an explicit read-only scope.
- **Proof:** The user moves directly from connection to a bounded mission.
- **Timeline:** Added after the original hackathon demo.

## 08-live-mission-agent-execution.png

- **Suggested title:** Live Local Agent Execution
- **Caption:** A locally running Mission Agent has claimed an assignment and is reporting stage progress with an explicit runtime label; the execution-heartbeat field had not yet populated at capture time.
- **Proof:** Genuine pull-based execution behind NAT using outbound HTTPS.
- **Timeline:** Added after the original hackathon demo. This capture is from a separate live run that later stopped safely after detecting a repository change; it is not presented as the completed run in screenshots 09–10.

## 09-first-mission-completed.png

- **Suggested title:** First Mission Completed
- **Caption:** The successful evidence run shows the mission complete, the Codex execution succeeded, and one checksummed artifact received.
- **Proof:** Genuine local Mission Agent execution completed end to end.
- **Timeline:** Added after the original hackathon demo.

## 10-repository-analysis-artifact.png

- **Suggested title:** Repository Analysis Artifact
- **Caption:** Mission Control presents the genuine Markdown analysis with repository overview, technologies, structure, tests, and a suggested next mission.
- **Proof:** Local work returned a durable, readable artifact; local paths are sanitized as `[repository]`.
- **Timeline:** Added after the original hackathon demo.

## 11-operations-dashboard.png

- **Suggested title:** Attention-First Operations
- **Caption:** The canary workspace dashboard brings missions, approvals, agents, workers, schedules, notifications, and usage state into one operational view.
- **Proof:** The production operations surface is live. Counts reflect the synthetic canary workspace at capture time, not a fabricated representative load.
- **Timeline:** Added after the original hackathon demo.

## 14-github-pull-request.png

- **Suggested title:** Provider-Confirmed GitHub Pull Request
- **Caption:** GitHub shows a real public pull request created through Mission Control and intentionally left open and unmerged.
- **Proof:** Bounded provider-side publication is real; merge authority is not granted.
- **Timeline:** Added after the original hackathon demo.

## 16-architecture.png

- **Suggested title:** Current Production Architecture
- **Caption:** The public architecture page shows Mission Control, Mission Agent and its adapters, PostgreSQL events, workers, policies, approvals, and artifact storage.
- **Proof:** The rendered architecture matches the current implementation rather than the original provisional design.
- **Timeline:** Added after the original hackathon demo.

## Requested evidence not captured

- `12-mixed-agent-mission.png`: no single production run at capture time honestly showed Hermes analysis, an approval boundary, and Codex implementation together.
- `13-publication-approval.png`: no single production view honestly showed exact commit and tests plus distinct push and PR approvals. Screenshot 14 proves the provider-side PR only.
- `15-read-only-defi-analysis.png`: no live production Hermes DeFi run with a safe artifact and policy boundary was available. No transaction was signed or submitted for this package.
