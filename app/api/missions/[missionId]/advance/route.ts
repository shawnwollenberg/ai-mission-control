import { NextResponse } from "next/server";
import { appendNextControlledEvent, readMissionEvents } from "@/lib/event-store";
import { runCodexPricingTask } from "@/agents/hermes/run-codex-pricing";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const appended = await appendNextControlledEvent(missionId);
  if (appended?.subject?.id === "task-servicepilot-pricing" && process.env.MISSION_CONTROL_AGENT_TOKEN) {
    const agentBaseUrl = process.env.INTERNAL_AGENT_URL ?? new URL(_request.url).origin;
    void runCodexPricingTask(missionId, agentBaseUrl, process.env.MISSION_CONTROL_AGENT_TOKEN).catch((error) => {
      console.error(JSON.stringify({ level: "error", event: "hermes_fixture_failed", missionId, message: error instanceof Error ? error.message : "unknown" }));
    });
  }
  const events = await readMissionEvents(missionId);
  if (!events.length) return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  return NextResponse.json({ appended, events });
}
