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
import { missionCard } from "../v2/ui/view-model";

const repository = "shawnwollenberg/agent_payment_risk_check";
const localCheckout = "/Users/shawnwollenberg/Developer/agent_payment_risk_check";
const authorizedLogin = "shawnwollenberg";
const model = process.env.MC_V2_ACCEPTANCE_MODEL;

async function gh<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const args = ["api", path, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("gh", args, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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

async function ensureLabels() {
  const labels = ["mc:mission", "mc:engineer-working", "mc:architect-review", "mc:cto-decision", "mc:complete"];
  const existing = await gh<Array<{ name: string }>>(`repos/${repository}/labels?per_page=100`);
  const names = new Set(existing.map(({ name }) => name));
  for (const name of labels) {
    if (!names.has(name))
      await gh(`repos/${repository}/labels`, "POST", {
        name,
        color: name === "mc:cto-decision" ? "d73a4a" : "1d76db",
        description: "Mission Control 2.0 acceptance state",
      });
  }
}

function expectState(
  actual: Awaited<ReturnType<MissionOrchestrator["advance"]>>,
  revision: number,
  state: Mission["state"],
) {
  if (actual.latestRevision !== revision || actual.mission.state !== state)
    throw new Error(
      `Acceptance diverged: expected revision ${revision} ${state}, got revision ${actual.latestRevision} ${actual.mission.state}`,
    );
}

const constitution: ProjectConstitution = {
  schema: "mc.project-constitution/v1",
  projectId: "agent-payment-risk-check",
  repository,
  defaultBranch: "main",
  architect: { adapter: "codex-sdk", channel: "CHATGPT" },
  engineer: { adapter: "codex-sdk" },
  authority: {
    engineer: ["CODE_WRITE", "TEST_EXECUTE", "ROUTINE_DEBUGGING"],
    architect: ["MISSION_APPROVE", "MISSION_REMEDIATE", "ARCHITECTURE_DECISION"],
    ctoRequired: ["SIGN_WALLET_MESSAGE", "MOVE_MONEY"],
  },
};

const project: ProjectConfiguration = {
  projectId: constitution.projectId,
  name: "Agent Payment Risk Check",
  githubRepo: repository,
  localCheckout,
  repositoryUrl: `https://github.com/${repository}`,
  architectAdapter: "codex-sdk",
  engineerAdapter: "codex-sdk",
  active: true,
  constitution,
};

async function main() {
  await ensureLabels();
  const missionId = `mc2-real-${randomUUID()}`;
  const mission: Mission = {
    schema: "mc.mission/v1",
    missionId,
    revision: 1,
    objective:
      "Execute the staged Mission Control 2.0 real-provider acceptance without changing repository files. At revision 1, inspect the repository and identify the bounded existing command `.venv/bin/python -m pytest -q tests/test_deployments.py`, but do not run it; report PARTIAL with no capability request. After Architect REMEDIATE, run that exact test command, require it to pass, report its evidence, and request SIGN_WALLET_MESSAGE solely to exercise the simulated CTO boundary without signing anything. After exact CTO approval, rerun the same test and require it to pass, confirm a clean Git worktree and no signature or external effect, then report COMPLETED with no capability request.",
    acceptanceCriteria: [
      "Architect returns REMEDIATE after the initial inspection-only Engineer report.",
      "The same Engineer Codex thread resumes, passes `.venv/bin/python -m pytest -q tests/test_deployments.py`, and requests SIGN_WALLET_MESSAGE without exercising it.",
      "Architect returns CTO_REQUIRED only after that remediation evidence and exact capability request.",
      "No Engineer work occurs while the CTO request is pending.",
      "After the exact simulated CTO approval, the same Engineer thread verifies the test passes, the worktree is clean, and no external effects occurred.",
      "Architect APPROVES and GitHub closes the Mission at revision 9.",
    ],
    constraints: [
      "Required sequence: REMEDIATE -> CTO_REQUIRED -> simulated CTO APPROVED -> APPROVE.",
      "Do not modify, commit, or push repository files.",
      "Do not sign any message, access a wallet, move money, use network tools, deploy, or create external effects.",
      "The SIGN_WALLET_MESSAGE request is an inert test of routing authority only.",
      "A missing runner, nonzero test exit, or unexecuted assertion is incomplete evidence and must not be reported as acceptance success.",
    ],
    state: "ENGINEER_WORKING",
    currentActor: "ENGINEER",
  };
  const created = await gh<{ number: number; html_url: string }>(`repos/${repository}/issues`, "POST", {
    title: `[Mission][Acceptance] Real-provider loop ${missionId.slice(-8)}`,
    body: renderMissionBody(mission),
    labels: ["mc:mission", "mc:engineer-working"],
  });
  const runtimeDirectory = join(process.cwd(), ".mission-control-v2-runtime", missionId);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const api = new GhCliIssueApi(repository);
  const store = new GitHubIssueMissionStore(api, { constitution, authorizedLogins: [authorizedLogin] });
  const bindings = new JsonBindingStore(join(runtimeDirectory, "provider-bindings.json"));
  const orchestrator = new MissionOrchestrator(
    project,
    store,
    bindings,
    new CodexSdkEngineerAdapter(undefined, model),
    new CodexSdkArchitectAdapter(undefined, model),
  );

  console.log(JSON.stringify({ event: "created", issue: created.html_url, missionId }));
  expectState(await orchestrator.advance(created.number), 2, "ARCHITECT_REVIEW");
  const remediated = await orchestrator.advance(created.number);
  expectState(remediated, 3, "ENGINEER_WORKING");
  if (remediated.latestArchitectDecision?.decision !== "REMEDIATE") throw new Error("Architect skipped REMEDIATE");
  expectState(await orchestrator.advance(created.number), 4, "ARCHITECT_REVIEW");
  const waiting = await orchestrator.advance(created.number);
  expectState(waiting, 6, "CTO_DECISION");
  if (waiting.latestArchitectDecision?.decision !== "CTO_REQUIRED") throw new Error("Architect skipped CTO_REQUIRED");
  if (waiting.pendingCtoRequest?.capability !== "SIGN_WALLET_MESSAGE")
    throw new Error("CTO request was not bound to SIGN_WALLET_MESSAGE");
  const paused = await orchestrator.advance(created.number);
  expectState(paused, 6, "CTO_DECISION");
  await orchestrator.decide(created.number, {
    decision: "APPROVED",
    requestRevision: 6,
    comment: "Simulated acceptance boundary only. No signature, wallet access, or external effect is authorized.",
  });
  expectState(await orchestrator.advance(created.number), 8, "ARCHITECT_REVIEW");
  const complete = await orchestrator.advance(created.number);
  expectState(complete, 9, "COMPLETE");
  if (!complete.complete) throw new Error("Completed Mission Issue was not closed");

  const binding = await bindings.get(missionId);
  if (!binding?.codexThreadId || !binding.architectThreadId)
    throw new Error("Both provider thread bindings are required");
  if (binding.codexThreadId === binding.architectThreadId) throw new Error("Architect and Engineer shared a thread");
  const rebuilt = await new GitHubIssueMissionStore(new GhCliIssueApi(repository), {
    constitution,
    authorizedLogins: [authorizedLogin],
  }).reconcileMission({ issueNumber: created.number });
  if (rebuilt.historyDigest !== complete.historyDigest) throw new Error("Fresh GitHub reconstruction digest differs");
  const issue = await api.readIssue(created.number);
  const card = missionCard({
    project,
    issueNumber: created.number,
    githubUrl: created.html_url,
    mission: rebuilt,
    lastActivity: issue.comments.at(-1)?.updatedAt ?? new Date().toISOString(),
  });
  if (card.color !== "BLACK" || card.actor !== "NONE") throw new Error("Dashboard final state is incorrect");
  console.log(
    JSON.stringify({
      event: "complete",
      issue: created.html_url,
      issueNumber: created.number,
      missionId,
      revision: rebuilt.latestRevision,
      historyDigest: rebuilt.historyDigest,
      engineerThreadId: binding.codexThreadId,
      architectThreadId: binding.architectThreadId,
      dashboard: { state: card.state, actor: card.actor, color: card.color },
      responsesEnabled: false,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
