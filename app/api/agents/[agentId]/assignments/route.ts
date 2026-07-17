import { NextResponse } from "next/server";
import { agentAuthError, isAuthorizedAgentRequest } from "@/lib/agent-auth";
import { getAssignments, readMissionEvents } from "@/lib/event-store";

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  if (!isAuthorizedAgentRequest(request)) {
    const error = agentAuthError();
    return NextResponse.json({ error: error.error }, { status: error.status });
  }
  const { agentId } = await params;
  if (agentId !== "hermes") return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  const missionId = new URL(request.url).searchParams.get("missionId");
  if (!missionId) return NextResponse.json({ error: "missionId is required" }, { status: 400 });
  const events = await readMissionEvents(missionId);
  if (!events.length) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  return NextResponse.json({ assignments: getAssignments(events, agentId) });
}
