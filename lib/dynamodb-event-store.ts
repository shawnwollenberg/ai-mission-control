import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { EVENT_SCHEMA_VERSION, type ControlledEventTemplate, type MissionEvent } from "@/lib/mission-events";

const tableName = process.env.MISSION_EVENTS_TABLE;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function requireTable(): string {
  if (!tableName) throw new Error("MISSION_EVENTS_TABLE is required when EVENT_STORE=dynamodb");
  return tableName;
}

function missionPk(missionId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(missionId)) throw new Error("Invalid mission id");
  return `MISSION#${missionId}`;
}

function eventSk(sequence: number, eventId: string): string {
  return `EVENT#${String(sequence).padStart(12, "0")}#${eventId}`;
}

function expiresAt(): number {
  const days = Number(process.env.DEMO_EVENT_TTL_DAYS ?? 7);
  return Math.floor(Date.now() / 1000) + Math.max(1, days) * 86_400;
}

async function readDuplicate(missionId: string, eventId: string): Promise<MissionEvent | undefined> {
  const TableName = requireTable();
  const PK = missionPk(missionId);
  const marker = await client.send(
    new GetCommand({
      TableName,
      Key: { PK, SK: `IDEMPOTENCY#${eventId}` },
      ConsistentRead: true,
    }),
  );
  const existingSk = marker.Item?.eventSk as string | undefined;
  if (!existingSk) return undefined;
  const existing = await client.send(new GetCommand({ TableName, Key: { PK, SK: existingSk }, ConsistentRead: true }));
  return existing.Item?.event as MissionEvent | undefined;
}

export async function readDynamoMissionEvents(missionId: string): Promise<MissionEvent[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: requireTable(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :event)",
      ExpressionAttributeValues: { ":pk": missionPk(missionId), ":event": "EVENT#" },
      ConsistentRead: true,
      ScanIndexForward: true,
    }),
  );
  return (result.Items ?? []).map((item) => item.event as MissionEvent);
}

export async function appendDynamoMissionEvent(
  missionId: string,
  template: ControlledEventTemplate,
  options: { eventId?: string; causationId?: string; occurredAt?: string } = {},
): Promise<MissionEvent> {
  const TableName = requireTable();
  const PK = missionPk(missionId);
  const id = options.eventId ?? randomUUID();
  const duplicate = await readDuplicate(missionId, id);
  if (duplicate) return duplicate;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const meta = await client.send(new GetCommand({ TableName, Key: { PK, SK: "META" }, ConsistentRead: true }));
    const current = Number(meta.Item?.nextSequence ?? 0);
    const sequence = current + 1;
    const events = current ? await readDynamoMissionEvents(missionId) : [];
    const prior = events.at(-1);
    const event: MissionEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: id,
      missionId,
      sequence,
      type: template.type,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      producer: template.producer,
      correlationId: missionId,
      ...((options.causationId ?? prior?.eventId) ? { causationId: options.causationId ?? prior?.eventId } : {}),
      ...(template.subject ? { subject: template.subject } : {}),
      data: template.data,
    };
    const SK = eventSk(sequence, id);
    const ttl = expiresAt();
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName,
                Key: { PK, SK: "META" },
                UpdateExpression: "SET nextSequence = :next, expiresAt = :ttl, missionId = :missionId",
                ConditionExpression: current === 0 ? "attribute_not_exists(nextSequence)" : "nextSequence = :current",
                ExpressionAttributeValues: {
                  ":next": sequence,
                  ":ttl": ttl,
                  ":missionId": missionId,
                  ...(current === 0 ? {} : { ":current": current }),
                },
              },
            },
            {
              Put: {
                TableName,
                Item: {
                  PK,
                  SK,
                  event,
                  eventId: id,
                  missionId,
                  sequence,
                  eventType: event.type,
                  occurredAt: event.occurredAt,
                  expiresAt: ttl,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName,
                Item: { PK, SK: `IDEMPOTENCY#${id}`, eventSk: SK, eventId: id, missionId, expiresAt: ttl },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return event;
    } catch (error) {
      const existing = await readDuplicate(missionId, id);
      if (existing) return existing;
      if (attempt === 7) throw error;
    }
  }
  throw new Error("Unable to append mission event");
}

export async function checkDynamoEventStore(): Promise<void> {
  await client.send(new GetCommand({ TableName: requireTable(), Key: { PK: "HEALTH", SK: "HEALTH" } }));
}
