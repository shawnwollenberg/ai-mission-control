import { NextResponse } from "next/server";
import { getDatabasePool } from "@/lib/database";
import { getProjectBrainConfiguration } from "@/integrations/project-brain/config";
import { runtimeTrustEvidence } from "@/lib/runtime-trust";

export const runtime = "nodejs";

export async function GET() {
  const trust = runtimeTrustEvidence();
  try {
    await getDatabasePool().query("SELECT 1");
    let projectBrain: ReturnType<typeof getProjectBrainConfiguration>;
    try {
      projectBrain = getProjectBrainConfiguration();
    } catch {
      projectBrain = { enabled: false, status: "invalid_configuration" };
    }
    return NextResponse.json({
      status: "ok",
      environment: trust.runtimeMode,
      runtimeTrust: trust,
      label: trust.disposable ? "DISPOSABLE ACCEPTANCE — NON-PRODUCTION" : null,
      database: "reachable",
      projectBrain: projectBrain.enabled
        ? {
            status: projectBrain.status,
            requiredVersion: projectBrain.requiredVersion,
            contractVersion: projectBrain.contractVersion,
          }
        : { status: projectBrain.status },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health_check_failed",
        label: trust.disposable ? "DISPOSABLE ACCEPTANCE — NON-PRODUCTION" : trust.runtimeMode,
        runtimeMode: trust.runtimeMode,
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    return NextResponse.json(
      {
        status: "error",
        environment: trust.runtimeMode,
        label: trust.disposable ? "DISPOSABLE ACCEPTANCE — NON-PRODUCTION" : null,
      },
      { status: 503 },
    );
  }
}
