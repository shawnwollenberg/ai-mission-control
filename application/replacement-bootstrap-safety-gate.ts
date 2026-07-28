import { createHash } from "node:crypto";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import type { PoolClient } from "pg";

export const REPLACEMENT_DISPOSABLE_MODE = "disposable-test" as const;
export const REPLACEMENT_DISPOSABLE_INSTANCE = "mission-control-disposable-replacement-bootstrap-v1" as const;
export const REPLACEMENT_DISPOSABLE_GATE = "explicitly-authorized-non-production-only" as const;

export type ReplacementDisposableEnvironment = {
  mode: typeof REPLACEMENT_DISPOSABLE_MODE;
  instanceIdentity: typeof REPLACEMENT_DISPOSABLE_INSTANCE;
  databaseHost: "127.0.0.1" | "localhost" | "::1";
  databaseName: string;
  resourceFingerprint: string;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function disposableEnvironmentFingerprint(
  value: Omit<ReplacementDisposableEnvironment, "resourceFingerprint">,
): string {
  return sha256(canonicalJson(value));
}

export function assertDisposableReplacementEnvironment(input: {
  environment: NodeJS.ProcessEnv;
  databaseUrl: string;
  packageInstanceIdentity: string;
}): ReplacementDisposableEnvironment {
  if (
    input.environment.NODE_ENV === "production" ||
    input.environment.MISSION_CONTROL_ENVIRONMENT !== REPLACEMENT_DISPOSABLE_MODE ||
    input.environment.MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION !== REPLACEMENT_DISPOSABLE_GATE ||
    input.environment.MISSION_CONTROL_INSTANCE_ID !== REPLACEMENT_DISPOSABLE_INSTANCE ||
    input.packageInstanceIdentity !== REPLACEMENT_DISPOSABLE_INSTANCE
  )
    throw new Error("Replacement bootstrap is disabled outside an explicit disposable environment.");
  const database = new URL(input.databaseUrl);
  const databaseName = database.pathname.slice(1);
  if (database.protocol !== "postgres:" && database.protocol !== "postgresql:")
    throw new Error("Disposable replacement database protocol is invalid.");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(database.hostname) ||
    !databaseName.startsWith("mission_control_replacement_disposable_") ||
    database.search ||
    database.hash
  )
    throw new Error("Replacement bootstrap refuses non-disposable database resources.");
  const unsigned = {
    mode: REPLACEMENT_DISPOSABLE_MODE,
    instanceIdentity: REPLACEMENT_DISPOSABLE_INSTANCE,
    databaseHost: database.hostname as ReplacementDisposableEnvironment["databaseHost"],
    databaseName,
  };
  const resourceFingerprint = disposableEnvironmentFingerprint(unsigned);
  if (input.environment.MISSION_AGENT_REPLACEMENT_BOOTSTRAP_RESOURCE_FINGERPRINT !== resourceFingerprint)
    throw new Error("Disposable replacement resource fingerprint is absent or mismatched.");
  return { ...unsigned, resourceFingerprint };
}

export function assertDisposableLocalOperatorEnvironment(input: {
  environment: NodeJS.ProcessEnv;
  missionControlUrl: string;
  packageInstanceIdentity: string;
}): void {
  const endpoint = new URL(input.missionControlUrl);
  if (
    input.environment.NODE_ENV === "production" ||
    input.environment.MISSION_CONTROL_ENVIRONMENT !== REPLACEMENT_DISPOSABLE_MODE ||
    input.environment.MISSION_AGENT_REPLACEMENT_BOOTSTRAP_DISPOSABLE_EXECUTION !== REPLACEMENT_DISPOSABLE_GATE ||
    input.environment.MISSION_CONTROL_INSTANCE_ID !== REPLACEMENT_DISPOSABLE_INSTANCE ||
    input.packageInstanceIdentity !== REPLACEMENT_DISPOSABLE_INSTANCE ||
    endpoint.protocol !== "https:" ||
    !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)
  )
    throw new Error("Local replacement mutation is disabled outside the bound disposable control plane.");
}

export async function assertDisposableReplacementDatabase(client: PoolClient): Promise<string> {
  const result = await client.query<{
    database_name: string;
    instance_identity: string;
    resource_fingerprint: string;
  }>(
    `SELECT current_database() database_name,instance_identity,resource_fingerprint
       FROM replacement_bootstrap_disposable_environment_guard
      WHERE instance_identity=$1`,
    [REPLACEMENT_DISPOSABLE_INSTANCE],
  );
  const row = result.rows[0];
  if (
    !row ||
    !row.database_name.startsWith("mission_control_replacement_disposable_") ||
    row.instance_identity !== REPLACEMENT_DISPOSABLE_INSTANCE ||
    !/^[a-f0-9]{64}$/.test(row.resource_fingerprint)
  )
    throw new Error("Database lacks the explicit disposable replacement environment guard.");
  return row.resource_fingerprint;
}
