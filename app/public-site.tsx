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
      ["What is Mission Control?", "/docs"],
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
