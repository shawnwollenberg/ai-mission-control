import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ValidationFailedError } from "@/lib/application-errors";
import { runSafeProcess } from "@/execution/safe-process";
const ref = /^[A-Za-z0-9._/-]+$/;
export async function validateRepositoryPath(localPath: string, approvedRoot: string) {
  const [repository, root] = await Promise.all([realpath(localPath), realpath(approvedRoot)]);
  if (repository !== root && !repository.startsWith(`${root}/`))
    throw new ValidationFailedError("Repository path escapes the approved repository root");
  const result = await runSafeProcess({
    executable: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd: repository,
    allowedRoot: root,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true")
    throw new ValidationFailedError("Registered path is not a Git repository");
  return repository;
}
export function executionBranch(missionId: string, taskId: string, executionId: string) {
  return `codex/${missionId}/${taskId}/${executionId}`;
}
export async function createExecutionWorktree(input: {
  repositoryPath: string;
  repositoryRoot: string;
  worktreeRoot: string;
  missionId: string;
  taskId: string;
  executionId: string;
  baseRef: string;
}) {
  if (!ref.test(input.baseRef) || input.baseRef.includes(".."))
    throw new ValidationFailedError("Base reference is not allowed");
  const repository = await validateRepositoryPath(input.repositoryPath, input.repositoryRoot);
  await mkdir(input.worktreeRoot, { recursive: true });
  const root = await realpath(input.worktreeRoot);
  const worktreePath = path.join(root, input.executionId),
    branchName = executionBranch(input.missionId, input.taskId, input.executionId);
  const verify = await runSafeProcess({
    executable: "git",
    args: ["rev-parse", "--verify", `${input.baseRef}^{commit}`],
    cwd: repository,
    allowedRoot: input.repositoryRoot,
    timeoutMs: 10_000,
  });
  if (verify.exitCode !== 0) throw new ValidationFailedError("Base reference does not resolve to a commit");
  const result = await runSafeProcess({
    executable: "git",
    args: ["worktree", "add", "-b", branchName, worktreePath, input.baseRef],
    cwd: repository,
    allowedRoot: input.repositoryRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 100_000,
  });
  if (result.exitCode !== 0) throw new Error(`Unable to create execution worktree: ${result.stderr}`);
  return { repositoryPath: repository, worktreePath, branchName, baseCommit: verify.stdout.trim() };
}
