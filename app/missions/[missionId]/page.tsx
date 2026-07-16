import { notFound } from "next/navigation";
import { getMission } from "@/lib/mission-store";
import MissionConsole from "./mission-console";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const mission = getMission(missionId);
  if (!mission) notFound();

  return <MissionConsole mission={mission} />;
}
