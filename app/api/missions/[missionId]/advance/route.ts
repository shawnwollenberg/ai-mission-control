import { NextResponse } from "next/server";
import { appendNextControlledEvent, readMissionEvents } from "@/lib/event-store";

export async function POST(_request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const appended = await appendNextControlledEvent(missionId);
  const events = await readMissionEvents(missionId);
  if (!events.length) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  return NextResponse.json({ appended, events });
}
