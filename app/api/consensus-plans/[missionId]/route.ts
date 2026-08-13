import { NextResponse } from "next/server";
import { getConsensusHistory } from "@/application/consensus-plan-commands";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, unauthenticatedResponse } from "@/lib/request-auth";

export async function GET(_: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { missionId } = await params;
    return NextResponse.json(await getConsensusHistory(identity.workspaceId, missionId));
  } catch (error) {
    return apiErrorResponse(error, "consensus_plan_history_failed");
  }
}
