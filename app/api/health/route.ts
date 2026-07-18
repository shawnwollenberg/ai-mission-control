import { NextResponse } from "next/server";
import { checkDynamoEventStore } from "@/lib/dynamodb-event-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (process.env.EVENT_STORE === "dynamodb") await checkDynamoEventStore();
    return NextResponse.json({ status: "ok", eventStore: process.env.EVENT_STORE ?? "jsonl" });
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
