import { createGitHubIssueApi, type GitHubIssueApi } from "../github/github-issue-store";
import { reconcileGitHubMission } from "../github/reconciliation";
import { loadV2Configuration, type MissionControlV2Configuration } from "../runtime/config";
import type { ProviderFailure, ProviderFailureCode } from "../runtime/bindings";
import { missionCard, sortMissionCards } from "./view-model";
import { PostgresWorkerCoordinationStore, type WorkerPresence } from "../worker/store";

type DashboardDataDependencies = {
  loadConfiguration: () => Promise<MissionControlV2Configuration>;
  createIssueReader: (repository: string) => Pick<GitHubIssueApi, "readIssue" | "listTrackedIssueNumbers">;
  loadWorkerPresence: () => Promise<WorkerPresence | undefined>;
  loadDispatches: () => Promise<Awaited<ReturnType<PostgresWorkerCoordinationStore["list"]>>>;
};

const defaultDependencies: DashboardDataDependencies = {
  loadConfiguration: () => loadV2Configuration(),
  createIssueReader: createGitHubIssueApi,
  loadWorkerPresence: () => new PostgresWorkerCoordinationStore().presence(75_000),
  loadDispatches: () => new PostgresWorkerCoordinationStore().list(),
};

export async function loadDashboardData(overrides: Partial<DashboardDataDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const [configuration, worker, dispatches] = await Promise.all([
    dependencies.loadConfiguration(),
    dependencies.loadWorkerPresence(),
    dependencies.loadDispatches(),
  ]);
  const cards = [];
  for (const project of configuration.projects.filter((value) => value.active)) {
    const issueReader = dependencies.createIssueReader(project.githubRepo);
    const discovered = issueReader.listTrackedIssueNumbers ? await issueReader.listTrackedIssueNumbers() : [];
    const issueNumbers = Array.from(new Set([...(project.trackedMissionIssues ?? []), ...discovered]));
    for (const issueNumber of issueNumbers) {
      const issue = await issueReader.readIssue(issueNumber);
      const mission = reconcileGitHubMission({
        constitution: project.constitution,
        issue,
        authorizedLogins: configuration.authorizedGitHubLogins,
        enforceLabels: false,
      });
      const lastActivity = issue.comments.at(-1)?.updatedAt ?? issue.updatedAt;
      const latestDispatch = dispatches
        .filter(
          (item) =>
            item.dispatch.projectId === project.projectId &&
            item.dispatch.issueNumber === issueNumber &&
            item.dispatch.missionId === mission.mission.missionId &&
            item.dispatch.missionRevision === mission.mission.revision &&
            item.dispatch.actor === mission.mission.currentActor,
        )
        .at(-1);
      const systemFailure = latestDispatch?.status === "FAILED" ? dispatchFailure(latestDispatch) : undefined;
      cards.push(
        missionCard({
          project,
          issueNumber,
          githubUrl: issue.url,
          mission,
          lastActivity,
          workerOffline: !worker || worker.status === "OFFLINE",
          systemFailure,
          dispatchStatus: latestDispatch?.status,
        }),
      );
    }
  }
  return { cards: sortMissionCards(cards), worker };
}

function dispatchFailure(item: Awaited<ReturnType<PostgresWorkerCoordinationStore["list"]>>[number]): ProviderFailure {
  const supported = new Set<ProviderFailureCode>([
    "CODEX_AUTHENTICATION_EXPIRED",
    "CODEX_USAGE_LIMIT_REACHED",
    "PROVIDER_THREAD_UNAVAILABLE",
    "PROVIDER_OUTPUT_INVALID",
    "PROVIDER_PROCESS_FAILED",
    "PROVIDER_RECOVERY_EXHAUSTED",
    "PROVIDER_DISPATCH_INDETERMINATE",
    "MISSION_SOURCE_CHANGED",
    "GITHUB_UNAVAILABLE",
  ]);
  const code = supported.has(item.failureCode as ProviderFailureCode)
    ? (item.failureCode as ProviderFailureCode)
    : "PROVIDER_PROCESS_FAILED";
  return {
    code,
    message:
      code === "PROVIDER_THREAD_UNAVAILABLE"
        ? "Provider thread unavailable — recovery required"
        : code === "PROVIDER_RECOVERY_EXHAUSTED"
          ? "Provider thread recovery failed — operator reconciliation required"
          : "Provider dispatch failed — recovery required",
    actor: item.dispatch.actor,
    revision: item.dispatch.missionRevision,
    occurredAt: "",
  };
}
