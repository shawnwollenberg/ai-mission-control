import { loadV2Configuration } from "../runtime/config";
import { createGitHubIssueApi, GitHubIssueMissionStore } from "../github/github-issue-store";
import { missionCard, sortMissionCards } from "./view-model";
import { JsonBindingStore } from "../runtime/bindings";
import { join } from "node:path";

export async function loadDashboardCards() {
  const configuration = await loadV2Configuration();
  const dataDirectory = process.env.MISSION_CONTROL_V2_DATA_DIR ?? join(process.cwd(), ".mission-control-v2-runtime");
  const bindings = new JsonBindingStore(join(dataDirectory, "provider-bindings.json"));
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
      const binding = await bindings.get(mission.mission.missionId);
      cards.push(
        missionCard({
          project,
          issueNumber,
          githubUrl: issue.url,
          mission,
          lastActivity,
          systemFailure: binding?.failure,
        }),
      );
    }
  }
  return sortMissionCards(cards);
}
