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
  missionType?: "analysis" | "change";
  objective?: string;
  acceptanceCriteria?: string;
  validationInstructions?: string;
  sourceRecommendationId?: string;
  sourceEvidence?: Array<{ path: string; line?: number; description?: string }>;
}) {
  const missionType = input.missionType ?? "analysis";
  const objective =
    input.objective?.trim() ||
    "Analyze this repository and produce a concise architecture, risk, and next-steps report";
  if (!objective || objective.length > 1000)
    throw new ValidationFailedError("Mission objective must be 1,000 characters or fewer");
  const acceptanceCriteria = textLines(input.acceptanceCriteria, 20, 300);
  const validationCommands = validationLines(input.validationInstructions);
  const resource = (
    await getDatabasePool().query(
      `SELECT r.repository_id,r.name,a.pull_ready_at,a.mission_agent_adapter,a.mission_agent_version
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
  if (missionType === "change" && !supportsRepositoryChanges(resource.mission_agent_version))
    throw new ValidationFailedError(
      "Repository Change Missions require Mission Agent 0.3.1 or newer. Run mission-agent update, then try again.",
    );
  const missionId = randomUUID();
  await handleCreateMission({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:mission`),
    missionId,
    mission: {
      name: missionType === "change" ? `Change ${resource.name}` : `Analyze ${resource.name}`,
      objective,
      description:
        missionType === "change"
          ? "An approval-gated repository change executed in an isolated local Mission Agent worktree."
          : "A genuine read-only analysis executed by the locally connected Mission Agent Codex adapter.",
      domain: "software_delivery",
      priority: "normal",
      riskLevel: missionType === "change" ? "moderate" : "low",
      successCriteria:
        missionType === "change"
          ? [
              ...(acceptanceCriteria.length ? acceptanceCriteria : ["The requested change is implemented"]),
              "Validation, diff, and local commit evidence are received",
            ]
          : ["A checksummed Markdown repository-analysis artifact is received", "No repository files change"],
      constraints: [
        missionType === "change"
          ? "Write only after explicit approval in an isolated worktree"
          : "Read-only repository access",
        missionType === "change"
          ? "Local commit permitted; push, pull request, merge, deployment, infrastructure, and secret access prohibited"
          : "No package installation, commit, push, pull request, merge, deployment, or secret access",
      ],
      resolvedInputs: {
        repositoryId: input.repositoryId,
        missionType,
        ...(input.sourceRecommendationId
          ? { sourceRecommendationId: input.sourceRecommendationId, sourceEvidence: input.sourceEvidence ?? [] }
          : {}),
      },
    },
  });
  const taskId = randomUUID();
  await handleCreateTask({
    actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
    commandId: stableUuid(`${input.commandId}:task`),
    taskId,
    task: {
      missionId,
      name: missionType === "change" ? "Plan and implement approved repository change" : "Analyze this repository",
      instructions:
        missionType === "change"
          ? `Plan the requested change, pause for write approval, then implement it in an isolated worktree. Objective: ${objective}`
          : `Inspect repository structure, configuration, commands, and tests; produce evidence-based Markdown findings. Analysis objective: ${objective}`,
      expectedOutput:
        missionType === "change"
          ? "Implementation plan, changed files, diff, validation evidence, and one local commit for human review."
          : "Markdown repository analysis with overview, technologies, structure, commands, tests, risks, and next mission.",
      priority: "normal",
      riskLevel: missionType === "change" ? "moderate" : "low",
      requiredCapabilities: [
        "repository.read",
        "code.review",
        "artifact.create",
        ...(missionType === "change" ? ["test.run"] : []),
      ],
      requiredResources: [{ resourceType: "repository", resourceId: input.repositoryId, permission: "read" }],
      maximumAttempts: 2,
      timeoutSeconds: 600,
      approvalPolicy: { missionType, writeApprovalRequired: missionType === "change" },
      verificationRequirements: validationCommands.map((command) => command.join(" ")),
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

function supportsRepositoryChanges(version: unknown) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 0 || minor > 3 || (minor === 3 && patch >= 1);
}

function textLines(value: string | undefined, maximum: number, maximumLength: number) {
  const result = (value ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  if (result.length > maximum || result.some((item) => item.length > maximumLength))
    throw new ValidationFailedError("Mission details exceed the supported limits");
  return result;
}

const validationExecutables = new Set(["npm", "pnpm", "yarn", "bun", "npx", "node", "go", "cargo", "pytest"]);
function validationLines(value: string | undefined) {
  const commands = textLines(value, 10, 300).map((line) => line.split(/\s+/));
  if (
    commands.some(
      ([executable, ...args]) =>
        !validationExecutables.has(executable) ||
        args.some(
          (argument) => !/^[A-Za-z0-9_./:@=,+-]+$/.test(argument) || (argument.includes("..") && argument !== "./..."),
        ),
    )
  )
    throw new ValidationFailedError(
      "Validation commands must use an approved repository-local test or build executable with simple arguments",
    );
  return commands;
}
