import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ApplicationError } from "@/lib/application-errors";

const statuses = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  concurrency_conflict: 409,
  invalid_transition: 409,
  duplicate_command: 409,
  dependency_conflict: 409,
  database_unavailable: 503,
} as const;

export function apiErrorResponse(error: unknown, context: string) {
  const correlationId = randomUUID();
  if (error instanceof ApplicationError) {
    console.warn(
      JSON.stringify({ level: "warn", event: context, correlationId, code: error.code, details: error.details }),
    );
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          correlationId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: statuses[error.code] },
    );
  }
  console.error(
    JSON.stringify({ level: "error", event: context, correlationId, message: "Unhandled application error" }),
  );
  return NextResponse.json(
    { error: { code: "internal_error", message: "Mission Control could not complete the request", correlationId } },
    { status: 500 },
  );
}
