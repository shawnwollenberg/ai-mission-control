import { createServicePilotPlan } from "@/application/demo-plan";
import { handleMissionLifecycleRequest } from "@/application/mission-http";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  const { missionId } = await params;
  await createServicePilotPlan(identity.workspaceId, identity.userId, missionId);
  return handleMissionLifecycleRequest(request, params, "planned");
}
