import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { INITIAL_TEMPLATES } from "../templates/initial-templates";
import { createTemplateVersion } from "../application/template-commands";
import { createSchedule } from "../application/schedule-commands";
import { registerRemoteAgent } from "../application/remote-agent-registry";
import { grantAgentResource } from "../application/agent-eligibility";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { closeDatabasePool } from "../lib/database";
async function main() {
  const file = process.env.PHASE5_CREDENTIAL_FILE;
  if (!file) throw new Error("PHASE5_CREDENTIAL_FILE is required");
  const actor = { workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_OWNER_ID, role: "owner" as const },
    resourceId = randomUUID();
  const registration = await registerRemoteAgent({
    actor,
    name: "Scheduled Hermes Health Reporter",
    description: "Phase 5 scheduled read-only health reporter",
    endpoint: process.env.HERMES_ENDPOINT ?? "http://127.0.0.1:4105/executions",
    capabilities: ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"],
    supportedDomains: ["systems_monitoring"],
    concurrencyLimit: 1,
  });
  await grantAgentResource({
    workspaceId: DEFAULT_WORKSPACE_ID,
    agentId: registration.agentId,
    resourceType: "monitoring_endpoint",
    resourceId,
    permissions: ["read"],
  });
  const initial = INITIAL_TEMPLATES.find((item) => item.definition.name === "Operational Health Report")!;
  const version = await createTemplateVersion({
    actor,
    commandId: randomUUID(),
    templateId: initial.templateId,
    definition: initial.definition,
    publish: true,
  });
  const schedule = await createSchedule({
    actor,
    commandId: randomUUID(),
    name: "Daily Mission Control Health Report",
    templateId: initial.templateId,
    templateVersion: version.version,
    inputs: {
      healthResource: resourceId,
      systems: ["mission-control"],
      timeRange: "24h",
      severityThreshold: "warning",
      reportDestination: "in-app",
    },
    timeZone: "America/New_York",
    rule: { type: "once", at: new Date(Date.now() - 1000).toISOString() },
    startAt: new Date(Date.now() - 1000).toISOString(),
    concurrencyPolicy: "skip_if_running",
    missedRunPolicy: "run_once_on_recovery",
  });
  await writeFile(
    file,
    JSON.stringify(
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        agentId: registration.agentId,
        credentialId: registration.credential.credentialId,
        secret: registration.credential.secret,
        scheduleId: schedule.scheduleId,
        templateId: initial.templateId,
        templateVersion: version.version,
        resourceId,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      event: "phase5_acceptance_prepared",
      agentId: registration.agentId,
      scheduleId: schedule.scheduleId,
      templateVersion: version.version,
      credentialFile: file,
      credentialDisplayed: false,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
