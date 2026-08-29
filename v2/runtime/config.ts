import { readFile } from "node:fs/promises";
import type { ProjectConstitution } from "../routing/contracts";
import { validateProjectConstitution } from "../routing/contracts";

export type ProjectConfiguration = {
  projectId: string;
  name: string;
  githubRepo: string;
  localCheckout: string;
  repositoryUrl: string;
  architectAdapter: "openai-responses";
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
  const ids = new Set<string>();
  for (const project of value.projects) {
    if (!project.projectId || ids.has(project.projectId)) throw new Error("Project ids must be present and unique");
    ids.add(project.projectId);
    if (project.constitution.projectId !== project.projectId || project.constitution.repository !== project.githubRepo)
      throw new Error(`Project ${project.projectId} does not match its constitution`);
    validateProjectConstitution(project.constitution);
  }
  return value;
}
