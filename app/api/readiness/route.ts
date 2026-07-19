import { NextResponse } from "next/server";
import { validateProductionConfiguration } from "@/lib/production-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const result = await validateProductionConfiguration("web", { requireCurrentSchema: true });
  return NextResponse.json(
    {
      status: result.ready ? "ready" : "not_ready",
      environment: result.environment,
      failed: result.failed,
      secretsPrinted: false,
    },
    { status: result.ready ? 200 : 503 },
  );
}
