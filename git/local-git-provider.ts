import { ValidationFailedError } from "@/lib/application-errors";
import { runSafeProcess } from "@/execution/safe-process";
import type {
  CreatePullRequestRequest,
  CreatePullRequestResult,
  GitProvider,
  PushBranchRequest,
  PushBranchResult,
} from "@/git/git-provider";

const safeRef = /^[A-Za-z0-9._/-]+$/;
export class LocalGitProvider implements GitProvider {
  async pushBranch(request: PushBranchRequest): Promise<PushBranchResult> {
    if (!safeRef.test(request.branch) || !safeRef.test(request.remote) || request.branch.includes(".."))
      throw new ValidationFailedError("Invalid Git branch or remote");
    const head = await runSafeProcess({
      executable: "git",
      args: ["rev-parse", "HEAD"],
      cwd: request.worktreePath,
      allowedRoot: request.worktreeRoot,
      timeoutMs: 10_000,
      env: request.credentialEnvironment,
    });
    if (head.exitCode !== 0 || head.stdout.trim() !== request.commit)
      throw new ValidationFailedError("Worktree HEAD no longer matches the approved commit");
    const before = await runSafeProcess({
      executable: "git",
      args: ["ls-remote", "--heads", request.remote, `refs/heads/${request.branch}`],
      cwd: request.worktreePath,
      allowedRoot: request.worktreeRoot,
      timeoutMs: 20_000,
      env: request.credentialEnvironment,
    });
    const existing = before.stdout.trim().split(/\s+/)[0];
    if (existing && existing !== request.commit)
      throw new ValidationFailedError("Remote branch exists at a different commit; force push is prohibited");
    if (!existing) {
      const pushed = await runSafeProcess({
        executable: "git",
        args: ["push", request.remote, `${request.commit}:refs/heads/${request.branch}`],
        cwd: request.worktreePath,
        allowedRoot: request.worktreeRoot,
        timeoutMs: 60_000,
        maxOutputBytes: 200_000,
        env: request.credentialEnvironment,
      });
      if (pushed.exitCode !== 0) throw new Error(`Git push failed without force: ${pushed.stderr}`);
    }
    const after = await runSafeProcess({
      executable: "git",
      args: ["ls-remote", "--heads", request.remote, `refs/heads/${request.branch}`],
      cwd: request.worktreePath,
      allowedRoot: request.worktreeRoot,
      timeoutMs: 20_000,
      env: request.credentialEnvironment,
    });
    if (after.stdout.trim().split(/\s+/)[0] !== request.commit)
      throw new Error("Provider did not confirm the approved remote commit");
    return {
      remote: request.remote,
      branch: request.branch,
      commit: request.commit,
      remoteRef: `refs/heads/${request.branch}`,
      alreadyExisted: Boolean(existing),
    };
  }
  async createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResult> {
    void request;
    throw new ValidationFailedError("A confirmed pull-request provider is not configured");
  }
}
