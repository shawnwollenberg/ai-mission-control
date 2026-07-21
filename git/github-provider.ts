import { runSafeProcess } from "@/execution/safe-process";
import { ValidationFailedError } from "@/lib/application-errors";
import { LocalGitProvider } from "@/git/local-git-provider";
import type {
  CreatePullRequestRequest,
  CreatePullRequestResult,
  GitProvider,
  PushBranchRequest,
  PushBranchResult,
} from "@/git/git-provider";

type Pr = { number: number; url: string; headRefName: string; baseRefName: string; state: string; headRefOid: string };
export class GitHubProvider implements GitProvider {
  pushBranch(request: PushBranchRequest): Promise<PushBranchResult> {
    return new LocalGitProvider().pushBranch(request);
  }
  async createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResult> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository))
      throw new ValidationFailedError("Invalid GitHub repository identity");
    const run = async (args: string[]) =>
      runSafeProcess({
        executable: "gh",
        args,
        cwd: process.cwd(),
        allowedRoot: process.cwd(),
        env: request.credentialEnvironment,
        timeoutMs: 60_000,
        maxOutputBytes: 200_000,
      });
    const list = await run([
      "pr",
      "list",
      "--repo",
      request.repository,
      "--head",
      request.sourceBranch,
      "--base",
      request.targetBranch,
      "--state",
      "all",
      "--json",
      "number,url,headRefName,baseRefName,state,headRefOid",
    ]);
    if (list.exitCode !== 0) throw new Error(`GitHub query failed: ${list.stderr}`);
    let found = (JSON.parse(list.stdout) as Pr[])[0];
    if (!found) {
      const created = await run([
        "pr",
        "create",
        "--repo",
        request.repository,
        "--head",
        request.sourceBranch,
        "--base",
        request.targetBranch,
        "--title",
        request.title,
        "--body",
        request.description,
      ]);
      if (created.exitCode !== 0) throw new Error(`GitHub pull-request creation failed: ${created.stderr}`);
      const verify = await run([
        "pr",
        "view",
        request.sourceBranch,
        "--repo",
        request.repository,
        "--json",
        "number,url,headRefName,baseRefName,state,headRefOid",
      ]);
      if (verify.exitCode !== 0) throw new Error("GitHub did not confirm pull-request creation");
      found = JSON.parse(verify.stdout) as Pr;
    }
    if (found.headRefOid !== request.commit)
      throw new ValidationFailedError("GitHub pull-request head does not match the approved commit");
    return {
      provider: "github",
      number: found.number,
      url: found.url,
      sourceBranch: found.headRefName,
      targetBranch: found.baseRefName,
      state: found.state.toLowerCase(),
      headSha: found.headRefOid,
    };
  }
}
