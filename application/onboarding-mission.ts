import { randomUUID } from "node:crypto";
import { handleCreateMission, handleMissionTransition, type CommandActor } from "@/application/mission-commands";
import { handleCreateTask } from "@/application/task-commands";
import { handleRequestRemoteExecution } from "@/application/execution-commands";
import { getDatabasePool } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";

export async function launchFirstRepositoryMission(input: {
  actor: CommandActor;
  commandId: string;
  agentId: string;
  repositoryId: string;
  objective?: string;
}) {
  const objective =
    input.objective?.trim() ||
    "Analyze this repository and produce a concise architecture, risk, and next-steps report";
  if (objective.length > 1000) throw new ValidationFailedError("Analysis objective must be 1,000 characters or fewer");
  const resource = (
    await getDatabasePool().query(
      `SELECT r.repository_id,r.name,a.pull_ready_at,a.mission_agent_adapter
       FROM repositories r JOIN agents a ON a.workspace_id=r.workspace_id AND a.agent_id=$2
       WHERE r.workspace_id=$1 AND r.repository_id=$3 AND r.location_mode='mission_agent' AND r.disabled_at IS NULL
         AND a.delivery_mode='pull' AND a.status='active' AND a.pull_ready_at>now()-interval '5 minutes'
         AND r.allowed_agent_ids ? $2::text`,
      [input.actor.workspaceId, input.agentId, input.repositoryId],
    )
  ).rows[0];
  if (!resource) throw new NotFoundError("Ready Mission Agent repository");
  if (resource.mission_agent_adapter !== "codex")
    throw new ValidationFailedError("This adapter can connect but cannot execute the first local mission yet");
  const missionId = randomUUID();
  await handleCreateMission({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:mission`),
    missionId,
    mission: {
      name: "Analyze this repository",
      objective,
      description: "A genuine read-only analysis executed by the locally connected Mission Agent Codex adapter.",
      domain: "software_delivery",
      priority: "normal",
      riskLevel: "low",
      successCriteria: [
        "A checksummed Markdown repository-analysis artifact is received",
        "No repository files change",
      ],
      constraints: [
        "Read-only repository access",
        "No package installation, commit, push, pull request, merge, deployment, or secret access",
      ],
    },
  });
  const taskId = randomUUID();
  await handleCreateTask({
    actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
    commandId: stableUuid(`${input.commandId}:task`),
    taskId,
    task: {
      missionId,
      name: "Analyze this repository",
      instructions: `Inspect repository structure, configuration, commands, and tests; produce evidence-based Markdown findings. Analysis objective: ${objective}`,
      expectedOutput:
        "Markdown repository analysis with overview, technologies, structure, commands, tests, risks, and next mission.",
      priority: "normal",
      riskLevel: "low",
      requiredCapabilities: ["repository.read", "code.review", "artifact.create"],
      requiredResources: [{ resourceType: "repository", resourceId: input.repositoryId, permission: "read" }],
      maximumAttempts: 2,
      timeoutSeconds: 600,
    },
  });
  await handleMissionTransition({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:planned`),
    missionId,
    target: "planned",
  });
  await handleMissionTransition({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:running`),
    missionId,
    target: "running",
  });
  const execution = await handleRequestRemoteExecution({
    actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
    commandId: stableUuid(`${input.commandId}:execution`),
    taskId,
    agentId: input.agentId,
    timeoutSeconds: 600,
  });
  return { missionId, taskId, executionId: execution.executionId };
}
