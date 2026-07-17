import { getMissionProjection, createMission } from "@/lib/event-store";

export type Priority = "High" | "Normal" | "Low";
export type Mission = NonNullable<Awaited<ReturnType<typeof getMissionProjection>>>;

export { createMission };

export async function getMission(id: string): Promise<Mission | undefined> {
  return getMissionProjection(id);
}
