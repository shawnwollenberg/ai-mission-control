import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { closeDatabasePool, getDatabasePool } from "../lib/database";
import { registerAgent, registerRepository } from "../application/registry";
import { handleCreateMission, handleMissionTransition } from "../application/mission-commands";
import { handleCreateTask } from "../application/task-commands";
import { handleRequestExecution } from "../application/execution-commands";
import {
  bindProjectBrainContext,
  requestProjectBrainOperation,
  requestProjectBrainWriteApproval,
} from "../application/project-brain-commands";
import { decideApproval } from "../application/approval-commands";
import { executeProjectBrainOperation } from "../integrations/project-brain/worker";
import { executeCodex } from "../execution/codex-adapter";
import { readExecutionArtifact } from "../execution/artifact-store";
import type { ProjectBrainOperation } from "../integrations/project-brain/types";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const command = (cwd: string, binary: string, args: string[]) =>
  execFileSync(binary, args, { cwd, encoding: "utf8" }).trim();
const workspaceId = randomUUID();
const ownerId = randomUUID();
const objective = "Add service metadata to the health response";
const actor = { workspaceId, userId: ownerId, role: "owner" as const };
const domainActor = { workspaceId, id: ownerId, type: "human" as const };

async function main() {
  const root = await mkdtemp(join(tmpdir(), "project-brain-final-local-"));
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const artifacts = join(root, "artifacts");
  await mkdir(repository, { recursive: true });
  await mkdir(worktrees, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  process.env.CODEX_REPOSITORY_ROOT = root;
  process.env.CODEX_WORKTREE_ROOT = worktrees;
  process.env.ARTIFACT_STORAGE_ROOT = artifacts;
  command(repository, "git", ["init", "-q", "-b", "main"]);
  command(repository, "git", ["config", "user.email", "local-acceptance@example.com"]);
  command(repository, "git", ["config", "user.name", "Local Acceptance"]);
  await writeFile(join(repository, "health.mjs"), 'export const health = () => ({ status: "ok" });\n');
  await writeFile(
    join(repository, "health.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { health } from "./health.mjs";\ntest("health", () => assert.equal(health().status, "ok"));\n',
  );
  command(repository, "git", ["add", "."]);
  command(repository, "git", ["commit", "-qm", "initial health fixture"]);
  const initialSha = command(repository, "git", ["rev-parse", "HEAD"]);
  const repositoryId = randomUUID();
  const agentId = randomUUID();
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)", [
    workspaceId,
    `pb-final-local-${workspaceId}`,
    "Project Brain final local acceptance",
  ]);
  await registerAgent({
    actor,
    agentId,
    name: "Local acceptance Codex",
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
    credentialReference: "env:CODEX_HOME",
  });
  await registerRepository({
    actor,
    repositoryId,
    name: basename(repository),
    localPath: repository,
    defaultBranch: "main",
    allowedAgentIds: [agentId],
    readAllowed: true,
    writeAllowed: true,
    commitAllowed: true,
    validationCommands: [[process.execPath, "--test", "health.test.mjs"]],
  });
  await getDatabasePool().query(
    `UPDATE repositories SET project_brain_enabled=true,location_mode='server',observed_commit=$3
     WHERE workspace_id=$1 AND repository_id=$2`,
    [workspaceId, repositoryId, initialSha],
  );
  const mission = await handleCreateMission({
    actor,
    commandId: randomUUID(),
    mission: {
      name: "Final local Project Brain acceptance",
      objective,
      domain: "software_delivery",
      priority: "normal",
      riskLevel: "moderate",
      successCriteria: ["health returns service metadata", "tests pass"],
      constraints: ["No push, merge, publication, or deployment"],
    },
  });

  const setObservedHead = async () => {
    const head = command(repository, "git", ["rev-parse", "HEAD"]);
    await getDatabasePool().query(
      "UPDATE repositories SET observed_commit=$3,updated_at=now() WHERE workspace_id=$1 AND repository_id=$2",
      [workspaceId, repositoryId, head],
    );
    return head;
  };
  const commitRepositoryArtifacts = async (message: string) => {
    command(repository, "git", ["add", ".project-brain", "AGENTS.md"]);
    command(repository, "git", ["commit", "-qm", message]);
    return setObservedHead();
  };
  const runOperation = async (
    operation: ProjectBrainOperation,
    args: Record<string, unknown>,
    write: boolean,
    executionId?: string,
  ) => {
    const startingSha = command(repository, "git", ["rev-parse", "HEAD"]);
    const base = {
      repositoryId,
      missionId: mission.missionId,
      executionId,
      operation,
      arguments: args,
      startingSha,
    };
    let approvalId: string | undefined;
    if (write) {
      const approval = await requestProjectBrainWriteApproval({ actor: domainActor, request: base });
      approvalId = approval.approvalId;
      await decideApproval({
        workspaceId,
        approvalId,
        granted: true,
        actorId: ownerId,
        reason: "Disposable final local acceptance",
      });
    }
    const requested = await requestProjectBrainOperation({
      actor: domainActor,
      request: { ...base, approvalId, idempotencyKey: randomUUID() },
    });
    await executeProjectBrainOperation({
      workspaceId,
      operationId: requested.operationId,
      workerId: "project-brain-final-local-acceptance",
      finalAttempt: true,
    });
    const result = (
      await getDatabasePool().query<{
        status: string;
        ending_sha: string | null;
        failure_cause: string | null;
        result: Record<string, unknown>;
      }>(
        `SELECT status,ending_sha,failure_cause,result FROM project_brain_operation_projections
         WHERE workspace_id=$1 AND operation_id=$2`,
        [workspaceId, requested.operationId],
      )
    ).rows[0];
    if (result.status !== "succeeded")
      throw new Error(`${operation} ${result.status}: ${result.failure_cause ?? "unknown failure"}`);
    return { ...result, operationId: requested.operationId, startingSha };
  };

  await runOperation("initialize_repository", { repository_id: repositoryId }, true);
  const initializedSha = await commitRepositoryArtifacts("initialize Project Brain");
  await runOperation("detect_repository", {}, false);
  await runOperation("validate_repository", {}, false);
  await runOperation("prepare_context", { objective, role: "implementer", preview: true, write: false }, false);
  const task = await handleCreateTask({
    actor: domainActor,
    commandId: randomUUID(),
    task: {
      missionId: mission.missionId,
      name: "Add service metadata",
      instructions: 'Add service: "sample-app" to the object returned by health() and preserve status.',
      expectedOutput: "Passing health test and a local review commit",
      priority: "normal",
      riskLevel: "moderate",
      timeoutSeconds: 300,
    },
  });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "planned" });
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: mission.missionId, target: "running" });
  const execution = await handleRequestExecution({
    actor: domainActor,
    commandId: randomUUID(),
    taskId: task.taskId,
    agentId,
    repositoryId,
    timeoutSeconds: 300,
  });
  const contextPath = `.project-brain/context-packs/${mission.missionId}.yaml`;
  await runOperation(
    "prepare_context",
    {
      objective,
      role: "implementer",
      preview: false,
      write: true,
      mission_id: mission.missionId,
      execution_id: execution.executionId,
      output: contextPath,
    },
    true,
    execution.executionId,
  );
  const contextProjection = (
    await getDatabasePool().query<{
      final_context_artifact_id: string;
      context_checksum: string;
      starting_sha: string;
      context_bytes: number;
    }>(
      `SELECT final_context_artifact_id,context_checksum,starting_sha,context_bytes
       FROM mission_project_brain_projections WHERE workspace_id=$1 AND mission_id=$2`,
      [workspaceId, mission.missionId],
    )
  ).rows[0];
  const storedContext = await readExecutionArtifact(workspaceId, contextProjection.final_context_artifact_id);
  if (!storedContext) throw new Error("Stored local context artifact is unavailable");
  const contextContent = storedContext.body.toString("utf8");
  if (createHash("sha256").update(contextContent).digest("hex") !== contextProjection.context_checksum)
    throw new Error("Stored local context checksum mismatch");
  await rm(join(repository, contextPath), { force: true });
  if (command(repository, "git", ["status", "--porcelain=v1", "--untracked-files=all"]))
    throw new Error("Local context cleanup left unexpected repository changes");
  await bindProjectBrainContext({
    actor: domainActor,
    missionId: mission.missionId,
    executionId: execution.executionId,
    agentId,
    repositoryId,
    currentSha: contextProjection.starting_sha,
  });
  const codeResult = await executeCodex({
    workspaceId,
    executionId: execution.executionId,
    workerId: "project-brain-final-local-codex",
  });
  if (codeResult.status !== "succeeded" || !codeResult.commitId) throw new Error("Local Codex execution failed");
  const codeEndSha = codeResult.commitId;
  const codeValue = command(repository, "git", ["show", `${codeEndSha}:health.mjs`]);
  if (!codeValue.includes('service: "sample-app"')) throw new Error("Local code commit lacks the requested change");
  execFileSync(process.execPath, ["--test", "health.test.mjs"], {
    cwd: codeResult.worktreePath,
    stdio: "inherit",
  });
  await mkdir(dirname(join(repository, contextPath)), { recursive: true });
  await writeFile(join(repository, contextPath), contextContent);
  await commitRepositoryArtifacts("record immutable Project Brain context");
  const closure = await runOperation(
    "record_closure",
    {
      objective,
      role: "implementer",
      agent: "codex",
      status: "completed",
      start_sha: initializedSha,
      end_sha: codeEndSha,
      acceptance_criterion: ["health returns service metadata", "tests pass"],
      acceptance_outcome: "Passed with an independently inspectable local commit",
      evidence: [contextPath],
      check: ["node --test health.test.mjs=passed"],
      context_checksum: contextProjection.context_checksum,
    },
    true,
    execution.executionId,
  );
  await commitRepositoryArtifacts("record Project Brain closure");
  const missionArtifact = (
    (closure.result as { envelope?: { artifacts?: Array<{ path?: string; kind?: string }> } }).envelope?.artifacts ?? []
  ).find((artifact) => artifact.kind === "mission_result")?.path;
  if (!missionArtifact) throw new Error("Local closure did not return a mission result");
  await runOperation(
    "propose_learning",
    {
      mission_id: missionArtifact
        .split("/")
        .at(-1)!
        .replace(/\.yaml$/, ""),
      title: "Retain exact local context continuity",
      claim: "Local changes should consume the exact verified Project Brain context artifact.",
      scope: ["repository"],
      evidence: [`mission:${missionArtifact}`],
      proposer: "mission-control",
      future_behavior: "Verify the immutable checksum before local execution.",
    },
    true,
    execution.executionId,
  );
  await commitRepositoryArtifacts("propose Project Brain learning");
  await runOperation(
    "evaluate_learning",
    { reviewer: "independent-review", output: `.project-brain/evaluations/${mission.missionId}.yaml` },
    true,
    execution.executionId,
  );
  const finalSha = await commitRepositoryArtifacts("evaluate Project Brain learning");
  const missionEvidence = (
    await getDatabasePool().query(
      `SELECT context_checksum,agent_received_checksum,agent_verified_checksum,agent_verification_status,
        closure_status,learning_proposal_status,evaluation_status
       FROM mission_project_brain_projections WHERE workspace_id=$1 AND mission_id=$2`,
      [workspaceId, mission.missionId],
    )
  ).rows[0];
  if (
    missionEvidence.context_checksum !== contextProjection.context_checksum ||
    missionEvidence.agent_received_checksum !== contextProjection.context_checksum ||
    missionEvidence.agent_verified_checksum !== contextProjection.context_checksum ||
    missionEvidence.agent_verification_status !== "verified"
  )
    throw new Error("Local context continuity was not exact");
  const promotion = {
    confirmedFiles: Number(
      command(repository, "sh", ["-c", "find .project-brain/lessons/confirmed -type f 2>/dev/null | wc -l"]),
    ),
    confirmedProjection: (
      await getDatabasePool().query<{ count: number }>(
        `SELECT count(*)::int count FROM artifacts WHERE workspace_id=$1
         AND metadata->>'projectBrainKind'='confirmed_learning'`,
        [workspaceId],
      )
    ).rows[0].count,
  };
  if (promotion.confirmedFiles || promotion.confirmedProjection) throw new Error("Automatic promotion detected");
  const replay = JSON.parse(
    execFileSync(
      "npx",
      ["tsx", "scripts/projections.ts", "--verify", "--workspace", workspaceId, "--projection", "project-brain"],
      { cwd: resolve("."), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
    ).trim(),
  );
  if (replay.equal !== true) throw new Error("Local projection replay mismatch");
  console.log(
    JSON.stringify(
      {
        disposition: "local_project_brain_lifecycle_passed",
        workspaceId,
        repositoryId,
        repository,
        initialSha,
        initializedSha,
        context: {
          checksum: contextProjection.context_checksum,
          bytes: contextProjection.context_bytes,
          startingSha: contextProjection.starting_sha,
        },
        codeEndSha,
        finalSha,
        missionEvidence,
        promotion,
        replay,
      },
      null,
      2,
    ),
  );
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
