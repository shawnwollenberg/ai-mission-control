import { NextResponse } from "next/server";
import { authenticateOwner, requireSameOrigin } from "@/lib/authentication";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/session";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password)
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    const identity = await authenticateOwner(body.email, body.password);
    if (!identity) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    const response = NextResponse.json({ user: { email: identity.email, role: identity.role } });
    response.cookies.set(SESSION_COOKIE_NAME, await createSessionToken(identity), sessionCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid request origin") {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error(
      JSON.stringify({ level: "error", event: "login_failed", message: "Authentication service unavailable" }),
    );
    return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  }
}
