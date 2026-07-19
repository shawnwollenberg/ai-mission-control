import { randomUUID } from "node:crypto";
import { validateTemplateDefinition, validateTemplateInputs, type TemplateDefinition } from "@/domain/mission-template";
import { applyTemplateProjection } from "@/application/template-projector";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { handleCreateMission, handleMissionTransition, type CommandActor } from "@/application/mission-commands";
import { handleAddTaskDependency, handleCreateTask } from "@/application/task-commands";
import { stableUuid } from "@/lib/stable-id";

export async function createTemplateVersion(input: {
  actor: CommandActor;
  commandId: string;
  templateId?: string;
  definition: TemplateDefinition;
  publish?: boolean;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  validateTemplateDefinition(input.definition);
  const templateId = input.templateId ?? randomUUID(),
    existing = await loadAggregateEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "mission_template",
      aggregateId: templateId,
    });
  const version =
    1 +
    Math.max(
      0,
      ...existing.filter((e) => e.eventType === "template.version_created").map((e) => Number(e.payload.version)),
    );
  const created = {
    eventType: "template.version_created",
    eventSchemaVersion: 1,
    payload: { ...input.definition, version, createdBy: input.actor.userId },
  };
  const events = input.publish
    ? [created, { eventType: "template.published", eventSchemaVersion: 1, payload: { version, status: "published" } }]
    : [created];
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "mission_template",
    aggregateId: templateId,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: "CreateTemplateVersion",
    correlationId: templateId,
    actor: { type: "human", id: input.actor.userId },
    events,
    applyProjections: applyTemplateProjection,
  });
  return { templateId, version, status: input.publish ? "published" : "draft" };
}

export async function publishTemplate(input: {
  actor: CommandActor;
  commandId: string;
  templateId: string;
  version: number;
}) {
  const row = (
    await getDatabasePool().query(
      "SELECT status FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=$3",
      [input.actor.workspaceId, input.templateId, input.version],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Template version");
  if (row.status !== "draft") throw new ValidationFailedError("Only draft templates can be published");
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "mission_template",
    aggregateId: input.templateId,
  });
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "mission_template",
    aggregateId: input.templateId,
    expectedVersion: events.length,
    commandId: input.commandId,
    commandType: "PublishTemplate",
    correlationId: input.templateId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "template.published",
        eventSchemaVersion: 1,
        payload: { version: input.version, status: "published" },
      },
    ],
    applyProjections: applyTemplateProjection,
  });
}

async function validateResources(
  workspaceId: string,
  schema: TemplateDefinition["inputSchema"],
  values: Record<string, unknown>,
) {
  for (const [key, field] of Object.entries(schema.properties))
    if (field.type === "resource_id" && values[key]) {
      const table = field.resourceType === "repository" ? "repositories" : "agent_resource_permissions";
      const result =
        table === "repositories"
          ? await getDatabasePool().query(
              "SELECT 1 FROM repositories WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL",
              [workspaceId, values[key]],
            )
          : await getDatabasePool().query(
              "SELECT 1 FROM agent_resource_permissions WHERE workspace_id=$1 AND resource_type=$2 AND resource_id=$3 AND revoked_at IS NULL",
              [workspaceId, field.resourceType, values[key]],
            );
      if (!result.rowCount) throw new ValidationFailedError(`Registered resource is unavailable: ${key}`);
    }
}

export async function launchTemplate(input: {
  actor: CommandActor;
  commandId: string;
  templateId: string;
  version: number;
  inputs: Record<string, unknown>;
  missionId?: string;
  originScheduleId?: string;
  intendedRunAt?: string;
}) {
  const row = (
    await getDatabasePool().query(
      "SELECT * FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=$3",
      [input.actor.workspaceId, input.templateId, input.version],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Template version");
  if (row.status !== "published") throw new ValidationFailedError("Only published templates can launch missions");
  const definition = {
    name: row.name,
    description: row.description,
    domain: row.domain,
    defaultObjective: row.default_objective,
    inputSchema: row.input_schema,
    tasks: row.task_definitions,
    dependencies: row.dependencies,
    defaults: row.defaults,
    artifactExpectations: row.artifact_expectations,
  } as TemplateDefinition;
  const resolved = validateTemplateInputs(definition.inputSchema, input.inputs);
  await validateResources(input.actor.workspaceId, definition.inputSchema, resolved);
  const missionId = input.missionId ?? randomUUID(),
    objective = String(resolved.objective ?? resolved.analysisObjective ?? definition.defaultObjective);
  await handleCreateMission({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:mission`),
    missionId,
    mission: {
      name: `${definition.name}: ${objective}`.slice(0, 160),
      objective,
      description: definition.description,
      domain: definition.domain,
      priority: "normal",
      riskLevel: (definition.defaults.riskLevel as "low" | "moderate" | "high") ?? "low",
      constraints:
        definition.domain === "defi_analysis"
          ? ["Analysis only", "No signing", "No submission", "No asset movement"]
          : [],
      templateId: input.templateId,
      templateVersion: input.version,
      resolvedInputs: resolved,
      resolvedTaskPlan: definition.tasks,
      originScheduleId: input.originScheduleId,
      intendedRunAt: input.intendedRunAt,
    },
  });
  const ids = new Map<string, string>();
  for (let index = 0; index < definition.tasks.length; index += 1) {
    const task = definition.tasks[index];
    const taskId = stableUuid(`${missionId}:template-task:${task.key}`);
    ids.set(task.key, taskId);
    const resources = (task.resourceInputs ?? []).map((key: string) => ({
      resourceType: definition.inputSchema.properties[key].resourceType ?? "registered_resource",
      resourceId: String(resolved[key]),
      permission: "read",
    }));
    await handleCreateTask({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${input.commandId}:task:${index}`),
      taskId,
      task: {
        missionId,
        name: task.name,
        instructions: task.instructions,
        expectedOutput: task.expectedOutput,
        priority: "normal",
        riskLevel: task.riskLevel ?? "low",
        requiredCapabilities: task.requiredCapabilities,
        requiredResources: resources,
        timeoutSeconds: task.timeoutSeconds ?? 600,
      },
    });
  }
  for (const edge of definition.dependencies)
    await handleAddTaskDependency({
      actor: { workspaceId: input.actor.workspaceId, id: input.actor.userId, type: "human" },
      commandId: stableUuid(`${input.commandId}:dependency:${edge.task}:${edge.dependsOn}`),
      taskId: ids.get(edge.task)!,
      dependsOnTaskId: ids.get(edge.dependsOn)!,
    });
  await handleMissionTransition({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:planned`),
    missionId,
    target: "planned",
  });
  await handleMissionTransition({
    actor: input.actor,
    commandId: stableUuid(`${input.commandId}:running`),
    missionId,
    target: "running",
  });
  return { missionId, taskIds: Object.fromEntries(ids) };
}
