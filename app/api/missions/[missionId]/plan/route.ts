import { handleMissionLifecycleRequest } from "@/application/mission-http";

export function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  return handleMissionLifecycleRequest(request, params, "planned");
}
