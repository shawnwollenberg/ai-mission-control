import type { ArchitectDecision, CtoRequest, EngineerReport, RoutingSignal } from "../routing/contracts";
import { createGitHubIssueApi, GitHubIssueMissionStore } from "../github/github-issue-store";
import { loadV2Configuration, type ProjectConfiguration } from "../runtime/config";
import type { WorkerCoordinationStore } from "./store";
import type { WorkerDispatch, WorkerResult } from "./protocol";
import { validateWorkerResult } from "./protocol";

export class WorkerControlPlane {
  constructor(private readonly coordination: WorkerCoordinationStore) {}

  async synchronizeEligibleDispatches() {
    const configuration = await loadV2Configuration();
    for (const project of configuration.projects.filter((item) => item.active)) {
      const api = createGitHubIssueApi(project.githubRepo);
      const store = new GitHubIssueMissionStore(api, {
        constitution: project.constitution,
        authorizedLogins: configuration.authorizedGitHubLogins,
      });
      const issueNumbers = Array.from(
        new Set([...(project.trackedMissionIssues ?? []), ...(await api.listTrackedIssueNumbers())]),
      );
      for (const issueNumber of issueNumbers) {
        const current = await store.readMission({ issueNumber });
        const actor = current.mission.currentActor;
        if (!(["ARCHITECT", "ENGINEER"] as const).includes(actor as "ARCHITECT" | "ENGINEER")) continue;
        const dispatch = await this.coordination.enqueue({
          projectId: project.projectId,
          missionId: current.mission.missionId,
          issueNumber,
          missionRevision: current.mission.revision,
          actor: actor as "ARCHITECT" | "ENGINEER",
          adapter: actor === "ARCHITECT" ? project.architectAdapter : project.engineerAdapter,
          idempotencyKey: `${current.mission.missionId}:${current.mission.revision}:${actor.toLowerCase()}`,
          missionDigest: current.sourceMissionDigest,
          packet: {
            mission: current.mission,
            constitution: project.constitution,
            ...(current.latestEngineerReport ? { latestEngineerReport: current.latestEngineerReport } : {}),
            ...(latestSignal(current) ? { priorSignal: latestSignal(current) } : {}),
          },
        });
        await this.coordination.recoverFailed(dispatch.dispatchId);
      }
    }
  }

  async commitResult(dispatch: WorkerDispatch, workerResult: WorkerResult) {
    validateWorkerResult(workerResult, dispatch);
    const configuration = await loadV2Configuration();
    const project = configuration.projects.find((item) => item.active && item.projectId === dispatch.projectId);
    if (!project) throw new Error("Dispatch project is no longer active");
    const store = missionStore(project, configuration.authorizedGitHubLogins);
    let current = await store.readMission({ issueNumber: dispatch.issueNumber });
    if (current.sourceMissionDigest !== dispatch.missionDigest || current.mission.revision !== dispatch.missionRevision)
      throw new Error("STALE_WORKER_RESULT");
    current =
      workerResult.result.schema === "mc.engineer-report/v1"
        ? await store.appendEngineerReport({ issueNumber: dispatch.issueNumber }, workerResult.result)
        : await store.appendArchitectDecision({ issueNumber: dispatch.issueNumber }, workerResult.result);
    if (workerResult.result.schema === "mc.architect-decision/v1" && workerResult.result.decision === "CTO_REQUIRED")
      current = await appendCtoRequest(project, store, dispatch.issueNumber, current, workerResult.result);
    if (current.mission.state === "COMPLETE" && !current.complete)
      current = await store.closeMission({ issueNumber: dispatch.issueNumber });
    await this.coordination.markCommitted(dispatch.dispatchId, current.latestRevision);
    return current;
  }
}

function missionStore(project: ProjectConfiguration, authorizedLogins: string[]) {
  return new GitHubIssueMissionStore(createGitHubIssueApi(project.githubRepo), {
    constitution: project.constitution,
    authorizedLogins,
  });
}

function latestSignal(current: Awaited<ReturnType<GitHubIssueMissionStore["readMission"]>>): RoutingSignal | undefined {
  return (
    current.latestCtoDecision ??
    current.latestOwnerReconciliation ??
    current.pendingCtoRequest ??
    current.latestArchitectDecision ??
    current.latestEngineerReport
  );
}

async function appendCtoRequest(
  project: ProjectConfiguration,
  store: GitHubIssueMissionStore,
  issueNumber: number,
  current: Awaited<ReturnType<GitHubIssueMissionStore["readMission"]>>,
  decision: ArchitectDecision,
) {
  const report = current.latestEngineerReport as EngineerReport | undefined;
  const capability = report?.capabilitiesRequested.find((item) =>
    project.constitution.authority.ctoRequired.includes(item),
  );
  if (!report || !capability)
    throw new Error("Architect requested CTO authority without an exact CTO-owned capability");
  const request: CtoRequest = {
    schema: "mc.cto-request/v1",
    missionId: current.mission.missionId,
    revision: current.latestRevision + 1,
    capability,
    action: decision.rationale,
    financialEffect: capability === "MOVE_MONEY" ? "Simulated only; no transaction authorized" : "None",
    externalEffect: "Requires exact owner authorization",
    reversible: false,
    architectRecommendation: "APPROVE",
    evidence: [
      { kind: "architect-decision", revision: decision.revision },
      { kind: "engineer-report", revision: report.revision },
    ],
    status: "PENDING",
  };
  return store.appendCtoRequest({ issueNumber }, request);
}
