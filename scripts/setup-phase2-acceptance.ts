import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runSafeProcess } from "../execution/safe-process";
import { registerAgent, registerRepository } from "../application/registry";
import { handleCreateMission, handleMissionTransition } from "../application/mission-commands";
import { handleCreateTask } from "../application/task-commands";
import { handleRequestExecution } from "../application/execution-commands";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { closeDatabasePool } from "../lib/database";
async function main() {
  const base = path.resolve(
      process.env.PHASE2_ACCEPTANCE_ROOT ?? path.join(process.cwd(), ".mission-control/phase2-acceptance"),
    ),
    repositoryRoot = path.join(base, "repositories"),
    repository = path.join(repositoryRoot, `health-${Date.now()}`),
    worktreeRoot = path.join(base, "worktrees"),
    artifactRoot = path.join(base, "artifacts");
  await mkdir(repositoryRoot, { recursive: true });
  await cp(path.resolve("fixtures/codex-health-app"), repository, { recursive: true });
  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    [
      "-c",
      "user.name=Acceptance Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "initial health fixture",
    ],
  ]) {
    const result = await runSafeProcess({
      executable: "git",
      args,
      cwd: repository,
      allowedRoot: repositoryRoot,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  const actor = { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" as const },
    executionActor = { workspaceId: DEFAULT_WORKSPACE_ID, id: DEFAULT_OWNER_ID, type: "human" as const },
    agentId = randomUUID(),
    repositoryId = randomUUID();
  await registerAgent({
    actor,
    agentId,
    name: "Local Codex Worker",
    description: "Phase 2 genuine local acceptance worker",
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
    name: "Noncritical health fixture",
    localPath: repository,
    defaultBranch: "main",
    allowedAgentIds: [agentId],
    readAllowed: true,
    writeAllowed: true,
    commitAllowed: true,
    validationCommands: [[process.execPath, "--test", "health.test.mjs"]],
  });
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Add health-check metadata",
      objective: "Add a service metadata field to a noncritical sample health check and update its tests",
      domain: "software_delivery",
      priority: "normal",
      riskLevel: "low",
      successCriteria: [
        "Health response includes service metadata",
        "Repository tests pass",
        "A local review commit exists",
      ],
      constraints: ["No push", "No merge", "No deployment", "No external APIs"],
    },
  });
  const task = await handleCreateTask({
    actor: executionActor,
    commandId: randomUUID(),
    task: {
      missionId: mission.missionId,
      name: "Implement health metadata",
      instructions:
        'Update the health response to include service: "sample-app". Keep the change minimal and make the existing test pass.',
      expectedOutput: "A local commit with the health metadata change and passing tests",
      priority: "normal",
      riskLevel: "low",
      requiredCapabilities: ["repository.write", "code.implement", "test.run", "git.commit"],
      timeoutSeconds: 900,
      verificationRequirements: ["node --test health.test.mjs"],
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
      event: "phase2_acceptance_ready",
      workspaceId: DEFAULT_WORKSPACE_ID,
      missionId: mission.missionId,
      taskId: task.taskId,
      executionId: execution.executionId,
      agentId,
      repositoryId,
      repositoryPath: repository,
      repositoryRoot,
      worktreeRoot,
      artifactRoot,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
