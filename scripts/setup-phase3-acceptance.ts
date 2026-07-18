import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerAgent, registerRepository } from "../application/registry";
import { handleCreateMission, handleMissionTransition } from "../application/mission-commands";
import { handleCreateTask } from "../application/task-commands";
import { handleRequestExecution } from "../application/execution-commands";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { stableUuid } from "../lib/stable-id";
import { closeDatabasePool } from "../lib/database";
async function main() {
  const actor = { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" as const },
    executionActor = { workspaceId: DEFAULT_WORKSPACE_ID, id: DEFAULT_OWNER_ID, type: "human" as const },
    agentId = stableUuid("phase3-genuine-codex-agent"),
    repositoryId = stableUuid("phase3-mission-control-repository"),
    repository = process.cwd(),
    executionBaseRef = process.env.PHASE3_BASE_REF ?? "main";
  await registerAgent({
    actor,
    agentId,
    name: "Phase 3 Codex Publisher",
    description: "Genuine Codex implementation with separately governed publication",
    adapterType: "codex",
    capabilities: [
      "repository.read",
      "repository.write",
      "code.implement",
      "test.run",
      "artifact.create",
      "git.commit",
    ],
    supportedDomains: ["software_delivery"],
    trustLevel: "controlled",
    concurrencyLimit: 1,
    runtimeConfigurationReference: "env:CODEX_EXECUTABLE",
    credentialReference: "env:CODEX_HOME",
  });
  await registerRepository({
    actor,
    repositoryId,
    name: "shawnwollenberg/ai-mission-control",
    localPath: repository,
    defaultBranch: executionBaseRef,
    allowedAgentIds: [agentId],
    readAllowed: true,
    writeAllowed: true,
    commitAllowed: true,
    pushAllowed: true,
    pullRequestAllowed: true,
    protectedBranches: ["main"],
    allowedBranchPrefixes: ["codex/"],
    allowedRemotes: ["origin"],
    providerType: "github",
    providerConfigurationReference: `local-config:${path.join(process.env.HOME!, ".config/gh")}`,
    validationCommands: [[process.execPath, "--test", "fixtures/codex-health-app/health.test.mjs"]],
  });
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Phase 3 governed publication",
      objective:
        "Add policy metadata to the noncritical health fixture, validate it, and publish only through separate human approvals",
      domain: "software_delivery",
      priority: "high",
      riskLevel: "moderate",
      successCriteria: [
        "Health fixture reports phase3.1 policy metadata",
        "Fixture test passes",
        "Local commit exists",
        "Branch push and pull request require separate approvals",
      ],
      constraints: ["Codex must not push", "No force push", "No merge", "No deployment", "No secrets"],
    },
  });
  const task = await handleCreateTask({
    actor: executionActor,
    commandId: randomUUID(),
    task: {
      missionId: mission.missionId,
      name: "Add governed health metadata",
      instructions:
        'In fixtures/codex-health-app, ensure health.mjs exports health() returning exactly { status: "ok", service: "sample-app", policyVersion: "phase3.1" }, and health.test.mjs verifies those fields with node:test. Create the two small files if this older base does not contain them. Change only that fixture. Do not push, create a pull request, merge, or deploy.',
      expectedOutput: "A local commit containing the minimal fixture change with its test passing",
      priority: "normal",
      riskLevel: "low",
      requiredCapabilities: ["repository.write", "code.implement", "test.run", "git.commit"],
      timeoutSeconds: 900,
      verificationRequirements: ["node --test fixtures/codex-health-app/health.test.mjs"],
    },
  });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "planned" });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "running" });
  const execution = await handleRequestExecution({
    actor: executionActor,
    commandId: randomUUID(),
    taskId: task.taskId,
    agentId,
    repositoryId,
    timeoutSeconds: 900,
  });
  console.log(
    JSON.stringify({
      event: "phase3_acceptance_ready",
      workspaceId: DEFAULT_WORKSPACE_ID,
      missionId: mission.missionId,
      taskId: task.taskId,
      executionId: execution.executionId,
      agentId,
      repositoryId,
      repositoryPath: repository,
      repositoryRoot: path.dirname(repository),
      worktreeRoot: "/tmp/mission-control-phase3/worktrees",
      artifactRoot: "/tmp/mission-control-phase3/artifacts",
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
