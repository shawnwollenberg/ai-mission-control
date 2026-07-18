import { readFile } from "node:fs/promises";
import { closeDatabasePool, getDatabasePool } from "../lib/database";
import { readDynamoMissionEvents } from "../lib/dynamodb-event-store";
import type { MissionEvent } from "../lib/mission-events";
import { appendEvents, loadAggregateEvents, type NewDomainEvent } from "../lib/postgres-event-store";
import { applyMissionProjection } from "../application/mission-projector";
import { stableUuid } from "../lib/stable-id";
const args = process.argv.slice(2);
const value = (f: string) => {
  const i = args.indexOf(f);
  return i < 0 ? undefined : args[i + 1];
};
const dryRun = args.includes("--dry-run");
const fixture = value("--fixture");
const workspace = value("--workspace") ?? process.env.DEFAULT_WORKSPACE_ID;
const ids = args.flatMap((x, i) => (x === "--mission" && args[i + 1] ? [args[i + 1]] : []));
const uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : stableUuid(`legacy:${id}`);
function translate(e: MissionEvent): NewDomainEvent | undefined {
  if (e.schemaVersion !== "1.0") return;
  const base = {
    eventId: uuid(e.eventId),
    eventSchemaVersion: 1,
    occurredAt: e.occurredAt,
    metadata: {
      importSource: "dynamodb-demo-v1",
      legacyEventId: e.eventId,
      legacyType: e.type,
      legacySequence: e.sequence,
    },
  };
  if (e.type === "mission.created")
    return {
      ...base,
      eventType: "mission.created",
      payload: {
        name: e.data.objective ?? "Imported legacy mission",
        objective: e.data.objective ?? e.data.message,
        description: e.data.detail ?? null,
        domain: "legacy_import",
        priority: (e.data.priority ?? "Normal").toLowerCase(),
        riskLevel: "unknown",
        requestedOutcome: null,
        successCriteria: [],
        constraints: [],
        budgetLimits: {},
        deadline: null,
        createdBy: e.producer.id,
        status: "draft",
      },
    };
  if (e.type === "plan.created")
    return { ...base, eventType: "mission.planned", payload: { status: "planned", summary: e.data.message } };
  if (e.type === "mission.completed")
    return { ...base, eventType: "mission.completed", payload: { status: "completed", summary: e.data.message } };
  const supported = new Set([
    "agent.activated",
    "task.assigned",
    "task.claimed",
    "task.started",
    "task.failed",
    "mission.health_changed",
    "task.delayed",
    "recommendation.triggered",
    "recommendation.approved",
    "organization.reconfigured",
    "task.completed",
    "check.completed",
    "preview.ready",
    "artifact.created",
  ]);
  if (!supported.has(e.type)) return;
  return {
    ...base,
    eventType: `legacy.${e.type}`,
    payload: { summary: e.data.message, detail: e.data.detail ?? null, legacySubject: e.subject ?? null },
  };
}
async function source() {
  if (fixture) {
    const parsed = JSON.parse(await readFile(fixture, "utf8")) as {
      missions: Array<{ missionId: string; events: MissionEvent[] }>;
    };
    return parsed.missions;
  }
  return Promise.all(ids.map(async (missionId) => ({ missionId, events: await readDynamoMissionEvents(missionId) })));
}
async function main() {
  if (!workspace) throw new Error("--workspace or DEFAULT_WORKSPACE_ID is required");
  const missions = await source();
  let imported = 0,
    skipped = 0,
    unsupported = 0;
  for (const mission of missions) {
    const missionId = uuid(mission.missionId);
    const existing = await loadAggregateEvents({
      workspaceId: workspace,
      aggregateType: "mission",
      aggregateId: missionId,
    });
    if (existing.some((e) => e.metadata.importSource !== "dynamodb-demo-v1")) {
      skipped += mission.events.length;
      continue;
    }
    let version = existing.length;
    for (const legacy of mission.events.sort((a, b) => a.sequence - b.sequence)) {
      const event = translate(legacy);
      if (!event) {
        unsupported++;
        if (!dryRun)
          await getDatabasePool().query(
            "INSERT INTO legacy_import_quarantine(source,source_id,reason,record) VALUES('dynamodb-demo-v1',$1,$2,$3) ON CONFLICT(source,source_id) DO NOTHING",
            [legacy.eventId, `Unsupported event ${legacy.type} schema ${legacy.schemaVersion}`, legacy],
          );
        continue;
      }
      if (dryRun) {
        imported++;
        continue;
      }
      const result = await appendEvents({
        workspaceId: workspace,
        aggregateType: "mission",
        aggregateId: missionId,
        missionId,
        expectedVersion: version,
        commandId: stableUuid(`legacy-import:${mission.missionId}:${legacy.eventId}`),
        commandType: "ImportLegacyEvent",
        correlationId: missionId,
        actor: { type: "system", id: "dynamodb-import" },
        events: [event],
        applyProjections: applyMissionProjection,
      });
      if (!result.duplicateCommand) imported++;
      version = result.events.at(-1)?.aggregateVersion ?? version;
    }
  }
  console.log(
    JSON.stringify({
      event: "legacy_import_summary",
      dryRun,
      missions: missions.length,
      imported,
      skipped,
      unsupported,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
