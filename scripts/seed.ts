import { closeDatabasePool, withTransaction } from "../lib/database";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_SLUG } from "../lib/identity-constants";
import { stableUuid } from "../lib/stable-id";
import { INITIAL_TEMPLATES } from "../templates/initial-templates";
import { createTemplateVersion } from "../application/template-commands";

export type SeedInput = { email: string; displayName: string; passwordHash: string };

export async function seedDatabase(input: SeedInput) {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const passwordHash = input.passwordHash.trim();
  if (!email || !displayName || !passwordHash) {
    throw new Error(
      "MISSION_CONTROL_OWNER_EMAIL, MISSION_CONTROL_OWNER_NAME, and MISSION_CONTROL_OWNER_PASSWORD_HASH are required",
    );
  }
  if (!/^\$2[aby]\$\d{2}\$/.test(passwordHash))
    throw new Error("MISSION_CONTROL_OWNER_PASSWORD_HASH must be a bcrypt hash");

  return withTransaction(async (client) => {
    const workspace = await client.query(
      `INSERT INTO workspaces (id, slug, name)
       VALUES ($1, $2, 'Mission Control')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_SLUG],
    );
    const user = await client.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [DEFAULT_OWNER_ID, email, displayName, passwordHash],
    );
    const membership = await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING user_id`,
      [DEFAULT_WORKSPACE_ID, DEFAULT_OWNER_ID],
    );
    await client.query(
      `INSERT INTO policy_definitions(workspace_id,policy_id,policy_version,name,scope_type,priority,rules) VALUES($1,$2,'phase3.1','Phase 3 permanent safety boundary','workspace',100,$3) ON CONFLICT(workspace_id,policy_id,policy_version) DO NOTHING`,
      [
        DEFAULT_WORKSPACE_ID,
        stableUuid("phase3-default-policy"),
        JSON.stringify({
          deniedActions: [
            "repository.merge_pull_request",
            "deployment.start",
            "database.run_destructive_command",
            "infrastructure.modify",
            "secret.read",
            "secret.modify",
          ],
        }),
      ],
    );
    return {
      workspaceCreated: workspace.rowCount === 1,
      ownerCreated: user.rowCount === 1,
      membershipCreated: membership.rowCount === 1,
    };
  });
}

async function main() {
  const result = await seedDatabase({
    email: process.env.MISSION_CONTROL_OWNER_EMAIL ?? "",
    displayName: process.env.MISSION_CONTROL_OWNER_NAME ?? "",
    passwordHash: process.env.MISSION_CONTROL_OWNER_PASSWORD_HASH ?? "",
  });
  for (const template of INITIAL_TEMPLATES) {
    const exists = await (
      await import("../lib/database")
    )
      .getDatabasePool()
      .query("SELECT 1 FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=1", [
        DEFAULT_WORKSPACE_ID,
        template.templateId,
      ]);
    if (!exists.rowCount)
      await createTemplateVersion({
        actor: { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" },
        commandId: stableUuid(`seed-template:${template.templateId}:1`),
        templateId: template.templateId,
        definition: template.definition,
        publish: true,
      });
  }
  console.log(JSON.stringify({ event: "database_seeded", ...result }));
}

if (process.argv[1]?.endsWith("seed.ts")) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(closeDatabasePool);
}
