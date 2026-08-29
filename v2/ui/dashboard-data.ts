import { loadV2Configuration } from "../runtime/config";
import { createGitHubIssueApi, GitHubIssueMissionStore } from "../github/github-issue-store";
import { missionCard, sortMissionCards } from "./view-model";
import { PostgresWorkerCoordinationStore } from "../worker/store";

export async function loadDashboardCards() {
  const configuration = await loadV2Configuration();
  const worker = await new PostgresWorkerCoordinationStore().presence(30_000);
  const cards = [];
  for (const project of configuration.projects.filter((value) => value.active)) {
    const api = createGitHubIssueApi(project.githubRepo);
    const store = new GitHubIssueMissionStore(api, {
      constitution: project.constitution,
      authorizedLogins: configuration.authorizedGitHubLogins,
    });
    for (const issueNumber of project.trackedMissionIssues ?? []) {
      const issue = await api.readIssue(issueNumber);
      const mission = await store.readMission({ issueNumber });
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
  return sortMissionCards(cards);
}

export async function loadWorkerPresence() {
  return new PostgresWorkerCoordinationStore().presence(30_000);
}
