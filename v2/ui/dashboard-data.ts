import { createGitHubIssueApi, type GitHubIssueApi } from "../github/github-issue-store";
import { reconcileGitHubMission } from "../github/reconciliation";
import { loadV2Configuration, type MissionControlV2Configuration } from "../runtime/config";
import { missionCard, sortMissionCards } from "./view-model";
import { PostgresWorkerCoordinationStore, type WorkerPresence } from "../worker/store";

type DashboardDataDependencies = {
  loadConfiguration: () => Promise<MissionControlV2Configuration>;
  createIssueReader: (repository: string) => Pick<GitHubIssueApi, "readIssue">;
  loadWorkerPresence: () => Promise<WorkerPresence | undefined>;
};

const defaultDependencies: DashboardDataDependencies = {
  loadConfiguration: () => loadV2Configuration(),
  createIssueReader: createGitHubIssueApi,
  loadWorkerPresence: () => new PostgresWorkerCoordinationStore().presence(30_000),
};

export async function loadDashboardData(overrides: Partial<DashboardDataDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const [configuration, worker] = await Promise.all([
    dependencies.loadConfiguration(),
    dependencies.loadWorkerPresence(),
  ]);
  const cards = [];
  for (const project of configuration.projects.filter((value) => value.active)) {
    const issueReader = dependencies.createIssueReader(project.githubRepo);
    for (const issueNumber of project.trackedMissionIssues ?? []) {
      const issue = await issueReader.readIssue(issueNumber);
      const mission = reconcileGitHubMission({
        constitution: project.constitution,
        issue,
        authorizedLogins: configuration.authorizedGitHubLogins,
        enforceLabels: false,
      });
      const lastActivity = issue.comments.at(-1)?.updatedAt ?? issue.updatedAt;
      cards.push(
        missionCard({
          project,
          issueNumber,
          githubUrl: issue.url,
          mission,
          lastActivity,
          workerOffline: !worker || worker.status === "OFFLINE",
        }),
      );
    }
  }
  return { cards: sortMissionCards(cards), worker };
}
