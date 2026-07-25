import { NextResponse } from "next/server";
import { approveRepositoryIdentityMigration } from "@/application/repository-identity";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ migrationId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const originError = requireMutationOrigin(request);
    if (originError) return originError;
    if (identity.role !== "owner")
      return NextResponse.json({ error: { message: "Workspace owner permission is required" } }, { status: 403 });
    const { requestFingerprint } = (await request.json()) as { requestFingerprint?: string };
    const result = await approveRepositoryIdentityMigration({
      workspaceId: identity.workspaceId,
      migrationId: (await params).migrationId,
      requestFingerprint: String(requestFingerprint ?? ""),
      actorId: identity.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, "repository_identity_approval_failed");
  }
}
