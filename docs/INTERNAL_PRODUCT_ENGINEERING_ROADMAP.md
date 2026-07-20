# Mission Control — Internal Product & Engineering Roadmap

**Status:** Directional product strategy, supplied by the product owner on 2026-07-20.

This roadmap guides sequencing and architecture. It does not authorize implementation, external effects, or expanded agent permissions by itself. Each phase still requires an approved implementation boundary. Existing prohibitions on autonomous deployment, merge, infrastructure or secret modification, and transaction signing or submission remain in force unless the product owner separately approves a narrowly scoped policy change.

## Vision

Mission Control is not a coding assistant. Mission Control is the operating system for autonomous AI workers.

Software engineering is the first vertical because it provides immediate value and clear demonstrations, but the long-term architecture should support any type of autonomous worker. Every architectural decision should move the platform toward supervising many specialized agents operating safely across multiple domains.

## Guiding principles

1. Humans define objectives.
2. Agents execute missions.
3. Mission Control supervises.
4. Every action produces evidence.
5. Every permission is explicit.
6. Every decision is auditable.
7. Agents improve through experience.
8. New capabilities should compose naturally with existing workflows.

## Current product focus

One outcome controls near-term prioritization:

> Make Mission Control the best place to supervise AI software engineers.

Everything else must directly improve an engineering manager's ability to understand repositories, turn findings into managed work, supervise execution, review evidence, and decide what happens next.

## Mission Control 0.4 — Engineering Manager

Mission Control currently executes missions. Version 0.4 should begin managing work: preserving repository context, turning evidence into follow-up work, decomposing objectives, and showing how missions relate.

Priority order:

1. **Create Change Mission from Recommendation.** A completed repository analysis presents discrete recommendations with one-click change-mission creation. The objective and acceptance criteria are prefilled from recorded recommendation evidence, and validation commands are suggested from detected repository tooling. The user reviews every field before launch.
2. **Mission Templates.** Make Security Audit, Bug Fix, Performance Review, Dependency Upgrade, Documentation, Feature Implementation, and Code Review recognizable entry points with versioned prompts, validation expectations, and outputs.
3. **Mission Planner.** Decompose an objective such as “Add OAuth” into proposed backend, frontend, tests, and documentation work. Planning remains reviewable and requires approval before execution begins.
4. **Mission Graph.** Connect analysis, implementation, review, QA, publication, deployment, and monitoring missions through explicit evidence-backed relationships. The graph is a projection of canonical mission relationships, not an independent workflow database.
5. **Repository Health.** Detect architecture, frameworks, languages, CI, security posture, tests, dependencies, TODOs, technical debt, and potential defects. Produce an explainable health projection with evidence and versioned scoring rules.

The intended experience is repository-centered:

- Home: Mission Health, Repository Health, open recommendations, pending approvals, and recent missions.
- Repository: mission history, architecture, recommendations, knowledge, Mission Graph, and active missions.
- Analysis result: architecture, risks, recommendations, and **Create Change Mission** actions.

## Mission Control 0.5 — Repository Intelligence

Version 0.5 should make Mission Control worth checking every morning by turning accumulated mission evidence into an explainable view of repository condition and next actions.

Priority order:

1. **Repository Health dashboard.** Show an overall versioned score alongside evidence-backed dimensions for tests, architecture, security, technical debt, documentation, dependencies, CI, and recent mission outcomes. Display freshness, confidence, and unknown inputs; never disguise missing evidence as precision.
2. **Repository Timeline.** Show the lifecycle of analyses, recommendations, change missions, validations, approvals, commits, pull requests, deployments, incidents, and audits using canonical mission relationships rather than duplicating Git history.
3. **Repository Knowledge.** Build component pages connecting architecture, files, tests, risks, recommendations, decisions, ownership observations, and mission history. Repository Knowledge belongs to the platform and remains useful when execution engines change.
4. **Health trends.** Preserve comparable health assessments over time and explain which verified changes affected each dimension. Mission completion alone does not imply improvement; evidence must support the new assessment.
5. **Action templates.** Attach versioned mission templates to common findings so users can move from evidence to supervised action without losing provenance or bypassing approval.

The target loop is:

`Repository Health → Recommendation → Change Mission → Validation → Follow-up Assessment → Explainable Health Change`

Repository Intelligence also establishes the foundation for an evidence-backed semantic layer. Natural-language questions may retrieve and summarize repository history, but every answer must cite durable missions, recommendations, approvals, artifacts, decisions, and outcomes. The generated answer is not authoritative memory by itself.

This milestone does not authorize implementation by itself. Health formulas, observation schemas, timeline relationships, component identity, staleness, backfill, rebuild behavior, compatibility, rollback, cost, and the first vertical slice require explicit approval.

## Phase 1 — Autonomous Software Engineering

Mission Control's initial focus is becoming the safest way to supervise AI software engineers.

Current capabilities include repository registration, Remote Mission Agent, repository analysis, mission planning, Mission Log, human approvals, artifact collection, and mission replay.

Next priorities include Repository Change Missions, branch isolation, local commits, test execution, diff review, pull-request creation, Mission Templates, and multi-agent software missions.

Standard experience:

`Analyze Repository → Architecture Report → Create Change Mission from Recommendation → Repository Change Mission → Review Diff → Approve PR`

## Phase 2 — Agent Orchestration

Mission Control evolves from supervising one AI into managing many. Users assign work to an agent or team rather than choosing a model directly. Mission Control selects an execution engine using capabilities, cost, reliability, and availability.

Potential engines include Codex, Claude Code, Gemini CLI, Cursor, Hermes, and future providers. Execution engines become interchangeable implementation details.

## Phase 3 — Persistent Agents

Agents become long-lived workers with profiles containing expertise, supported capabilities, repository familiarity, success rate, average completion time, cost statistics, reliability metrics, and mission history. Mission planning uses this experience when assigning work.

## Phase 4 — Repository Knowledge

Do not make individual agents the durable owners of organizational memory. Store durable, evidence-backed Repository Knowledge that any compatible agent can consume.

- Architecture and component boundaries
- Languages, frameworks, build tools, CI, tests, and dependencies
- Mission history and resulting artifacts
- Known issues, risks, TODOs, and technical debt
- Recorded architectural decisions
- Repository standards and validation expectations

Repository Knowledge is reconstructed from canonical observations, decisions, mission relationships, and artifacts. Agents consume it as context but do not privately own or mutate the authoritative record. This keeps knowledge useful when execution engines change.

## Phase 5 — Capabilities and Skills

Agents install capabilities instead of embedding every feature directly. Examples include GitHub, AWS, Stripe, Terraform, Kubernetes, PostgreSQL, Solidity, React, Rust, Slack, and Twilio.

Capabilities advertise permissions, supported mission types, required credentials, version, and documentation. Mission Control determines which agents possess the required capabilities before assigning work.

## Phase 6 — Mission Graph

Completed missions naturally generate follow-up missions:

`Analyze Repository → Identify authentication risks → Create Change Mission → Run tests → Security review → Create pull request → Deploy → Monitor production`

Mission history becomes a connected graph and part of the organization's institutional knowledge.

## Phase 7 — Continuous Operations

Support persistent missions such as monitoring GitHub, watching CI failures, auditing dependencies nightly, reviewing cloud costs weekly, monitoring production logs, and detecting security vulnerabilities. Persistent missions create actionable missions when intervention is required.

## Phase 8 — AI Organization Management

Mission Control supervises complete AI organizations across engineering, finance, marketing, operations, and trading. Every worker executes the same Mission lifecycle regardless of domain.

Illustrative teams include Backend, Frontend, Infrastructure, QA, Treasury, Accounting, Content, SEO, OfficeAnywhere, Aegis Treasury, and DeFi Strategy.

## Phase 9 — Executive Dashboard

Mission Control becomes the operational dashboard for active agents, running and blocked missions, pending approvals, organizational cost, model usage, mission ROI, deployment history, and security events.

## Phase 10 — Mobile Supervision

A future mobile application focuses on supervision: approve or reject requests, review diffs, monitor agent health, receive alerts, pause agents, and activate emergency stop. It is an executive control center, not a development environment.

## Long-term goal

Mission Control becomes the standard operating system for organizations built around autonomous AI workers. Every autonomous worker—whether writing code, trading assets, answering phones, managing infrastructure, or operating a business—executes work through the same secure, observable, evidence-backed Mission lifecycle.

## Phase governance

Before beginning any roadmap phase:

1. Define the smallest demonstrable boundary and acceptance criteria.
2. Identify canonical events consumed and produced.
3. State the permissions introduced and permanent prohibitions retained.
4. Define deterministic policy, approval, recovery, and audit behavior.
5. Identify migrations, compatibility risks, rollback, and operating cost.
6. Obtain explicit product-owner approval before implementation.
