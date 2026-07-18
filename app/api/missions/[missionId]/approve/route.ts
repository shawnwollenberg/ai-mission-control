import { NextResponse } from "next/server";
import { approveRecommendation, readMissionEvents } from "@/lib/event-store";

export async function POST(_request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const appended = await approveRecommendation(missionId);
  const events = await readMissionEvents(missionId);
  if (!events.length) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  if (!appended)
    return NextResponse.json({ error: "Recommendation is not ready for approval", events }, { status: 409 });
  return NextResponse.json({ appended, events });
}
