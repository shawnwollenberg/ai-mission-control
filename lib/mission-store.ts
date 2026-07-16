import { randomUUID } from "crypto";

export type Priority = "High" | "Normal" | "Low";

export type Mission = {
  id: string;
  objective: string;
  deadline: string;
  priority: Priority;
  status: "planning";
  commander: "Hermes";
  createdAt: string;
};

type MissionStore = Map<string, Mission>;

const globalStore = globalThis as typeof globalThis & { __missionStore?: MissionStore };
const missions = globalStore.__missionStore ?? new Map<string, Mission>();
globalStore.__missionStore = missions;

export function createMission(input: Pick<Mission, "objective" | "deadline" | "priority">): Mission {
  const mission: Mission = {
    id: randomUUID(),
    objective: input.objective.trim(),
    deadline: input.deadline.trim() || "Today",
    priority: input.priority,
    status: "planning",
    commander: "Hermes",
    createdAt: new Date().toISOString(),
  };
  missions.set(mission.id, mission);
  return mission;
}

export function getMission(id: string): Mission | undefined {
  return missions.get(id);
}
