import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/session";

export function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/login", process.env.PUBLIC_APP_URL ?? request.url));
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
