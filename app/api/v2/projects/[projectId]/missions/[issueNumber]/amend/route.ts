import { NextResponse } from "next/server";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
import { createV2MissionRuntime } from "@/v2/runtime/service";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string; issueNumber: string }> },
) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  if (identity.role !== "owner")
    return NextResponse.json({ error: { code: "forbidden", message: "Owner authority is required" } }, { status: 403 });
  try {
    const { projectId, issueNumber: raw } = await params;
    const issueNumber = Number(raw);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid issue number");
    const body = (await request.json()) as {
      blockedRevision: number;
      reason: string;
      replacementAcceptanceCriteria: string[];
      evidence: Array<{ kind: string; ref: string; result?: string }>;
    };
    if (!Number.isSafeInteger(body.blockedRevision) || body.blockedRevision < 1)
      throw new Error("A positive blocked revision is required");
    if (!body.reason?.trim() || !Array.isArray(body.evidence) || !body.evidence.length)
      throw new Error("An amendment reason and evidence are required");
    if (
      !Array.isArray(body.replacementAcceptanceCriteria) ||
      !body.replacementAcceptanceCriteria.length ||
      body.replacementAcceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())
    )
      throw new Error("At least one non-empty replacement acceptance criterion is required");
    const runtime = await createV2MissionRuntime(projectId);
    const result = await runtime.orchestrator.amendBlockedMission(issueNumber, body);
    return NextResponse.json({
      missionId: result.mission.missionId,
      state: result.mission.state,
      revision: result.latestRevision,
      routing: "queued_for_architect",
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "owner_mission_amendment_failed", message: (error as Error).message } },
      { status: 409 },
    );
  }
}
