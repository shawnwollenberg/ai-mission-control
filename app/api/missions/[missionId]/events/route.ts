import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/http-errors";
import { getMissionProjection, getMissionTimeline } from "@/lib/mission-queries";
import { requireApiIdentity, unauthenticatedResponse } from "@/lib/request-auth";

export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  const { missionId } = await params;
  try {
    const projection = await getMissionProjection(identity.workspaceId, missionId);
    if (!projection)
      return NextResponse.json({ error: { code: "not_found", message: "Mission not found" } }, { status: 404 });
    return NextResponse.json({ timeline: await getMissionTimeline(identity.workspaceId, missionId) });
  } catch (error) {
    return apiErrorResponse(error, "mission_timeline_failed");
  }
}
