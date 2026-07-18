import { notFound } from "next/navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { getMissionProjection, getMissionTimeline } from "@/lib/mission-queries";
import DurableMissionConsole from "./durable-mission-console";

export const dynamic = "force-dynamic";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const identity = await requirePageIdentity(`/missions/${missionId}`);
  const mission = await getMissionProjection(identity.workspaceId, missionId);
  if (!mission) notFound();
  return (
    <DurableMissionConsole
      initialMission={mission}
      initialTimeline={await getMissionTimeline(identity.workspaceId, missionId)}
    />
  );
}
