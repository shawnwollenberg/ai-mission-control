import { closeDatabasePool, withTransaction } from "../lib/database";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_SLUG } from "../lib/identity-constants";
import { stableUuid } from "../lib/stable-id";
import { INITIAL_TEMPLATES } from "../templates/initial-templates";
import { createTemplateVersion } from "../application/template-commands";
import { setNotificationPreferences } from "../application/notification-preferences";
import { saveView, type MissionFilters } from "../application/mission-search";

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
  const actor = { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" as const };
  const preferences = await (
    await import("../lib/database")
  )
    .getDatabasePool()
    .query("SELECT 1 FROM notification_preferences WHERE workspace_id=$1", [DEFAULT_WORKSPACE_ID]);
  if (!preferences.rowCount)
    await setNotificationPreferences({
      actor,
      commandId: stableUuid("seed-notification-preferences"),
      inAppEnabled: true,
      emailEnabled: false,
      outboundEnabled: false,
      deliveryMode: "immediate",
      minimumSeverity: "info",
      categories: [
        "approvals",
        "mission_outcomes",
        "failures",
        "agent_status",
        "worker_status",
        "schedules",
        "budgets",
        "security",
        "git_publication",
        "defi_analysis",
      ],
      timeZone: "UTC",
      dailyDigestTime: "09:00",
      highSeverityOverride: true,
    });
  const views: { key: string; name: string; filters: MissionFilters }[] = [
    { key: "needs_approval", name: "Needs my approval", filters: { approvalState: "pending" } },
    { key: "failed_24h", name: "Failed in the last 24 hours", filters: { failed: true } },
    { key: "active_coding", name: "Active coding work", filters: { status: "running", domain: "software_delivery" } },
    { key: "hermes_reports", name: "Hermes reports", filters: { domain: "systems_monitoring" } },
    {
      key: "scheduled_defi",
      name: "Scheduled DeFi reviews",
      filters: { domain: "defi_analysis", origin: "scheduled" },
    },
    { key: "open_pr", name: "Open PR missions", filters: { hasOpenPr: true } },
    { key: "unknown_cost", name: "Unknown cost", filters: { hasUnknownCost: true } },
    { key: "offline", name: "Offline agents or workers", filters: {} },
  ];
  for (const view of views) {
    const exists = await (
      await import("../lib/database")
    )
      .getDatabasePool()
      .query("SELECT 1 FROM saved_view_projections WHERE workspace_id=$1 AND system_key=$2", [
        DEFAULT_WORKSPACE_ID,
        view.key,
      ]);
    if (!exists.rowCount)
      await saveView({
        actor,
        commandId: stableUuid(`seed-view:${view.key}`),
        savedViewId: stableUuid(`saved-view:${view.key}`),
        name: view.name,
        filters: view.filters,
        systemKey: view.key,
        isDefault: view.key === "needs_approval",
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
