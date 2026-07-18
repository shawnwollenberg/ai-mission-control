import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/authentication";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/session";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
