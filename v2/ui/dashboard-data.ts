import { loadV2Configuration } from "../runtime/config";
import { GhCliIssueApi, GitHubIssueMissionStore } from "../github/github-issue-store";
import { missionCard, sortMissionCards } from "./view-model";

export async function loadDashboardCards() {
  const configuration = await loadV2Configuration();
  const cards = [];
  for (const project of configuration.projects.filter((value) => value.active)) {
    const api = new GhCliIssueApi(project.githubRepo);
    const store = new GitHubIssueMissionStore(api, {
      constitution: project.constitution,
      authorizedLogins: configuration.authorizedGitHubLogins,
    });
    for (const issueNumber of project.trackedMissionIssues ?? []) {
      const issue = await api.readIssue(issueNumber);
      const mission = await store.readMission({ issueNumber });
      const lastActivity = issue.comments.at(-1)?.updatedAt ?? new Date(0).toISOString();
      cards.push(missionCard({ project, issueNumber, githubUrl: issue.url, mission, lastActivity }));
    }
  }
  return sortMissionCards(cards);
}
