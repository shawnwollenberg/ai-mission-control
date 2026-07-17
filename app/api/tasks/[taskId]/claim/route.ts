import { NextResponse } from "next/server";
import { agentAuthError, isAuthorizedAgentRequest } from "@/lib/agent-auth";
import { claimAssignment, readMissionEvents } from "@/lib/event-store";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  if (!isAuthorizedAgentRequest(request)) {
    const error = agentAuthError();
    return NextResponse.json({ error: error.error }, { status: error.status });
  }
  const { taskId } = await params;
  const body = (await request.json()) as { missionId?: string; agentId?: string };
  if (!body.missionId || body.agentId !== "hermes") return NextResponse.json({ error: "missionId and Hermes agentId are required" }, { status: 400 });
  const event = await claimAssignment(body.missionId, taskId, body.agentId);
  if (!event) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  return NextResponse.json({ event, events: await readMissionEvents(body.missionId) });
}
