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

## Phase 4 — Agent Memory

Memory exists at several levels:

- Repository memory: architecture, conventions, historical decisions, and previous missions.
- Project memory: active initiatives, milestones, recurring problems, and design documents.
- Organization memory: standards, preferred technologies, deployment processes, and security requirements.
- Personal memory: user preferences, review style, and approval tendencies.

Agents should become increasingly effective as they accumulate organizational knowledge.

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

