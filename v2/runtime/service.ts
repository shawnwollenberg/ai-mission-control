import { CodexSdkEngineerAdapter } from "../adapters/codex-sdk-engineer";
import { OpenAIResponsesArchitectAdapter } from "../adapters/openai-architect";
import { GhCliIssueApi, GitHubIssueMissionStore } from "../github/github-issue-store";
import { MissionOrchestrator } from "../orchestration/orchestrator";
import { JsonBindingStore } from "./bindings";
import { loadV2Configuration } from "./config";
import { join } from "node:path";

export async function createV2MissionRuntime(projectId: string) {
  const configuration = await loadV2Configuration();
  const project = configuration.projects.find((value) => value.active && value.projectId === projectId);
  if (!project) throw new Error(`Unknown active V2 project ${projectId}`);
  const api = new GhCliIssueApi(project.githubRepo);
  const store = new GitHubIssueMissionStore(api, {
    constitution: project.constitution,
    authorizedLogins: configuration.authorizedGitHubLogins,
  });
  const dataDirectory = process.env.MISSION_CONTROL_V2_DATA_DIR ?? join(process.cwd(), ".mission-control-v2-runtime");
  const bindings = new JsonBindingStore(join(dataDirectory, "provider-bindings.json"));
  const orchestrator = new MissionOrchestrator(
    project,
    store,
    bindings,
    new CodexSdkEngineerAdapter(),
    new OpenAIResponsesArchitectAdapter(),
  );
  return { configuration, project, api, store, bindings, orchestrator };
}
