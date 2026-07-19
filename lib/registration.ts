import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { appendEvents } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import type { SessionIdentity } from "@/lib/session";
import { INITIAL_TEMPLATES } from "@/templates/initial-templates";
import { createTemplateVersion } from "@/application/template-commands";
import { stableUuid } from "@/lib/stable-id";

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

export function personalWorkspaceName(displayName: string) {
  const firstName = displayName.trim().split(/\s+/)[0] || "My";
  return firstName.toLowerCase() === "my"
    ? "My Workspace"
    : `${firstName}${firstName.endsWith("s") ? "'" : "'s"} Workspace`;
}

async function seedPersonalWorkspace(identity: SessionIdentity) {
  for (const template of INITIAL_TEMPLATES)
    await createTemplateVersion({
      actor: { workspaceId: identity.workspaceId, userId: identity.userId, role: "owner" },
      commandId: stableUuid(`personal-workspace:${identity.workspaceId}:template:${template.templateId}:1`),
      templateId: template.templateId,
      definition: template.definition,
      publish: true,
    });
}

export async function registerMember(input: {
  email?: string;
  displayName?: string;
  password?: string;
}): Promise<SessionIdentity> {
  const registration = validateRegistration(input);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const commandId = randomUUID();
  const passwordHash = await hash(registration.password, 12);
  await getDatabasePool().query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)`, [
    workspaceId,
    `personal-${workspaceId}`,
    personalWorkspaceName(registration.displayName),
  ]);
  try {
    await appendEvents({
      workspaceId,
      aggregateType: "workspace",
      aggregateId: workspaceId,
      expectedVersion: 0,
      commandId,
      commandType: "workspace.personal.create",
      correlationId: commandId,
      actor: { type: "human", id: userId },
      events: [
        {
          eventType: "workspace.created",
          eventSchemaVersion: 1,
          payload: { workspaceId, name: personalWorkspaceName(registration.displayName), tenancy: "personal" },
        },
        {
          eventType: "workspace.owner.registered",
          eventSchemaVersion: 1,
          payload: {
            userId,
            email: registration.email,
            role: "owner",
            authentication: "password_hash",
            secretRecorded: false,
          },
        },
      ],
      applyProjections: async (client) => {
        await client.query(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`, [
          userId,
          registration.email,
          registration.displayName,
          passwordHash,
        ]);
        await client.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
          workspaceId,
          userId,
        ]);
      },
    });
  } catch (error) {
    await getDatabasePool()
      .query("DELETE FROM workspaces WHERE id=$1", [workspaceId])
      .catch(() => undefined);
    throw error;
  }
  const identity: SessionIdentity = { userId, workspaceId, role: "owner", email: registration.email, authVersion: 1 };
  await seedPersonalWorkspace(identity).catch((error) =>
    console.error(
      JSON.stringify({
        level: "error",
        event: "personal_workspace_template_seed_failed",
        workspaceId,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  return identity;
}
