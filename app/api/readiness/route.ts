import { NextResponse } from "next/server";
import { validateProductionConfiguration } from "@/lib/production-config";
import { runtimeTrustEvidence } from "@/lib/runtime-trust";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const result = await validateProductionConfiguration("web", { requireCurrentSchema: true });
  const trust = runtimeTrustEvidence();
  return NextResponse.json(
    {
      status: result.ready ? "ready" : "not_ready",
      environment: result.environment,
      runtimeTrust: trust,
      label: trust.disposable ? "DISPOSABLE ACCEPTANCE — NON-PRODUCTION" : null,
      failed: result.failed,
      secretsPrinted: false,
    },
    { status: result.ready ? 200 : 503 },
  );
}
