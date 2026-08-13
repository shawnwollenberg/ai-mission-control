import { createHash, randomUUID } from "node:crypto";
import type { AcceptanceResourceInventory, AcceptanceResourceRecord } from "./acceptance-resource-inventory";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createGovernedAcceptanceResource<T>(args: {
  inventory: AcceptanceResourceInventory;
  record: Omit<AcceptanceResourceRecord, "lifecycleState" | "reservationIdentity" | "reservedAt">;
  persist: (event: string) => void | Promise<void>;
  create: (reservation: { ownershipToken: string; reservationIdentity: string }) => T | Promise<T>;
  observeIdentity: (
    created: T,
  ) => Readonly<Record<string, string | number>> | Promise<Readonly<Record<string, string | number>>>;
  emergencyCleanup: (created: T) => void | Promise<void>;
  now?: () => string;
}) {
  const now = args.now ?? (() => new Date().toISOString());
  const ownershipToken = randomUUID();
  const reservedAt = now();
  const reservationIdentity = hash(
    JSON.stringify({
      acceptanceRunId: args.inventory.acceptanceRunId,
      resourceId: args.record.resourceId,
      type: args.record.type,
      intendedIdentity: args.record.identity,
      ownershipToken,
      reservedAt,
    }),
  );
  args.inventory.reserve({
    ...args.record,
    identity: { ...args.record.identity, ownershipToken },
    lifecycleState: "creation_reserved",
    reservationIdentity,
    reservedAt,
  });
  await args.persist("resource_creation_reserved");
  let created: T;
  try {
    created = await args.create({ ownershipToken, reservationIdentity });
  } catch (error) {
    args.inventory.markCreationFailed(args.record.resourceId, error instanceof Error ? error.message : String(error));
    await args.persist("resource_creation_failed");
    throw error;
  }
  try {
    const actualIdentity = await args.observeIdentity(created);
    args.inventory.markCreated(args.record.resourceId, actualIdentity, now());
    await args.persist("resource_created");
    return created;
  } catch (error) {
    await args.emergencyCleanup(created);
    throw new Error(`Acceptance resource creation succeeded but durable transition failed: ${args.record.resourceId}`, {
      cause: error,
    });
  }
}
