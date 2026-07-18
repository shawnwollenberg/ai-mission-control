import { NextResponse } from "next/server";
import { requireApiIdentity, unauthenticatedResponse } from "@/lib/request-auth";
import { getMissionProjection } from "@/lib/mission-queries";
import { getMissionExecution } from "@/lib/execution-queries";
export async function GET(_: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  const { missionId } = await params;
  const mission = await getMissionProjection(identity.workspaceId, missionId);
  if (!mission) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  return NextResponse.json({ mission, ...(await getMissionExecution(identity.workspaceId, missionId)) });
}
