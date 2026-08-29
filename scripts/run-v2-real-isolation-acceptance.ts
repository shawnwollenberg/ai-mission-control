import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodexSdkArchitectAdapter } from "../v2/adapters/codex-sdk-architect";
import { CodexSdkEngineerAdapter } from "../v2/adapters/codex-sdk-engineer";
import { GhCliIssueApi, GitHubIssueMissionStore } from "../v2/github/github-issue-store";
import { renderMissionBody } from "../v2/github/protocol";
import { MissionOrchestrator } from "../v2/orchestration/orchestrator";
import type { Mission, ProjectConstitution } from "../v2/routing/contracts";
import { JsonBindingStore } from "../v2/runtime/bindings";
import type { ProjectConfiguration } from "../v2/runtime/config";

const repository = "shawnwollenberg/agent_payment_risk_check";
const checkout = "/Users/shawnwollenberg/Developer/agent_payment_risk_check";

async function gh<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const args = ["api", path, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`gh exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return JSON.parse(output) as T;
}

async function createRuntime(index: number, bindings: JsonBindingStore) {
  const projectId = `aprc-isolation-${index}`;
  const constitution: ProjectConstitution = {
    schema: "mc.project-constitution/v1",
    projectId,
    repository,
    defaultBranch: "main",
    architect: { adapter: "codex-sdk", channel: "CHATGPT" },
    engineer: { adapter: "codex-sdk" },
    authority: {
      engineer: ["TEST_EXECUTE", "ROUTINE_DEBUGGING"],
      architect: ["MISSION_APPROVE", "MISSION_REMEDIATE", "ARCHITECTURE_DECISION"],
      ctoRequired: ["SIGN_WALLET_MESSAGE"],
    },
  };
  const mission: Mission = {
    schema: "mc.mission/v1",
    missionId: `mc2-isolation-${index}-${randomUUID()}`,
    revision: 1,
    objective: `Isolation lane ${index}: run .venv/bin/python -m pytest -q tests/test_deployments.py, confirm the Git worktree is clean, and report exact evidence without modifying files.`,
    acceptanceCriteria: ["The bounded test passes", "The worktree is clean", "No external effect occurs"],
    constraints: ["No file changes", "No network", "No signing, wallet, deployment, commit, or push"],
    state: "ENGINEER_WORKING",
    currentActor: "ENGINEER",
  };
  const issue = await gh<{ number: number; html_url: string }>(`repos/${repository}/issues`, "POST", {
    title: `[Mission][Isolation ${index}] Concurrent provider acceptance`,
    body: renderMissionBody(mission),
    labels: ["mc:mission", "mc:engineer-working"],
  });
  const project: ProjectConfiguration = {
    projectId,
    name: `APRC Isolation ${index}`,
    githubRepo: repository,
    localCheckout: checkout,
    repositoryUrl: `https://github.com/${repository}`,
    architectAdapter: "codex-sdk",
    engineerAdapter: "codex-sdk",
    active: true,
    constitution,
  };
  const api = new GhCliIssueApi(repository);
  const store = new GitHubIssueMissionStore(api, { constitution, authorizedLogins: ["shawnwollenberg"] });
  return {
    issue,
    mission,
    bindings,
    orchestrator: new MissionOrchestrator(
      project,
      store,
      bindings,
      new CodexSdkEngineerAdapter(),
      new CodexSdkArchitectAdapter(),
    ),
  };
}

async function main() {
  const runId = randomUUID();
  const directory = join(process.cwd(), ".mission-control-v2-runtime", `isolation-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bindings = new JsonBindingStore(join(directory, "provider-bindings.json"));
  const lanes = await Promise.all([1, 2].map((index) => createRuntime(index, bindings)));
  await Promise.all(lanes.map((lane) => lane.orchestrator.advance(lane.issue.number)));
  let states = await Promise.all(lanes.map((lane) => lane.orchestrator.advance(lane.issue.number)));
  for (let round = 0; round < 2 && states.some((state) => !state.complete); round++) {
    await Promise.all(
      lanes.map((lane, index) =>
        states[index].mission.state === "ENGINEER_WORKING"
          ? lane.orchestrator.advance(lane.issue.number)
          : Promise.resolve(states[index]),
      ),
    );
    states = await Promise.all(
      lanes.map((lane, index) =>
        states[index].complete ? Promise.resolve(states[index]) : lane.orchestrator.advance(lane.issue.number),
      ),
    );
  }
  for (let index = 0; index < states.length; index++) {
    if (!states[index].complete)
      throw new Error(`Isolation lane ${index + 1} did not complete after bounded remediation`);
  }
  const records = await bindings.list();
  if (records.length !== 2) throw new Error("Expected two isolated provider bindings");
  const threadIds = new Set(records.flatMap((record) => [record.codexThreadId, record.architectThreadId]));
  if (threadIds.size !== 4 || threadIds.has(undefined)) throw new Error("Provider threads crossed isolation lanes");
  console.log(
    JSON.stringify({
      event: "isolation-complete",
      issues: lanes.map((lane) => lane.issue.html_url),
      bindings: records.map((record) => ({
        missionId: record.missionId,
        projectId: record.projectId,
        issueNumber: record.issueNumber,
        engineerThreadId: record.codexThreadId,
        architectThreadId: record.architectThreadId,
      })),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
