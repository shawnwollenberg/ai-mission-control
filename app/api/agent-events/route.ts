import { NextResponse } from "next/server";
import { agentAuthError, isAuthorizedAgentRequest } from "@/lib/agent-auth";
import { appendAgentEvent } from "@/lib/event-store";
import type { AgentEventInput } from "@/lib/mission-events";

export async function POST(request: Request) {
  if (!isAuthorizedAgentRequest(request)) {
    const error = agentAuthError();
    return NextResponse.json({ error: error.error }, { status: error.status });
  }
  try {
    const event = await appendAgentEvent((await request.json()) as AgentEventInput);
    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid event" }, { status: 400 });
  }
}
