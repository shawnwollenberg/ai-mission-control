import { notFound } from "next/navigation";
import { projectMission } from "@/lib/mission-events";
import { readMissionEvents } from "@/lib/event-store";
import MissionConsole from "./mission-console";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const events = await readMissionEvents(missionId);
  if (!events.length) notFound();
  const mission = projectMission(events);

  return <MissionConsole mission={mission} initialEvents={events} />;
}
