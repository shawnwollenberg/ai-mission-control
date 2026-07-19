import { NextResponse } from "next/server";
import { getDatabasePool } from "@/lib/database";

export const runtime = "nodejs";

export async function GET() {
  try {
    await getDatabasePool().query("SELECT 1");
    return NextResponse.json({ status: "ok", environment: process.env.APP_ENV ?? "unset", database: "reachable" });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health_check_failed",
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
