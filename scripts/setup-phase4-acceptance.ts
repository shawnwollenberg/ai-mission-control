import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { registerRemoteAgent } from "../application/remote-agent-registry";
import { handleCreateMission, handleMissionTransition } from "../application/mission-commands";
import { handleCreateTask } from "../application/task-commands";
import { closeDatabasePool } from "../lib/database";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { grantAgentResource } from "../application/agent-eligibility";

async function main() {
  const credentialFile = process.env.PHASE4_CREDENTIAL_FILE;
  if (!credentialFile) throw new Error("PHASE4_CREDENTIAL_FILE is required");
  const scenario = process.env.PHASE4_SCENARIO ?? "health";
  const defi = scenario === "defi";
  const mixed = scenario === "mixed";
  const capabilities = defi
    ? [
        "portfolio.read",
        "market.read",
        "protocol.read",
        "position.analyze",
        "transaction.simulate",
        "strategy.recommend",
        "artifact.create",
      ]
    : ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"];
  const actor = { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" as const };
  const executionActor = { workspaceId: DEFAULT_WORKSPACE_ID, id: DEFAULT_OWNER_ID, type: "human" as const };
  const registration = await registerRemoteAgent({
    actor,
    name: defi ? "Hermes DeFi Analyst" : "Hermes Operations",
    description: defi
      ? "Authenticated read-only portfolio analysis bridge"
      : "Authenticated read-only operational analysis bridge",
    endpoint: process.env.HERMES_ENDPOINT ?? "http://127.0.0.1:4100/executions",
    capabilities,
    supportedDomains: [defi ? "defi_analysis" : "systems_monitoring"],
    concurrencyLimit: 1,
  });
  await grantAgentResource({
    workspaceId: DEFAULT_WORKSPACE_ID,
    agentId: registration.agentId,
    resourceType: defi ? "portfolio_fixture" : "monitoring_endpoint",
    resourceId: defi ? "aerodrome-approved" : "mission-control-health",
    permissions: ["read"],
  });
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: defi
        ? "Aerodrome portfolio analysis"
        : mixed
          ? "Health review and approved improvement"
          : "Daily Mission Control health report",
      objective: defi
        ? "Review the current Aerodrome portfolio and recommend whether the strategy should remain unchanged"
        : mixed
          ? "Review Mission Control operational health and implement one approved low-risk improvement"
          : "Review Mission Control operational health and produce a daily system report",
      description: defi
        ? "Read-only authenticated Hermes DeFi analysis"
        : mixed
          ? "Mixed Hermes and Codex acceptance mission"
          : "Read-only authenticated Hermes acceptance mission",
      domain: defi ? "defi_analysis" : "systems_monitoring",
      priority: "normal",
      riskLevel: "low",
      constraints: defi
        ? ["Analysis only", "No signing", "No submission", "No asset movement"]
        : ["No remediation", "No secrets", "No infrastructure or database mutation"],
    },
  });
  const task = await handleCreateTask({
    actor: executionActor,
    commandId: randomUUID(),
    task: {
      missionId: mission.missionId,
      name: defi ? "Analyze approved Aerodrome portfolio" : "Produce operational health report",
      instructions: defi
        ? "Read only the approved Aerodrome fixture, analyze the position, simulate candidates without submission, and produce Markdown and JSON recommendations."
        : mixed
          ? "Read the configured Mission Control health endpoint, recommend one bounded low-risk code improvement, and request approval to activate Codex."
          : "Read the configured Mission Control health endpoint and prepare a concise Markdown report.",
      expectedOutput: defi
        ? "Checksummed Markdown and structured JSON analysis artifacts"
        : mixed
          ? "Checksummed report and structured implementation handoff"
          : "Checksummed Markdown operational health report",
      priority: "normal",
      riskLevel: "low",
      requiredCapabilities: defi ? capabilities : ["metrics.read", "health.verify", "report.create"],
      requiredResources: [
        {
          resourceType: defi ? "portfolio_fixture" : "monitoring_endpoint",
          resourceId: defi ? "aerodrome-approved" : "mission-control-health",
          permission: "read",
        },
      ],
      timeoutSeconds: 300,
    },
  });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "planned" });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "running" });
  await writeFile(
    credentialFile,
    JSON.stringify(
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        agentId: registration.agentId,
        credentialId: registration.credential.credentialId,
        secret: registration.credential.secret,
        missionId: mission.missionId,
        taskId: task.taskId,
        scenario,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      event: "phase4_acceptance_prepared",
      agentId: registration.agentId,
      missionId: mission.missionId,
      taskId: task.taskId,
      credentialFile,
      credentialDisplayed: false,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
