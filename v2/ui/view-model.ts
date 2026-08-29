import type { ReconciledMission } from "../github/reconciliation";
import type { ProjectConfiguration } from "../runtime/config";
import type { ProviderFailure } from "../runtime/bindings";

export type MissionCard = {
  projectId: string;
  projectName: string;
  missionId: string;
  issueNumber: number;
  actor: string;
  state: string;
  status: string;
  color: "BLUE" | "ORANGE" | "RED" | "GRAY" | "BLACK" | "WHITE";
  githubUrl: string;
  repositoryUrl: string;
  lastActivity: string;
  sortRank: number;
  ageMs: number;
  systemFailure?: ProviderFailure;
};

export function missionCard(input: {
  project: ProjectConfiguration;
  issueNumber: number;
  githubUrl: string;
  mission: ReconciledMission;
  lastActivity: string;
  now?: Date;
  systemFailure?: ProviderFailure;
}): MissionCard {
  const { mission } = input;
  const ageMs = (input.now ?? new Date()).getTime() - new Date(input.lastActivity).getTime();
  const stale = ageMs >= 7 * 24 * 60 * 60 * 1000;
  const state = mission.mission.state;
  const color = input.systemFailure
    ? "GRAY"
    : stale
      ? "WHITE"
      : state === "CTO_DECISION"
        ? "RED"
        : mission.mission.currentActor === "ARCHITECT"
          ? "BLUE"
          : mission.mission.currentActor === "ENGINEER"
            ? "ORANGE"
            : state === "BLOCKED_EXTERNAL"
              ? "GRAY"
              : "BLACK";
  const sortRank = input.systemFailure
    ? 3
    : state === "CTO_DECISION"
      ? 1
      : ["ENGINEER_WORKING", "ARCHITECT_REVIEW", "ARCHITECT_PLANNING"].includes(state)
        ? 2
        : state === "BLOCKED_EXTERNAL"
          ? 3
          : stale
            ? 5
            : 4;
  const status = input.systemFailure
    ? input.systemFailure.message
    : state === "CTO_DECISION"
      ? (mission.pendingCtoRequest?.action ?? "CTO decision required")
      : (mission.latestArchitectDecision?.rationale ??
        mission.latestEngineerReport?.summary ??
        mission.mission.objective);
  return {
    projectId: input.project.projectId,
    projectName: input.project.name,
    missionId: mission.mission.missionId,
    issueNumber: input.issueNumber,
    actor: mission.mission.currentActor,
    state,
    status,
    color,
    githubUrl: input.githubUrl,
    repositoryUrl: input.project.repositoryUrl,
    lastActivity: input.lastActivity,
    sortRank,
    ageMs,
    ...(input.systemFailure ? { systemFailure: input.systemFailure } : {}),
  };
}

export function sortMissionCards(cards: MissionCard[]) {
  return [...cards].sort((a, b) => a.sortRank - b.sortRank || Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
}
