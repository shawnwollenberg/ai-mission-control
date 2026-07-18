import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { registerRemoteAgent } from "../application/remote-agent-registry";
import { handleCreateMission, handleMissionTransition } from "../application/mission-commands";
import { handleCreateTask } from "../application/task-commands";
import { closeDatabasePool } from "../lib/database";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";

async function main() {
  const credentialFile = process.env.PHASE4_CREDENTIAL_FILE;
  if (!credentialFile) throw new Error("PHASE4_CREDENTIAL_FILE is required");
  const actor = { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" as const };
  const executionActor = { workspaceId: DEFAULT_WORKSPACE_ID, id: DEFAULT_OWNER_ID, type: "human" as const };
  const registration = await registerRemoteAgent({
    actor,
    name: "Hermes Operations",
    description: "Authenticated read-only operational analysis bridge",
    endpoint: process.env.HERMES_ENDPOINT ?? "http://127.0.0.1:4100/executions",
    capabilities: ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"],
    supportedDomains: ["systems_monitoring"],
    concurrencyLimit: 1,
  });
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Daily Mission Control health report",
      objective: "Review Mission Control operational health and produce a daily system report",
      description: "Read-only authenticated Hermes acceptance mission",
      domain: "systems_monitoring",
      priority: "normal",
      riskLevel: "low",
      constraints: ["No remediation", "No secrets", "No infrastructure or database mutation"],
    },
  });
  const task = await handleCreateTask({
    actor: executionActor,
    commandId: randomUUID(),
    task: {
      missionId: mission.missionId,
      name: "Produce operational health report",
      instructions: "Read the configured Mission Control health endpoint and prepare a concise Markdown report.",
      expectedOutput: "Checksummed Markdown operational health report",
      priority: "normal",
      riskLevel: "low",
      requiredCapabilities: ["metrics.read", "health.verify", "report.create"],
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
