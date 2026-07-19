import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/authentication";
import { registerMember, RegistrationValidationError } from "@/lib/registration";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/session";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = (await request.json()) as { email?: string; displayName?: string; password?: string };
    const identity = await registerMember(body);
    const response = NextResponse.json({ user: { email: identity.email, role: identity.role } }, { status: 201 });
    response.cookies.set(SESSION_COOKIE_NAME, await createSessionToken(identity), sessionCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof RegistrationValidationError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof Error && error.message === "Invalid request origin")
      return NextResponse.json({ error: error.message }, { status: 403 });
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
    if (code === "23505" || code === "concurrency_conflict")
      return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
    console.error(JSON.stringify({ level: "error", event: "registration_failed", message: "Registration service unavailable" }));
    return NextResponse.json({ error: "Registration service unavailable" }, { status: 503 });
  }
}
