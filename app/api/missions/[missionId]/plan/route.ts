import { createObjectivePlan } from "@/application/objective-plan";
import { handleMissionLifecycleRequest } from "@/application/mission-http";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  const { missionId } = await params;
  await createObjectivePlan(identity.workspaceId, identity.userId, missionId);
  return handleMissionLifecycleRequest(request, params, "planned");
}
