import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { appendEvents } from "@/lib/postgres-event-store";
import { DEFAULT_WORKSPACE_ID } from "@/lib/identity-constants";
import type { SessionIdentity } from "@/lib/session";

export class RegistrationValidationError extends Error {}

export function validateRegistration(input: { email?: string; displayName?: string; password?: string }) {
  const email = input.email?.trim().toLowerCase() ?? "";
  const displayName = input.displayName?.trim() ?? "";
  const password = input.password ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RegistrationValidationError("Enter a valid email address.");
  if (displayName.length < 2 || displayName.length > 80)
    throw new RegistrationValidationError("Name must be between 2 and 80 characters.");
  if (password.length < 12 || password.length > 200)
    throw new RegistrationValidationError("Password must be between 12 and 200 characters.");
  return { email, displayName, password };
}

export async function registerMember(input: { email?: string; displayName?: string; password?: string }): Promise<SessionIdentity> {
  const registration = validateRegistration(input);
  const userId = randomUUID();
  const commandId = randomUUID();
  const passwordHash = await hash(registration.password, 12);
  await appendEvents({
    workspaceId: DEFAULT_WORKSPACE_ID,
    aggregateType: "workspace_member",
    aggregateId: userId,
    expectedVersion: 0,
    commandId,
    commandType: "workspace.member.register",
    correlationId: commandId,
    actor: { type: "human", id: userId },
    events: [{
      eventType: "workspace.member.registered",
      eventSchemaVersion: 1,
      payload: { userId, email: registration.email, role: "member", authentication: "password_hash", secretRecorded: false },
    }],
    applyProjections: async (client) => {
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
        [userId, registration.email, registration.displayName, passwordHash],
      );
      await client.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
        [DEFAULT_WORKSPACE_ID, userId],
      );
    },
  });
  return { userId, workspaceId: DEFAULT_WORKSPACE_ID, role: "member", email: registration.email, authVersion: 1 };
}
