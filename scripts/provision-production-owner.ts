import { readFile } from "node:fs/promises";
import { hash } from "bcryptjs";
import { appendEvents } from "../lib/postgres-event-store";
import { closeDatabasePool, getDatabasePool } from "../lib/database";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { seedDatabase } from "./seed";
import { stableUuid } from "../lib/stable-id";
import { validateProductionConfiguration } from "../lib/production-config";

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value.trimEnd();
}
async function main() {
  if (process.env.APP_ENV !== "production" || process.env.PRODUCTION_CONFIRMATION !== "PROVISION_MISSION_CONTROL_OWNER")
    throw new Error(
      "Owner provisioning requires APP_ENV=production and PRODUCTION_CONFIRMATION=PROVISION_MISSION_CONTROL_OWNER",
    );
  const validation = await validateProductionConfiguration("web", { requireCurrentSchema: true });
  if (!validation.ready) throw new Error(`Production configuration failed: ${validation.failed.join(", ")}`);
  const existing = await getDatabasePool().query("SELECT 1 FROM workspace_memberships WHERE role='owner' LIMIT 1");
  if (existing.rowCount) throw new Error("A production owner already exists; refusing to replace it");
  const password = process.env.MISSION_CONTROL_OWNER_PASSWORD_FILE
    ? (await readFile(process.env.MISSION_CONTROL_OWNER_PASSWORD_FILE, "utf8")).trimEnd()
    : await readStdin();
  if (password.length < 16)
    throw new Error("Supply a password of at least 16 characters through stdin or MISSION_CONTROL_OWNER_PASSWORD_FILE");
  const result = await seedDatabase({
    email: process.env.MISSION_CONTROL_OWNER_EMAIL ?? "",
    displayName: process.env.MISSION_CONTROL_OWNER_NAME ?? "",
    passwordHash: await hash(password, 12),
  });
  await appendEvents({
    workspaceId: DEFAULT_WORKSPACE_ID,
    aggregateType: "workspace_provisioning",
    aggregateId: DEFAULT_WORKSPACE_ID,
    expectedVersion: 0,
    commandId: stableUuid("production-owner-provisioned"),
    commandType: "production.owner.provision",
    correlationId: stableUuid("production-owner-provisioned"),
    actor: { type: "system", id: "production-provisioner" },
    events: [
      {
        eventType: "production.owner.provisioned",
        eventSchemaVersion: 1,
        payload: {
          ownerId: DEFAULT_OWNER_ID,
          workspaceId: DEFAULT_WORKSPACE_ID,
          authentication: "password_hash",
          secretRecorded: false,
        },
      },
    ],
  });
  console.log(
    JSON.stringify({
      event: "production_owner_provisioned",
      ...result,
      ownerId: DEFAULT_OWNER_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      secretPrinted: false,
    }),
  );
}
main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "production_owner_provisioning_failed",
        message: error instanceof Error ? error.message : String(error),
        secretPrinted: false,
      }),
    );
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
