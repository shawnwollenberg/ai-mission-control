import { runSafeProcess } from "@/execution/safe-process";
import { ValidationFailedError } from "@/lib/application-errors";

export type PublicationPreflightInput = {
  worktreePath: string;
  worktreeRoot: string;
  remote: string;
  allowedRemotes: string[];
  targetBranch: string;
  protectedBranches: string[];
  allowedBranchPrefixes: string[];
  generatedBranch: string;
  approvedCommit: string;
  force?: boolean;
};

export type PublicationPreflightResult = {
  remote: string;
  targetBranch: string;
  targetCommit: string;
  generatedBranch: string;
  generatedCommit: string;
  commonAncestor: string;
};

async function git(input: PublicationPreflightInput, args: string[]) {
  return runSafeProcess({
    executable: "git",
    args,
    cwd: input.worktreePath,
    allowedRoot: input.worktreeRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 200_000,
  });
}

function invalid(message: string, failureType: string, details: Record<string, unknown> = {}): never {
  throw new ValidationFailedError(message, { failureType, ...details });
}

export async function validatePublicationPreflight(
  input: PublicationPreflightInput,
): Promise<PublicationPreflightResult> {
  if (!input.allowedRemotes.includes(input.remote)) invalid("Git remote is not approved", "remote_not_approved");
  if (input.force) invalid("Force push is prohibited", "force_push_prohibited");
  if (input.protectedBranches.includes(input.generatedBranch) || input.generatedBranch === input.targetBranch)
    invalid("Generated branch cannot be a protected or target branch", "protected_branch");
  if (!input.allowedBranchPrefixes.some((prefix) => input.generatedBranch.startsWith(prefix)))
    invalid("Generated branch prefix is not approved", "branch_prefix_not_approved");

  const remote = await git(input, ["remote", "get-url", input.remote]);
  if (remote.exitCode !== 0) invalid("Approved Git remote is not configured", "remote_not_configured");
  const target = await git(input, ["ls-remote", "--exit-code", input.remote, `refs/heads/${input.targetBranch}`]);
  if (target.exitCode !== 0) invalid("Target branch does not exist on the approved remote", "target_not_found");
  const targetCommit = target.stdout.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(targetCommit)) invalid("Remote target commit is invalid", "target_commit_invalid");

  const approved = await git(input, ["rev-parse", "--verify", `${input.approvedCommit}^{commit}`]);
  if (approved.exitCode !== 0 || approved.stdout.trim() !== input.approvedCommit)
    invalid("Approval-bound commit is not available", "approved_commit_missing");
  const branch = await git(input, ["rev-parse", "--verify", `${input.generatedBranch}^{commit}`]);
  if (branch.exitCode !== 0 || branch.stdout.trim() !== input.approvedCommit)
    invalid("Generated branch tip does not match the approval-bound commit", "approved_commit_changed");
  const clean = await git(input, ["status", "--porcelain", "--untracked-files=normal"]);
  if (clean.exitCode !== 0 || clean.stdout.trim()) invalid("Execution worktree must be clean", "working_tree_dirty");

  // The target object must already be present from the approved preparation/fetch step.
  // Publication never rewrites or combines unrelated history as a fallback.
  const targetObject = await git(input, ["cat-file", "-e", `${targetCommit}^{commit}`]);
  if (targetObject.exitCode !== 0)
    invalid("Provider target commit is not present in the prepared repository", "target_commit_missing", {
      targetCommit,
    });
  const mergeBase = await git(input, ["merge-base", targetCommit, input.approvedCommit]);
  if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim())
    invalid(
      "Generated branch has no common history with the provider target; create a fresh execution from the provider target branch",
      "no_common_history",
      { targetCommit, approvedCommit: input.approvedCommit },
    );
  return {
    remote: remote.stdout.trim(),
    targetBranch: input.targetBranch,
    targetCommit,
    generatedBranch: input.generatedBranch,
    generatedCommit: input.approvedCommit,
    commonAncestor: mergeBase.stdout.trim(),
  };
}
