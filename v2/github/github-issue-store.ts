import { spawn } from "node:child_process";
import type {
  ArchitectDecision,
  CtoDecision,
  CtoRequest,
  EngineerReport,
  Mission,
  RoutingSignal,
} from "../routing/contracts";
import { envelopeKind, renderEnvelope } from "./protocol";
import { missionStateLabel, reconcileGitHubMission, type GitHubMissionIssue } from "./reconciliation";
import type { MissionIssueRef, MissionStore, MissionStoreConfiguration } from "./mission-store";

export interface GitHubIssueApi {
  readIssue(issueNumber: number): Promise<GitHubMissionIssue>;
  addComment(issueNumber: number, body: string): Promise<void>;
  updateIssue(issueNumber: number, input: { labels?: string[]; state?: "open" | "closed" }): Promise<void>;
}

export class GitHubIssueMissionStore implements MissionStore {
  constructor(
    private readonly api: GitHubIssueApi,
    private readonly configuration: MissionStoreConfiguration,
  ) {}

  async readMission(ref: MissionIssueRef) {
    return this.reconcileMission(ref);
  }

  appendEngineerReport(ref: MissionIssueRef, report: EngineerReport) {
    return this.appendSignal(ref, "Engineer report", report);
  }

  appendArchitectDecision(ref: MissionIssueRef, decision: ArchitectDecision) {
    return this.appendSignal(ref, "Architect decision", decision);
  }

  appendCtoRequest(ref: MissionIssueRef, request: CtoRequest) {
    return this.appendSignal(ref, "CTO request", request);
  }

  appendCtoDecision(ref: MissionIssueRef, decision: CtoDecision) {
    return this.appendSignal(ref, "CTO decision", decision);
  }

  async updateMissionState(ref: MissionIssueRef, mission: Mission) {
    await this.api.updateIssue(ref.issueNumber, { labels: ["mc:mission", missionStateLabel(mission)] });
  }

  async closeMission(ref: MissionIssueRef) {
    const before = await this.reconcileWithoutPresentation(ref);
    if (before.mission.state !== "COMPLETE") throw new Error("Only a completed mission may be closed");
    await this.api.updateIssue(ref.issueNumber, { state: "closed" });
    return this.reconcileMission(ref);
  }

  async reconcileMission(ref: MissionIssueRef) {
    return reconcileGitHubMission({
      constitution: this.configuration.constitution,
      issue: await this.api.readIssue(ref.issueNumber),
      authorizedLogins: this.configuration.authorizedLogins,
    });
  }

  private async reconcileWithoutPresentation(ref: MissionIssueRef) {
    return reconcileGitHubMission({
      constitution: this.configuration.constitution,
      issue: await this.api.readIssue(ref.issueNumber),
      authorizedLogins: this.configuration.authorizedLogins,
      enforceLabels: false,
    });
  }

  private async appendSignal(ref: MissionIssueRef, heading: string, signal: RoutingSignal) {
    const body = `## ${heading}\n\n${renderEnvelope(envelopeKind(signal), signal)}`;
    const current = await this.api.readIssue(ref.issueNumber);
    reconcileGitHubMission({
      constitution: this.configuration.constitution,
      issue: {
        ...current,
        comments: [
          ...current.comments,
          {
            id: -1,
            body,
            authorLogin: this.configuration.authorizedLogins[0] ?? null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      },
      authorizedLogins: this.configuration.authorizedLogins,
      enforceLabels: false,
    });
    await this.api.addComment(ref.issueNumber, body);
    const reconciled = await this.reconcileWithoutPresentation(ref);
    await this.updateMissionState(ref, reconciled.mission);
    return this.reconcileMission(ref);
  }
}

export class GhCliIssueApi implements GitHubIssueApi {
  constructor(private readonly repository: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository identity");
  }

  async readIssue(issueNumber: number): Promise<GitHubMissionIssue> {
    const issue = await this.request<Record<string, unknown>>(
      ["repos", this.repository, "issues", String(issueNumber)].join("/"),
    );
    const commentPages = await this.request<Array<Array<Record<string, unknown>>>>(
      ["repos", this.repository, "issues", String(issueNumber), "comments?per_page=100"].join("/"),
      "GET",
      undefined,
      ["--paginate", "--slurp"],
    );
    const comments = commentPages.flat();
    const user = (value: unknown) =>
      value && typeof value === "object" && typeof (value as { login?: unknown }).login === "string"
        ? (value as { login: string }).login
        : null;
    return {
      number: Number(issue.number),
      url: String(issue.html_url),
      title: String(issue.title),
      body: String(issue.body ?? ""),
      state: issue.state === "closed" ? "closed" : "open",
      stateReason: typeof issue.state_reason === "string" ? issue.state_reason : null,
      labels: Array.isArray(issue.labels)
        ? issue.labels.flatMap((label) =>
            label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string"
              ? [(label as { name: string }).name]
              : [],
          )
        : [],
      authorLogin: user(issue.user),
      comments: comments.map((comment) => ({
        id: Number(comment.id),
        body: String(comment.body ?? ""),
        authorLogin: user(comment.user),
        createdAt: String(comment.created_at),
        updatedAt: String(comment.updated_at),
      })),
    };
  }

  async addComment(issueNumber: number, body: string) {
    await this.request(["repos", this.repository, "issues", String(issueNumber), "comments"].join("/"), "POST", {
      body,
    });
  }

  async updateIssue(issueNumber: number, input: { labels?: string[]; state?: "open" | "closed" }) {
    await this.request(["repos", this.repository, "issues", String(issueNumber)].join("/"), "PATCH", input);
  }

  private async request<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
    extraArgs: string[] = [],
  ): Promise<T> {
    const args = ["api", path, "--method", method, ...extraArgs];
    if (body !== undefined) args.push("--input", "-");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("gh", args, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 2_000_000) child.kill("SIGTERM");
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`GitHub Issues request failed with exit ${code}: ${stderr.trim()}`));
      });
      child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return (output.trim() ? JSON.parse(output) : undefined) as T;
  }
}
