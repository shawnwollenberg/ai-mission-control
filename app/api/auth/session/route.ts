import { NextResponse } from "next/server";
import { getSessionIdentity } from "@/lib/authentication";

export async function GET() {
  const identity = await getSessionIdentity();
  if (!identity) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({
    authenticated: true,
    user: { id: identity.userId, email: identity.email, role: identity.role },
    workspace: { id: identity.workspaceId },
  });
}
