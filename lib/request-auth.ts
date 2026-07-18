import { NextResponse } from "next/server";
import { getSessionIdentity, requireSameOrigin } from "@/lib/authentication";

export async function requireApiIdentity() {
  return getSessionIdentity();
}

export function unauthenticatedResponse() {
  return NextResponse.json(
    { error: { code: "unauthenticated", message: "Authentication is required" } },
    { status: 401 },
  );
}

export function requireMutationOrigin(request: Request) {
  try {
    requireSameOrigin(request);
    return undefined;
  } catch {
    return NextResponse.json({ error: { code: "forbidden", message: "Invalid request origin" } }, { status: 403 });
  }
}

export function readIdempotencyKey(request: Request): string | undefined {
  const key = request.headers.get("idempotency-key")?.trim();
  return key && /^[0-9a-f-]{36}$/i.test(key) ? key : undefined;
}
