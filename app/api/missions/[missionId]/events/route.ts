import { NextResponse } from "next/server";
import { readMissionEvents } from "@/lib/event-store";

export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const events = await readMissionEvents(missionId);
  if (!events.length) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  return NextResponse.json({ events });
}
