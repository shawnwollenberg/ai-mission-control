import { Pool } from "pg";
import { verifyV1StagingDatabaseBinding } from "@/lib/v1-staging-database-binding";

let controllerPool: Pool | undefined;

export function getV1ControllerDatabasePool(): Pool {
  const connectionString = process.env.V1_CONTROLLER_DATABASE_URL;
  if (!connectionString) throw new Error("V1 controller database boundary is not configured.");
  if (process.env.MC_V1_STAGING_ISOLATION === "required")
    verifyV1StagingDatabaseBinding(
      JSON.parse(process.env.MC_V1_STAGING_DATABASE_BINDING_RECEIPT ?? ""),
      process.env.MC_V1_STAGING_ATTESTATION_PUBLIC_KEY ?? "",
      process.env.DATABASE_URL ?? "",
      connectionString,
      {
        runId: process.env.MC_V1_STAGING_RUN_ID ?? "",
        manifestDigest: process.env.MC_V1_STAGING_BOOTSTRAP_MANIFEST_DIGEST ?? "",
        accountId: process.env.MC_V1_STAGING_AWS_ACCOUNT_ID ?? "",
        region: process.env.MC_V1_STAGING_AWS_REGION ?? "",
      },
    );
  controllerPool ??= new Pool({ connectionString, max: 4 });
  return controllerPool;
}
