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
      decision: "APPROVED" | "REJECTED" | "DISCUSS";
      requestRevision: number;
      comment?: string;
    };
    if (!["APPROVED", "REJECTED", "DISCUSS"].includes(body.decision)) throw new Error("Invalid CTO decision");
    const runtime = await createV2MissionRuntime(projectId);
    const result = await runtime.orchestrator.decide(issueNumber, body);
    return NextResponse.json({
      missionId: result.mission.missionId,
      state: result.mission.state,
      revision: result.latestRevision,
      routing: "queued_for_v2_worker",
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "cto_decision_failed", message: (error as Error).message } },
      { status: 409 },
    );
  }
}
