# Project Update

The original Mission Control hackathon demo showed the core product idea: one human supervising an AI organization through a mission plan, structured activity, an evidence-backed optimization recommendation, and meaningful approval boundaries. It was a narrow, controlled demonstration. Simulated or fixture-driven execution was labeled, and the original recording did not include today’s public signup, durable production service, or pull-based local runtime.

Since that demo, Mission Control has become a live, publicly accessible control plane. Users can create an account at <https://app.missioncontrol.wallyweb.com>, receive an isolated personal workspace, and follow a guided first-run experience. The landing page and documentation are available at <https://missioncontrol.wallyweb.com>, and the source is public at <https://github.com/shawnwollenberg/ai-mission-control>.

The main new onboarding path is Mission Agent, a lightweight local runtime that needs only outbound HTTPS. A user chooses Codex, copies one versioned and checksummed command, and receives an owner-created credential. Mission Agent stores it in the operating-system credential store when available, sends signed heartbeats, and polls a durable assignment queue. No inbound tunnel or publicly exposed localhost is required.

After the heartbeat arrives, Mission Control unlocks a prefilled first mission: **Analyze this repository**. The scope is deliberately read-only. A real local Codex adapter claims the assignment, reports progress and lease renewals, analyzes the chosen repository, submits a Markdown artifact, and completes the task and mission. The successful evidence run in this package is genuine Mission Agent execution rather than the original simulated demo path.

The production system now includes PostgreSQL-backed event sourcing, deterministic policies, human approvals, mission templates, schedules, notifications, usage controls, operational views, live Codex and Hermes execution paths, mixed-agent orchestration, bounded GitHub branch push and pull-request creation, and artifact evidence. These are post-demo additions and should be described that way.

Mission Control was built through a repeated design-and-implementation workflow.  ChatGPT served as the technical architect, product strategist, design partner, and review partner.  Codex served as the primary implementation agent, powered by GPT-5.6, and used ChatGPT's phase plans to audit, build, test, deploy, and refine the production system.

Safety boundaries remain intentional. Mission Control agents cannot autonomously merge, deploy, remediate production infrastructure, modify infrastructure or secrets, sign financial transactions, submit transactions, or move assets. GitHub pull requests remain open and unmerged until a human acts outside the agent authority boundary. Mission Agent also verifies the repository before and after read-only analysis and stops when it detects mutation.

Mission Control is free while it is evolving. It is being used daily to manage an AI organization, and feedback from people doing the same is welcome.
