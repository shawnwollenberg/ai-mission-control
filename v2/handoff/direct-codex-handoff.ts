import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createGitHubIssueApi, GitHubIssueMissionStore, type GitHubIssueApi } from "../github/github-issue-store";
import { renderMissionBody } from "../github/protocol";
import type { EngineerReport, Mission } from "../routing/contracts";
import { JsonBindingStore, type BindingStore } from "../runtime/bindings";
import { loadV2Configuration, type MissionControlV2Configuration } from "../runtime/config";

const exec = promisify(execFile);
const threadPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DirectCodexHandoffInput = {
  projectId: string;
  codexThreadId: string;
  title: string;
  objective: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  currentStatus: "WORKING" | "BLOCKED_EXTERNAL" | "OWNER_REQUIRED";
  summary: string;
  blockedOn?: string[];
  evidence?: Array<{ kind: string; ref: string; result?: string }>;
};

type Dependencies = {
  configuration: MissionControlV2Configuration;
  issueApi: GitHubIssueApi;
  bindings: BindingStore;
  findThreadCheckout: (threadId: string) => Promise<string>;
  readOrigin: (checkout: string) => Promise<string>;
};

export async function promoteDirectCodexHandoff(input: DirectCodexHandoffInput, overrides?: Partial<Dependencies>) {
  validateInput(input);
  const configuration = overrides?.configuration ?? (await loadV2Configuration());
  const project = configuration.projects.find((value) => value.active && value.projectId === input.projectId);
  if (!project) throw new Error("HANDOFF_PROJECT_NOT_ADMITTED");
  const dataDirectory = process.env.MISSION_CONTROL_V2_DATA_DIR ?? join(process.cwd(), ".mission-control-v2-runtime");
  const bindings = overrides?.bindings ?? new JsonBindingStore(join(dataDirectory, "provider-bindings.json"));
  const issueApi = overrides?.issueApi ?? createGitHubIssueApi(project.githubRepo);
  const threadCheckout = resolve(
    await (overrides?.findThreadCheckout ?? findSpecificThreadCheckout)(input.codexThreadId),
  );
  if (threadCheckout !== resolve(project.localCheckout)) throw new Error("HANDOFF_THREAD_CHECKOUT_MISMATCH");
  const origin = normalizeOrigin(await (overrides?.readOrigin ?? readOrigin)(project.localCheckout));
  if (origin !== `https://github.com/${project.githubRepo}`) throw new Error("HANDOFF_REPOSITORY_MISMATCH");
  if ((await bindings.list()).some((binding) => binding.codexThreadId === input.codexThreadId))
    throw new Error("HANDOFF_THREAD_ALREADY_BOUND");

  const missionId = `mc2-handoff-${input.projectId}-${randomUUID()}`;
  const mission: Mission = {
    schema: "mc.mission/v1",
    missionId,
    revision: 1,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    constraints: input.constraints ?? [],
    state: "ENGINEER_WORKING",
    currentActor: "ENGINEER",
  };
  const metadata = { schema: "mc.codex-handoff/v1", projectId: project.projectId, codexThreadId: input.codexThreadId };
  const report: EngineerReport = {
    schema: "mc.engineer-report/v1",
    missionId,
    revision: 2,
    outcome: input.currentStatus === "WORKING" ? "PARTIAL" : "BLOCKED",
    summary: input.summary,
    evidence: input.evidence ?? [{ kind: "codex-thread", ref: input.codexThreadId }],
    risks: [],
    blockedOn: input.blockedOn ?? [],
    capabilitiesRequested: input.currentStatus === "OWNER_REQUIRED" ? ["OWNER_AUTHENTICATION"] : [],
  };
  for (const [name, color, description] of [
    ["mc:mission", "1f6feb", "Canonical Mission Control mission"],
    ["mc:tracked", "8250df", "Explicitly admitted to Mission Control V2"],
    ["mc:engineer-working", "fb8c00", "Engineer currently owns the mission"],
  ] as const)
    await issueApi.ensureLabel(name, color, description);
  const body = `${renderMissionBody(mission)}\n\n<!-- mission-control:codex-handoff ${JSON.stringify(metadata)} -->`;
  const created = await issueApi.createIssue({
    title: `[Mission][Direct handoff] ${input.title}`,
    body,
    labels: ["mc:mission", "mc:tracked", "mc:engineer-working"],
  });
  await bindings.put({
    missionId,
    projectId: project.projectId,
    issueNumber: created.number,
    codexThreadId: input.codexThreadId,
    lastProcessedRevision: 1,
  });
  const store = new GitHubIssueMissionStore(issueApi, {
    constitution: project.constitution,
    authorizedLogins: configuration.authorizedGitHubLogins,
  });
  const current = await store.appendEngineerReport({ issueNumber: created.number }, report);
  await bindings.update(missionId, (binding) => ({ ...binding!, lastProcessedRevision: current.latestRevision }));
  return { project, issueNumber: created.number, issueUrl: created.url, mission: current.mission, report };
}

function validateInput(input: DirectCodexHandoffInput) {
  if (!input.projectId.trim() || !input.title.trim() || !input.objective.trim() || !input.summary.trim())
    throw new Error("HANDOFF_REQUIRED_FIELD_MISSING");
  if (!threadPattern.test(input.codexThreadId)) throw new Error("HANDOFF_THREAD_ID_INVALID");
}

async function findSpecificThreadCheckout(threadId: string) {
  const root = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "sessions");
  const matches: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && basename(path).includes(threadId)) matches.push(path);
    }
  }
  await visit(root);
  if (matches.length !== 1)
    throw new Error(matches.length ? "HANDOFF_THREAD_ID_AMBIGUOUS" : "HANDOFF_THREAD_NOT_FOUND");
  const firstLine = (await readFile(matches[0], "utf8")).split("\n", 1)[0];
  const record = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
  if (record.type !== "session_meta" || record.payload?.id !== threadId || !record.payload.cwd)
    throw new Error("HANDOFF_THREAD_METADATA_INVALID");
  return record.payload.cwd;
}

async function readOrigin(checkout: string) {
  return (await exec("git", ["remote", "get-url", "origin"], { cwd: checkout })).stdout.trim();
}

function normalizeOrigin(value: string) {
  return value.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
}
