export type PushBranchRequest = {
  worktreePath: string;
  worktreeRoot: string;
  remote: string;
  branch: string;
  commit: string;
};
export type PushBranchResult = {
  remote: string;
  branch: string;
  commit: string;
  remoteRef: string;
  alreadyExisted: boolean;
};
export type CreatePullRequestRequest = {
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  commit: string;
  title: string;
  description: string;
  idempotencyKey: string;
};
export type CreatePullRequestResult = {
  provider: string;
  number: number;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
};
export interface GitProvider {
  pushBranch(request: PushBranchRequest): Promise<PushBranchResult>;
  createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResult>;
}
