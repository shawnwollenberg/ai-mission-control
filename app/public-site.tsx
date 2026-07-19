import Link from "next/link";
import { BrandSprite } from "./brand-assets";

export const publicNav = [
  ["Documentation", "/docs"],
  ["Quick Start", "/quick-start"],
  ["Features", "/features"],
  ["Examples", "/examples"],
  ["Architecture", "/architecture"],
  ["GitHub", "https://github.com/shawnwollenberg/ai-mission-control"],
  ["Updates", "/updates"],
] as const;

export function PublicHeader() {
  return (
    <header className="public-header">
      <Link className="public-logo" href="/">
        <BrandSprite asset="mark-compact" />
        <strong className="typed-wordmark">MISSION CONTROL</strong>
      </Link>
      <nav>
        {publicNav.map(([label, href]) => (
          <Link href={href} key={label}>
            {label}
          </Link>
        ))}
      </nav>
      <a className="public-launch" href="https://app.missioncontrol.wallyweb.com">
        Launch App <span>↗</span>
      </a>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="public-footer">
      <div>
        <strong>Mission Control</strong>
        <p>The operating system for your AI organization.</p>
      </div>
      <div>
        <p>Free while it’s evolving.</p>
        <p>Built in public through daily use.</p>
      </div>
    </footer>
  );
}

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-site">
      <PublicHeader />
      {children}
      <PublicFooter />
    </main>
  );
}

export const docGroups = [
  {
    title: "Getting Started",
    items: [
      ["What is Mission Control?", "/docs/what-is-mission-control"],
      ["Quick Start (10 minutes)", "/quick-start"],
      ["Install", "/docs/install"],
      ["Architecture", "/architecture"],
    ],
  },
  {
    title: "Concepts",
    items: [
      ["Mission", "/docs/concepts/mission"],
      ["Task", "/docs/concepts/task"],
      ["Agent", "/docs/concepts/agent"],
      ["Execution", "/docs/concepts/execution"],
      ["Policy", "/docs/concepts/policy"],
      ["Approval", "/docs/concepts/approval"],
      ["Artifact", "/docs/concepts/artifact"],
    ],
  },
  {
    title: "Guides",
    items: [
      ["Running Codex", "/docs/running-codex"],
      ["Running Hermes", "/docs/running-hermes"],
      ["Creating Agents", "/docs/creating-agents"],
      ["Mission Agent CLI", "/docs/mission-agent"],
      ["Agent Protocol 1.0", "/docs/agent-protocol"],
      ["Mission Templates", "/docs/mission-templates"],
      ["Scheduling", "/docs/scheduling"],
      ["Notifications", "/docs/notifications"],
      ["Policies", "/docs/policies"],
      ["Security", "/docs/security"],
      ["Examples", "/examples"],
      ["FAQ", "/docs/faq"],
    ],
  },
] as const;

export const docs: Record<
  string,
  { eyebrow: string; title: string; lede: string; sections: { title: string; body: string }[] }
> = {
  "what-is-mission-control": {
    eyebrow: "Getting started",
    title: "What is Mission Control?",
    lede: "Mission Control is the durable control plane for an AI organization: one place to give agents an objective, supervise their work, review evidence, and retain human authority over consequential actions.",
    sections: [
      {
        title: "The problem it solves",
        body: "AI agents often work across separate terminals, repositories, model providers, schedulers, and dashboards. Mission Control turns that fragmented activity into missions, tasks, executions, approvals, and artifacts that a human can understand at a glance.",
      },
      {
        title: "How it works",
        body: "You launch a mission from a reusable template or a focused objective. Mission Control assigns bounded tasks to capable agents, records meaningful activity in an append-only event log, surfaces progress and evidence, and pauses whenever policy requires human judgment.",
      },
      {
        title: "What makes it different",
        body: "Mission Control manages outcomes rather than pretending every agent is trustworthy or autonomous. Codex, Hermes, Claude Code, and generic agents sit behind common execution boundaries, while deterministic policies and parameter-bound approvals keep authority with the human operator.",
      },
      {
        title: "Start small",
        body: "Create a personal workspace, connect one agent with the guided one-command flow, and launch the read-only repository-analysis mission. The goal is to reach a genuine heartbeat, execution, and artifact in under ten minutes without reading the rest of the documentation first.",
      },
    ],
  },
  install: {
    eyebrow: "Getting started",
    title: "Install Mission Control",
    lede: "Run the control plane locally first. Production deployment stays a separate, human-approved release activity.",
    sections: [
      {
        title: "Requirements",
        body: "Node 22.20+, PostgreSQL 16+, Git, and the Codex CLI when you want local coding execution.",
      },
      {
        title: "Local setup",
        body: "Clone the repository, install dependencies with npm ci, start PostgreSQL, run migrations, provision an owner, and start the web and worker processes.",
      },
    ],
  },
  "concepts/mission": {
    eyebrow: "Concepts",
    title: "Mission",
    lede: "A mission is the durable objective that binds a plan, tasks, evidence, policy decisions, and outcome.",
    sections: [
      { title: "Why it exists", body: "Missions give a human one place to understand what agents are doing and why." },
      {
        title: "Lifecycle",
        body: "Draft, plan, run, pause, complete, fail, or cancel—with every meaningful transition recorded as an event.",
      },
    ],
  },
  "concepts/task": {
    eyebrow: "Concepts",
    title: "Task",
    lede: "A bounded unit of work with instructions, dependencies, required capabilities, and an expected result.",
    sections: [
      {
        title: "Boundaries",
        body: "Tasks make delegation inspectable and keep one agent from silently expanding the mission.",
      },
    ],
  },
  "concepts/agent": {
    eyebrow: "Concepts",
    title: "Agent",
    lede: "A specialized worker registered with explicit capabilities, resources, credentials, and concurrency limits.",
    sections: [
      {
        title: "Interchangeable by design",
        body: "Codex, Hermes, Claude Code, or your own remote agent can participate without becoming the product itself.",
      },
    ],
  },
  "concepts/execution": {
    eyebrow: "Concepts",
    title: "Execution",
    lede: "One durable attempt to perform a task, with leases, heartbeats, evidence, budgets, and recovery.",
    sections: [
      {
        title: "Safety",
        body: "Workers can restart without inventing a second execution. Active and terminal states remain auditable.",
      },
    ],
  },
  "concepts/policy": {
    eyebrow: "Concepts",
    title: "Policy",
    lede: "Deterministic rules decide whether an action is allowed, denied, or requires human approval.",
    sections: [
      {
        title: "Permanent boundaries",
        body: "Autonomous deployment, merge, infrastructure changes, secret modification, and blockchain execution remain denied.",
      },
    ],
  },
  "concepts/approval": {
    eyebrow: "Concepts",
    title: "Approval",
    lede: "A human decision bound to exact parameters, evidence, policy version, and expiry.",
    sections: [
      {
        title: "No blanket consent",
        body: "A push approval cannot silently become a pull request, merge, or deployment approval.",
      },
    ],
  },
  "concepts/artifact": {
    eyebrow: "Concepts",
    title: "Artifact",
    lede: "A checksummed result—report, patch, log, or JSON record—linked to the execution that produced it.",
    sections: [
      {
        title: "Durability",
        body: "Production artifacts live in object storage, separate from temporary worker filesystems.",
      },
    ],
  },
  "running-codex": {
    eyebrow: "Guides",
    title: "Running Codex",
    lede: "Give Codex a bounded repository, isolated worktree, validation commands, time limit, and explicit publication policy.",
    sections: [
      {
        title: "Initial permissions",
        body: "Read, worktree writes, tests, and local commits are allowed. Push and PR creation require separate approvals. Merge and deployment are denied.",
      },
    ],
  },
  "running-hermes": {
    eyebrow: "Guides",
    title: "Running Hermes",
    lede: "Connect Hermes through the signed remote-agent protocol for read-only analysis, reports, and health workflows.",
    sections: [
      {
        title: "Credentials",
        body: "Create a production identity, display its credential once, verify a signed heartbeat, then test rotation and revocation.",
      },
    ],
  },
  "creating-agents": {
    eyebrow: "Guides",
    title: "Creating Agents",
    lede: "Register identity first, then grant only the capabilities and resources needed for the first workflow.",
    sections: [
      {
        title: "Connection sequence",
        body: "Create an invite in the app, run the generated host command, receive a heartbeat, and review the declared capabilities before assignment.",
      },
    ],
  },
  "mission-agent": {
    eyebrow: "Five-minute setup",
    title: "Connect Mission Agent",
    lede: "Connect a local Codex runtime, confirm its outbound pull channel, and complete a genuine read-only repository analysis without inbound networking.",
    sections: [
      {
        title: "1. Connect",
        body: "Create an account, choose Codex, open a terminal in a safe Git repository, and run the single versioned and checksummed command shown by Mission Control. The credential is stored in macOS Keychain when available or a protected 0600 file on Linux.",
      },
      {
        title: "2. Verify",
        body: "The onboarding page advances only after both the signed heartbeat and assignment pull capability are confirmed. Run mission-agent doctor for Node, Git, Codex, repository, credential-permission, reachability, signature, and heartbeat diagnostics.",
      },
      {
        title: "3. Run",
        body: "Select the registered repository and launch Analyze this repository. Mission Agent pulls the assignment over outbound HTTPS, renews its lease, reports bounded progress, uploads a checksummed Markdown artifact, and completes the mission.",
      },
      {
        title: "Operations",
        body: "Use mission-agent status, mission-agent run, mission-agent repository add /path, and mission-agent logout --yes. macOS and Linux are supported first; Windows remains experimental. Credentials never appear in status output.",
      },
    ],
  },
  "agent-protocol": {
    eyebrow: "Protocol",
    title: "Mission Control Agent Protocol 1.0",
    lede: "A vendor-neutral, signed HTTPS protocol for identity, heartbeat, pull assignments, leases, progress, artifacts, completion, failure, and cancellation.",
    sections: [
      {
        title: "Authentication",
        body: "HMAC-SHA256 binds method, path, timestamp, nonce, message ID, body checksum, and protocol version. Credentials are workspace- and agent-scoped, displayed once, immediately revocable, and never included in events or examples.",
      },
      {
        title: "Pull and leases",
        body: "A bounded long poll returns only the authenticated agent’s eligible assignment. An opaque lease token is required for acknowledgement, renewal, execution messages, cancellation checks, release, artifacts, and completion.",
      },
      {
        title: "Compatibility",
        body: "Protocol additions preserve existing push-mode 1.0 agents. Independent Python, Go, or Rust clients can implement the documented canonical signature and JSON envelope without using Mission Control source code.",
      },
    ],
  },
  "mission-templates": {
    eyebrow: "Guides",
    title: "Mission Templates",
    lede: "Versioned templates turn proven plans into repeatable missions without mutating earlier runs.",
    sections: [
      {
        title: "Start narrow",
        body: "Begin with health reports, read-only analysis, and manual software-change missions.",
      },
    ],
  },
  scheduling: {
    eyebrow: "Guides",
    title: "Scheduling",
    lede: "Launch immutable mission instances on explicit time zones with concurrency and missed-run policies.",
    sections: [
      {
        title: "Acceptance period",
        body: "Schedule reports, not autonomous coding, during initial production acceptance.",
      },
    ],
  },
  notifications: {
    eyebrow: "Guides",
    title: "Notifications",
    lede: "Route attention—not noise—to in-app and approved external destinations.",
    sections: [
      { title: "Immediate", body: "Approvals, failures, offline workers, hard budget blocks, and security events." },
    ],
  },
  policies: {
    eyebrow: "Guides",
    title: "Policies",
    lede: "Compose workspace, repository, agent, environment, and action restrictions deterministically.",
    sections: [{ title: "Revalidation", body: "Sensitive actions are checked again immediately before execution." }],
  },
  security: {
    eyebrow: "Guides",
    title: "Security",
    lede: "Workspace isolation, signed credentials, parameter-bound approvals, safe execution, and durable emergency controls work together.",
    sections: [
      {
        title: "Human release boundary",
        body: "Deploying Mission Control is a reviewed human release activity. Mission Control agents still cannot deploy autonomously.",
      },
    ],
  },
  faq: {
    eyebrow: "Help",
    title: "Frequently asked questions",
    lede: "The short answers to the questions that come up when you connect an AI organization.",
    sections: [
      { title: "Is Mission Control free?", body: "Yes. Mission Control is free while it’s evolving." },
      {
        title: "Does it replace my agents?",
        body: "No. It coordinates and governs Codex, Hermes, Claude Code, and remote agents.",
      },
      { title: "Can agents deploy or merge?", body: "Not by default. Those authorities remain explicitly denied." },
    ],
  },
};
