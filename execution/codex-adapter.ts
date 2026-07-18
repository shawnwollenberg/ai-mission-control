import { getDatabasePool } from "@/lib/database";
import { loadAggregateEvents } from "@/lib/postgres-event-store";
import { rehydrateExecution } from "@/domain/execution";
import { handleExecutionFact, handleExecutionTransition } from "@/application/execution-commands";
import { handleTaskTransition } from "@/application/task-commands";
import { coordinateAfterTask } from "@/application/mission-coordinator";
import { stableUuid } from "@/lib/stable-id";
import { createExecutionWorktree } from "@/execution/worktree-manager";
import { runSafeProcess } from "@/execution/safe-process";
import { storeExecutionArtifact } from "@/execution/artifact-store";
import { validateExecutionRequest, type ExecutionRequest } from "@/execution/protocol";
type Context = {
  execution_id: string;
  workspace_id: string;
  mission_id: string;
  task_id: string;
  agent_id: string;
  attempt: number;
  status: string;
  repository_id: string;
  name: string;
  objective: string;
  instructions: string;
  expected_output: string | null;
  timeout_at: Date;
  local_path: string;
  default_branch: string;
  validation_commands: string[][];
  commit_allowed: boolean;
  push_allowed: boolean;
  merge_allowed: boolean;
  deployment_allowed: boolean;
};
const actor = (workspaceId: string, workerId: string) => ({ workspaceId, id: workerId, type: "agent" as const });
const command = (executionId: string, action: string) => stableUuid(`codex:${executionId}:${action}`);
async function context(workspaceId: string, executionId: string) {
  const result = await getDatabasePool().query<Context>(
    `SELECT e.*,m.objective,t.name,t.instructions,t.expected_output,r.local_path,r.default_branch,r.validation_commands,r.commit_allowed,r.push_allowed,r.merge_allowed,r.deployment_allowed FROM execution_projections e JOIN mission_projections m ON m.workspace_id=e.workspace_id AND m.mission_id=e.mission_id JOIN task_projections t ON t.workspace_id=e.workspace_id AND t.task_id=e.task_id JOIN repositories r ON r.workspace_id=e.workspace_id AND r.repository_id=e.repository_id WHERE e.workspace_id=$1 AND e.execution_id=$2`,
    [workspaceId, executionId],
  );
  if (!result.rowCount) throw new Error("Execution context not found");
  return result.rows[0];
}
function prompt(request: ExecutionRequest, worktreePath: string) {
  return [
    `Mission objective: ${request.objective}`,
    `Task objective: ${request.expectedOutput}`,
    `Instructions: ${request.instructions}`,
    `Repository worktree: ${worktreePath}`,
    `Base branch: ${request.repository.baseRef}`,
    "You may edit only this worktree and run non-destructive repository-local commands.",
    "Implement the bounded change and run the expected tests. Do not push, merge, deploy, modify infrastructure, access secrets, or use unrelated directories.",
    "Return a concise factual summary of files changed and validation performed. Do not include chain-of-thought.",
  ].join("\n\n");
}
export async function executeCodex(input: {
  workspaceId: string;
  executionId: string;
  workerId: string;
  signal?: AbortSignal;
}) {
  const row = await context(input.workspaceId, input.executionId);
  if (["succeeded", "failed", "timed_out", "cancelled"].includes(row.status))
    return { terminal: true, status: row.status };
  const events = await loadAggregateEvents({
    workspaceId: input.workspaceId,
    aggregateType: "execution",
    aggregateId: input.executionId,
  });
  const state = rehydrateExecution(events)!;
  const request = validateExecutionRequest({
    protocolVersion: "1.0",
    kind: "execution.request",
    executionId: row.execution_id,
    missionId: row.mission_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    attempt: row.attempt,
    objective: row.objective,
    instructions: row.instructions,
    expectedOutput: row.expected_output ?? "Working implementation with passing tests",
    constraints: ["Do not push", "Do not merge", "Do not deploy", "Remain inside the registered worktree"],
    repository: { repositoryId: row.repository_id, baseRef: row.default_branch },
    approvalPolicy: { mergeRequired: true, deploymentRequired: true, destructiveActionRequired: true },
    timeoutSeconds: Math.max(1, Math.floor((row.timeout_at.getTime() - Date.now()) / 1000)),
    heartbeatIntervalSeconds: 30,
    idempotencyKey: String(events[0].payload.idempotencyKey),
  });
  const a = actor(input.workspaceId, input.workerId);
  if (state.status === "requested")
    await handleExecutionTransition({
      actor: a,
      commandId: command(input.executionId, "accept"),
      executionId: input.executionId,
      target: "accepted",
      details: { workerId: input.workerId, stage: "accepted" },
    });
  await handleExecutionTransition({
    actor: a,
    commandId: command(input.executionId, "prepare"),
    executionId: input.executionId,
    target: "preparing",
    details: { workerId: input.workerId, stage: "preparing_repository" },
  });
  let worktree;
  try {
    worktree = await createExecutionWorktree({
      repositoryPath: row.local_path,
      repositoryRoot: process.env.CODEX_REPOSITORY_ROOT!,
      worktreeRoot: process.env.CODEX_WORKTREE_ROOT!,
      missionId: row.mission_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      baseRef: row.default_branch,
    });
  } catch (error) {
    await fail(a, row, "repository_unavailable", "requires-human-review", error);
    throw error;
  }
  await handleExecutionTransition({
    actor: a,
    commandId: command(input.executionId, "start"),
    executionId: input.executionId,
    target: "running",
    details: {
      workerId: input.workerId,
      stage: "running_codex",
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
    },
  });
  await handleTaskTransition({
    actor: a,
    commandId: command(input.executionId, "task-start"),
    taskId: row.task_id,
    target: "running",
  });
  const promptBody = prompt(request, worktree.worktreePath);
  await storeExecutionArtifact({
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: "codex_prompt",
    mediaType: "text/plain",
    body: promptBody,
  });
  await handleExecutionFact({
    actor: a,
    commandId: command(input.executionId, "progress-codex"),
    executionId: input.executionId,
    type: "execution.progress_reported",
    payload: { stage: "editing_files", summary: "Codex started in the isolated worktree" },
  });
  const executable = process.env.CODEX_EXECUTABLE ?? "codex",
    prefix = process.env.CODEX_EXECUTABLE_ARGS_JSON
      ? (JSON.parse(process.env.CODEX_EXECUTABLE_ARGS_JSON) as string[])
      : [
          "exec",
          "--json",
          "--sandbox",
          "workspace-write",
          "--ignore-user-config",
          "--ignore-rules",
          "--cd",
          worktree.worktreePath,
          "-",
        ];
  const result = await runSafeProcess({
    executable,
    args: prefix,
    cwd: worktree.worktreePath,
    allowedRoot: process.env.CODEX_WORKTREE_ROOT!,
    env: {
      PATH: process.env.CODEX_RUNTIME_PATH ?? process.env.PATH ?? "",
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    },
    stdin: promptBody,
    timeoutMs: request.timeoutSeconds * 1000,
    maxOutputBytes: 2_000_000,
    signal: input.signal,
    redact: (process.env.CODEX_REDACT_VALUES ?? "").split(",").filter(Boolean),
  });
  await storeExecutionArtifact({
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: "codex_execution_log",
    mediaType: "application/jsonl",
    body: `${result.stdout}\n${result.stderr}`,
  });
  if (result.cancelled) {
    await cancel(a, row);
    return { terminal: true, status: "cancelled" };
  }
  if (result.timedOut) {
    await timeout(a, row);
    return { terminal: true, status: "timed_out" };
  }
  if (result.exitCode !== 0) {
    await fail(a, row, "execution_failure", "requires-human-review", new Error(`Codex exited ${result.exitCode}`));
    return { terminal: true, status: "failed" };
  }
  await handleExecutionTransition({
    actor: a,
    commandId: command(input.executionId, "verify"),
    executionId: input.executionId,
    target: "verifying",
    details: { stage: "running_tests" },
  });
  await handleTaskTransition({
    actor: a,
    commandId: command(input.executionId, "task-verify"),
    taskId: row.task_id,
    target: "verifying",
  });
  for (let index = 0; index < row.validation_commands.length; index++) {
    const [executable, ...args] = row.validation_commands[index];
    const validation = await runSafeProcess({
      executable,
      args,
      cwd: worktree.worktreePath,
      allowedRoot: process.env.CODEX_WORKTREE_ROOT!,
      env: { PATH: process.env.CODEX_RUNTIME_PATH ?? process.env.PATH ?? "" },
      timeoutMs: 300_000,
      maxOutputBytes: 1_000_000,
      signal: input.signal,
      redact: (process.env.CODEX_REDACT_VALUES ?? "").split(",").filter(Boolean),
    });
    await storeExecutionArtifact({
      workspaceId: row.workspace_id,
      missionId: row.mission_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      kind: "test_result",
      mediaType: "text/plain",
      body: `$ ${[executable, ...args].join(" ")}\nexit=${validation.exitCode}\n${validation.stdout}\n${validation.stderr}`,
    });
    await handleExecutionFact({
      actor: a,
      commandId: command(input.executionId, `command-${index}`),
      executionId: input.executionId,
      type: "execution.command_completed",
      payload: {
        stage: "running_tests",
        summary: `Validation command ${index + 1} exited ${validation.exitCode}`,
        exitCode: validation.exitCode,
      },
    });
    if (validation.exitCode !== 0) {
      await fail(a, row, "test_failure", "requires-human-review", new Error("Validation command failed"));
      return { terminal: true, status: "failed" };
    }
  }
  const patch = await git(worktree.worktreePath, ["diff", "--binary", "HEAD"]);
  const status = await git(worktree.worktreePath, ["status", "--short"]);
  await storeExecutionArtifact({
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: "git_patch",
    mediaType: "text/x-diff",
    body: patch.stdout,
  });
  await storeExecutionArtifact({
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: "git_status",
    mediaType: "text/plain",
    body: status.stdout,
  });
  if (!status.stdout.trim()) {
    await fail(a, row, "execution_failure", "requires-human-review", new Error("Codex produced no repository changes"));
    return { terminal: true, status: "failed" };
  }
  if (!row.commit_allowed) {
    await fail(a, row, "invalid_configuration", "non-retryable", new Error("Repository does not permit local commits"));
    return { terminal: true, status: "failed" };
  }
  await git(worktree.worktreePath, ["add", "--all"]);
  const committed = await git(worktree.worktreePath, [
    "-c",
    "user.name=Mission Control Codex",
    "-c",
    "user.email=codex@localhost",
    "commit",
    "-m",
    `codex: complete execution ${row.execution_id}`,
  ]);
  if (committed.exitCode !== 0) {
    await fail(a, row, "command_failure", "requires-human-review", new Error(committed.stderr));
    return { terminal: true, status: "failed" };
  }
  const commit = (await git(worktree.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const summary = result.stdout.split("\n").filter(Boolean).at(-1)?.slice(0, 1000) ?? "Codex execution completed";
  await storeExecutionArtifact({
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: "final_summary",
    mediaType: "text/plain",
    body: summary,
    metadata: { commitId: commit },
  });
  await handleExecutionTransition({
    actor: a,
    commandId: command(input.executionId, "success"),
    executionId: input.executionId,
    target: "succeeded",
    details: { stage: "completed", summary: "Codex completed the bounded change and validation", commitId: commit },
  });
  await handleTaskTransition({
    actor: a,
    commandId: command(input.executionId, "task-complete"),
    taskId: row.task_id,
    target: "completed",
    details: { summary: "Live Codex execution succeeded", commitId: commit },
  });
  await coordinateAfterTask(row.workspace_id, row.mission_id, row.task_id, "task.completed");
  return {
    terminal: true,
    status: "succeeded",
    commitId: commit,
    worktreePath: worktree.worktreePath,
    branchName: worktree.branchName,
  };
}
async function git(cwd: string, args: string[]) {
  return runSafeProcess({
    executable: "git",
    args,
    cwd,
    allowedRoot: process.env.CODEX_WORKTREE_ROOT!,
    env: { PATH: process.env.CODEX_RUNTIME_PATH ?? process.env.PATH ?? "" },
    timeoutMs: 60_000,
    maxOutputBytes: 2_000_000,
  });
}
async function fail(
  a: ReturnType<typeof actor>,
  row: Context,
  classification: string,
  retryDisposition: string,
  error: unknown,
) {
  await handleExecutionTransition({
    actor: a,
    commandId: command(row.execution_id, `fail-${classification}`),
    executionId: row.execution_id,
    target: "failed",
    details: {
      stage: "failed",
      summary: error instanceof Error ? error.message : String(error),
      classification,
      retryDisposition,
    },
  });
}
async function cancel(a: ReturnType<typeof actor>, row: Context) {
  await handleExecutionTransition({
    actor: a,
    commandId: command(row.execution_id, "cancelled"),
    executionId: row.execution_id,
    target: "cancelled",
    details: { stage: "cancelled", classification: "cancellation", retryDisposition: "non-retryable" },
  });
  await handleTaskTransition({
    actor: a,
    commandId: command(row.execution_id, "task-cancelled"),
    taskId: row.task_id,
    target: "cancelled",
    details: { reason: "execution_cancelled" },
  });
}
async function timeout(a: ReturnType<typeof actor>, row: Context) {
  await handleExecutionTransition({
    actor: a,
    commandId: command(row.execution_id, "timeout"),
    executionId: row.execution_id,
    target: "timed_out",
    details: { stage: "timed_out", classification: "timeout", retryDisposition: "requires-human-review" },
  });
}
