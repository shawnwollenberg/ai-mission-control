import type { TemplateDefinition } from "@/domain/mission-template";
import { stableUuid } from "@/lib/stable-id";

const task = (key: string, name: string, capabilities: string[], instructions = name) => ({
  key,
  name,
  instructions,
  expectedOutput: `${name} evidence`,
  requiredCapabilities: capabilities,
  timeoutSeconds: 600,
  riskLevel: "low" as const,
});
const chain = (keys: string[]) => keys.slice(1).map((key, index) => ({ task: key, dependsOn: keys[index] }));
export const INITIAL_TEMPLATES: Array<{ templateId: string; definition: TemplateDefinition }> = [
  {
    templateId: stableUuid("phase5-template-software-change"),
    definition: {
      name: "Software Change",
      description: "Bounded Codex change with optional separately approved publication",
      domain: "software_delivery",
      defaultObjective: "Implement and validate a bounded software change",
      inputSchema: {
        required: ["repository", "objective", "expectedBehavior"],
        properties: {
          repository: { type: "resource_id", resourceType: "repository" },
          objective: { type: "string" },
          expectedBehavior: { type: "string" },
          allowedScope: { type: "string" },
          riskLevel: { type: "string" },
          requestPush: { type: "boolean" },
          requestPullRequest: { type: "boolean" },
        },
      },
      tasks: ["inspect", "plan", "implement", "test", "evidence"].map((key) =>
        task(key, key[0].toUpperCase() + key.slice(1), ["repository.read", "code.implement", "test.run", "git.commit"]),
      ),
      dependencies: chain(["inspect", "plan", "implement", "test", "evidence"]),
      defaults: { executor: "codex", riskLevel: "low", timeoutSeconds: 600 },
      artifactExpectations: ["test_result", "git_patch", "final_summary"],
    },
  },
  {
    templateId: stableUuid("phase5-template-operational-health"),
    definition: {
      name: "Operational Health Report",
      description: "Read-only daily operational review",
      domain: "systems_monitoring",
      defaultObjective: "Review Mission Control health and produce an actionable report",
      inputSchema: {
        required: ["healthResource"],
        properties: {
          healthResource: { type: "resource_id", resourceType: "monitoring_endpoint" },
          systems: { type: "array" },
          timeRange: { type: "string" },
          severityThreshold: { type: "string" },
          reportDestination: { type: "string" },
        },
      },
      tasks: [
        {
          ...task(
            "report",
            "Produce operational health report",
            ["metrics.read", "health.verify", "report.create"],
            "Read approved health data, failed jobs, stale agents, pending approvals, and execution failures. Produce a Markdown report and recommend follow-up without remediation.",
          ),
          resourceInputs: ["healthResource"],
        },
      ],
      dependencies: [],
      defaults: {
        executor: "hermes",
        riskLevel: "low",
        concurrencyPolicy: "skip_if_running",
        missedRunPolicy: "run_once_on_recovery",
      },
      artifactExpectations: ["report"],
    },
  },
  {
    templateId: stableUuid("phase5-template-defi-review"),
    definition: {
      name: "DeFi Portfolio Review",
      description: "Read-only portfolio analysis and simulation",
      domain: "defi_analysis",
      defaultObjective: "Review portfolio performance and recommend a safe strategy",
      inputSchema: {
        required: ["portfolioResource", "protocol"],
        properties: {
          portfolioResource: { type: "resource_id", resourceType: "portfolio_fixture" },
          protocol: { type: "string" },
          analysisPeriod: { type: "string" },
          riskTolerance: { type: "string" },
          strategyAssumptions: { type: "array" },
        },
      },
      tasks: [
        {
          ...task(
            "analysis",
            "Analyze portfolio and alternatives",
            [
              "portfolio.read",
              "market.read",
              "protocol.read",
              "position.analyze",
              "transaction.simulate",
              "strategy.recommend",
              "artifact.create",
            ],
            "Retrieve approved data, estimate fees and impermanent loss, simulate alternatives, and produce Markdown and JSON. Analysis only.  No transaction was signed or submitted.",
          ),
          resourceInputs: ["portfolioResource"],
        },
      ],
      dependencies: [],
      defaults: { executor: "hermes", riskLevel: "low", concurrencyPolicy: "skip_if_running", missedRunPolicy: "skip" },
      artifactExpectations: ["report", "structured_result"],
    },
  },
  {
    templateId: stableUuid("phase5-template-research-writing"),
    definition: {
      name: "Research and Writing",
      description: "Research, draft, and review a bounded written artifact",
      domain: "research_writing",
      defaultObjective: "Produce evidence-backed writing for an approved audience",
      inputSchema: {
        required: ["topic", "audience", "desiredOutput"],
        properties: {
          topic: { type: "string" },
          audience: { type: "string" },
          desiredOutput: { type: "string" },
          length: { type: "string" },
          requiredSources: { type: "array" },
          tone: { type: "string" },
          reviewCriteria: { type: "array" },
        },
      },
      tasks: ["research", "draft", "review", "final"].map((key) =>
        task(key, key[0].toUpperCase() + key.slice(1), ["research.read", "artifact.create"]),
      ),
      dependencies: chain(["research", "draft", "review", "final"]),
      defaults: { executor: "eligible_writing_agent", riskLevel: "low" },
      artifactExpectations: ["research_notes", "final"],
    },
  },
  {
    templateId: stableUuid("phase5-template-mixed"),
    definition: {
      name: "Mixed Analysis and Implementation",
      description: "Hermes recommendation followed by approval-bound Codex implementation",
      domain: "systems_monitoring",
      defaultObjective: "Analyze an issue and implement only the approved bounded recommendation",
      inputSchema: {
        required: ["systemResource", "analysisObjective", "maximumScope"],
        properties: {
          systemResource: { type: "resource_id" },
          analysisObjective: { type: "string" },
          maximumScope: { type: "string" },
          testExpectations: { type: "array" },
          publicationPreference: { type: "string" },
        },
      },
      tasks: [
        task("analysis", "Hermes structured analysis", ["metrics.read", "health.verify", "report.create"]),
        task("implementation", "Approved Codex implementation", [
          "repository.read",
          "repository.write",
          "code.implement",
          "test.run",
          "git.commit",
        ]),
      ],
      dependencies: [{ task: "implementation", dependsOn: "analysis" }],
      defaults: { riskLevel: "low", implementationApprovalRequired: true, publicationApprovalsSeparate: true },
      artifactExpectations: ["report", "test_result", "git_patch"],
    },
  },
];
