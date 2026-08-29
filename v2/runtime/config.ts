import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ProjectConstitution } from "../routing/contracts";
import { validateProjectConstitution } from "../routing/contracts";

export type ProjectConfiguration = {
  projectId: string;
  name: string;
  githubRepo: string;
  localCheckout: string;
  repositoryUrl: string;
  architectAdapter: "codex-sdk" | "workspace-agent" | "openai-responses-disabled";
  engineerAdapter: "codex-sdk";
  active: boolean;
  trackedMissionIssues?: number[];
  constitution: ProjectConstitution;
};

export type MissionControlV2Configuration = {
  schema: "mc.config/v1";
  authorizedGitHubLogins: string[];
  projects: ProjectConfiguration[];
};

export async function loadV2Configuration(
  path = process.env.MISSION_CONTROL_V2_CONFIG,
): Promise<MissionControlV2Configuration> {
  if (!path) throw new Error("MISSION_CONTROL_V2_CONFIG is required");
  const value = JSON.parse(await readFile(path, "utf8")) as MissionControlV2Configuration;
  if (value.schema !== "mc.config/v1" || !Array.isArray(value.projects) || !value.projects.length)
    throw new Error("Unsupported or empty Mission Control V2 configuration");
  if (!value.authorizedGitHubLogins?.length) throw new Error("At least one authorized GitHub login is required");
  if (value.authorizedGitHubLogins.some((login) => !/^[A-Za-z0-9-]{1,39}$/.test(login)))
    throw new Error("Authorized GitHub logins must be exact account names");
  const ids = new Set<string>();
  const trackedIssues = new Set<string>();
  for (const project of value.projects) {
    if (!project.projectId || ids.has(project.projectId)) throw new Error("Project ids must be present and unique");
    ids.add(project.projectId);
    if (project.constitution.projectId !== project.projectId || project.constitution.repository !== project.githubRepo)
      throw new Error(`Project ${project.projectId} does not match its constitution`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.githubRepo))
      throw new Error(`Project ${project.projectId} has an invalid GitHub repository`);
    if (!isAbsolute(project.localCheckout))
      throw new Error(`Project ${project.projectId} requires an absolute checkout`);
    if (project.repositoryUrl !== `https://github.com/${project.githubRepo}`)
      throw new Error(`Project ${project.projectId} repositoryUrl must match githubRepo`);
    if (project.constitution.architect.adapter !== project.architectAdapter)
      throw new Error(`Project ${project.projectId} Architect adapter does not match its constitution`);
    if (project.constitution.engineer.adapter !== project.engineerAdapter)
      throw new Error(`Project ${project.projectId} Engineer adapter does not match its constitution`);
    for (const issueNumber of project.trackedMissionIssues ?? []) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
        throw new Error(`Project ${project.projectId} has an invalid tracked Mission Issue`);
      const key = `${project.githubRepo}#${issueNumber}`;
      if (trackedIssues.has(key)) throw new Error(`Tracked Mission ${key} is configured more than once`);
      trackedIssues.add(key);
    }
    validateProjectConstitution(project.constitution);
  }
  return value;
}
