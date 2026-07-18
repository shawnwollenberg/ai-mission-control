import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ConcurrencyConflictError, DatabaseUnavailableError, ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool, withTransaction } from "@/lib/database";

export type ActorType = "human" | "agent" | "system" | "scheduler";

export type NewDomainEvent = {
  eventId?: string;
  eventType: string;
  eventSchemaVersion: number;
  occurredAt?: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type DomainEvent = {
  position: number;
  eventId: string;
  eventType: string;
  eventSchemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  missionId?: string;
  workspaceId: string;
  correlationId: string;
  causationId?: string;
  actorType: ActorType;
  actorId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type NewOutboxMessage = {
  eventIndex: number;
  messageId?: string;
  topic: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  availableAt?: string;
};

export type AppendEventsInput = {
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  missionId?: string;
  expectedVersion: number;
  commandId: string;
  commandType: string;
  correlationId: string;
  causationId?: string;
  actor: { type: ActorType; id: string };
  events: NewDomainEvent[];
  outbox?: NewOutboxMessage[];
  applyProjections?: (client: PoolClient, events: DomainEvent[]) => Promise<void>;
};

export type AppendEventsResult = { events: DomainEvent[]; duplicateCommand: boolean };

type EventRow = {
  position: string;
  event_id: string;
  event_type: string;
  event_schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  mission_id: string | null;
  workspace_id: string;
  correlation_id: string;
  causation_id: string | null;
  actor_type: ActorType;
  actor_id: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type PostgresError = Error & { code?: string };

function mapEvent(row: EventRow): DomainEvent {
  return {
    position: Number(row.position),
    eventId: row.event_id,
    eventType: row.event_type,
    eventSchemaVersion: row.event_schema_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    ...(row.mission_id ? { missionId: row.mission_id } : {}),
    workspaceId: row.workspace_id,
    correlationId: row.correlation_id,
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    actorType: row.actor_type,
    actorId: row.actor_id,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
    metadata: row.metadata,
  };
}

function validateAppend(input: AppendEventsInput) {
  if (!input.events.length) throw new ValidationFailedError("At least one event is required");
  if (input.expectedVersion < 0 || !Number.isInteger(input.expectedVersion)) {
    throw new ValidationFailedError("Expected version must be a non-negative integer");
  }
  if (
    input.events.some(
      (event) => !event.eventType || !Number.isInteger(event.eventSchemaVersion) || event.eventSchemaVersion < 1,
    )
  ) {
    throw new ValidationFailedError("Every event requires a type and positive integer schema version");
  }
  if (input.outbox?.some((message) => message.eventIndex < 0 || message.eventIndex >= input.events.length)) {
    throw new ValidationFailedError("Outbox event index is outside the appended event range");
  }
}

function translateDatabaseError(error: unknown): never {
  if (error instanceof ConcurrencyConflictError || error instanceof ValidationFailedError) throw error;
  const postgresError = error as PostgresError;
  if (postgresError.code === "23505" || postgresError.code === "40001" || postgresError.code === "40P01") {
    throw new ConcurrencyConflictError(undefined, { cause: error });
  }
  if (postgresError.code?.startsWith("08") || postgresError.code === "57P01") {
    throw new DatabaseUnavailableError({ cause: error });
  }
  throw error;
}

const eventColumns = `position, event_id, event_type, event_schema_version, aggregate_type, aggregate_id,
  aggregate_version, mission_id, workspace_id, correlation_id, causation_id, actor_type, actor_id,
  occurred_at, payload, metadata`;

async function readEventsByIds(client: PoolClient, workspaceId: string, eventIds: string[]): Promise<DomainEvent[]> {
  if (!eventIds.length) return [];
  const result = await client.query<EventRow>(
    `SELECT ${eventColumns} FROM events WHERE workspace_id = $1 AND event_id = ANY($2::uuid[]) ORDER BY position`,
    [workspaceId, eventIds],
  );
  return result.rows.map(mapEvent);
}

export async function appendEvents(input: AppendEventsInput): Promise<AppendEventsResult> {
  validateAppend(input);
  try {
    return await withTransaction(async (client) => {
      const commandInsert = await client.query(
        `INSERT INTO commands (workspace_id, command_id, command_type, aggregate_type, aggregate_id, status)
         VALUES ($1, $2, $3, $4, $5, 'processing')
         ON CONFLICT (workspace_id, command_id) DO NOTHING
         RETURNING command_id`,
        [input.workspaceId, input.commandId, input.commandType, input.aggregateType, input.aggregateId],
      );
      if (!commandInsert.rowCount) {
        const command = await client.query<{ status: string; result_event_ids: string[] }>(
          `SELECT status, result_event_ids FROM commands WHERE workspace_id = $1 AND command_id = $2`,
          [input.workspaceId, input.commandId],
        );
        if (command.rows[0]?.status !== "completed") throw new ConcurrencyConflictError({ commandId: input.commandId });
        return {
          events: await readEventsByIds(client, input.workspaceId, command.rows[0].result_event_ids),
          duplicateCommand: true,
        };
      }

      await client.query(
        `INSERT INTO aggregate_heads (workspace_id, aggregate_type, aggregate_id, version)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (workspace_id, aggregate_type, aggregate_id) DO NOTHING`,
        [input.workspaceId, input.aggregateType, input.aggregateId],
      );
      const head = await client.query<{ version: number }>(
        `SELECT version FROM aggregate_heads
         WHERE workspace_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
         FOR UPDATE`,
        [input.workspaceId, input.aggregateType, input.aggregateId],
      );
      const actualVersion = head.rows[0]?.version;
      if (actualVersion !== input.expectedVersion) {
        throw new ConcurrencyConflictError({ expectedVersion: input.expectedVersion, actualVersion });
      }

      const appended: DomainEvent[] = [];
      for (let index = 0; index < input.events.length; index += 1) {
        const event = input.events[index];
        const result = await client.query<EventRow>(
          `INSERT INTO events (
             event_id, event_type, event_schema_version, aggregate_type, aggregate_id, aggregate_version,
             mission_id, workspace_id, correlation_id, causation_id, actor_type, actor_id, occurred_at, payload, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING ${eventColumns}`,
          [
            event.eventId ?? randomUUID(),
            event.eventType,
            event.eventSchemaVersion,
            input.aggregateType,
            input.aggregateId,
            input.expectedVersion + index + 1,
            input.missionId ?? null,
            input.workspaceId,
            input.correlationId,
            input.causationId ?? null,
            input.actor.type,
            input.actor.id,
            event.occurredAt ?? new Date().toISOString(),
            event.payload,
            event.metadata ?? {},
          ],
        );
        appended.push(mapEvent(result.rows[0]));
      }

      if (input.applyProjections) await input.applyProjections(client, appended);

      for (const message of input.outbox ?? []) {
        const sourceEvent = appended[message.eventIndex];
        await client.query(
          `INSERT INTO outbox (
             workspace_id, message_id, event_id, topic, idempotency_key, correlation_id, payload, available_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.workspaceId,
            message.messageId ?? randomUUID(),
            sourceEvent.eventId,
            message.topic,
            message.idempotencyKey,
            input.correlationId,
            message.payload,
            message.availableAt ?? new Date().toISOString(),
          ],
        );
      }

      const nextVersion = input.expectedVersion + appended.length;
      await client.query(
        `UPDATE aggregate_heads SET version = $4, updated_at = now()
         WHERE workspace_id = $1 AND aggregate_type = $2 AND aggregate_id = $3`,
        [input.workspaceId, input.aggregateType, input.aggregateId, nextVersion],
      );
      await client.query(
        `UPDATE commands SET status = 'completed', result_event_ids = $3, completed_at = now()
         WHERE workspace_id = $1 AND command_id = $2`,
        [input.workspaceId, input.commandId, appended.map((event) => event.eventId)],
      );
      return { events: appended, duplicateCommand: false };
    });
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function loadAggregateEvents(input: {
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
}): Promise<DomainEvent[]> {
  try {
    const result = await getDatabasePool().query<EventRow>(
      `SELECT ${eventColumns} FROM events
       WHERE workspace_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
       ORDER BY aggregate_version`,
      [input.workspaceId, input.aggregateType, input.aggregateId],
    );
    return result.rows.map(mapEvent);
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function loadMissionEvents(input: { workspaceId: string; missionId: string }): Promise<DomainEvent[]> {
  try {
    const result = await getDatabasePool().query<EventRow>(
      `SELECT ${eventColumns} FROM events WHERE workspace_id = $1 AND mission_id = $2 ORDER BY position`,
      [input.workspaceId, input.missionId],
    );
    return result.rows.map(mapEvent);
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function loadEventsFromGlobalPosition(input: {
  workspaceId: string;
  afterPosition: number;
  limit?: number;
}): Promise<DomainEvent[]> {
  if (input.afterPosition < 0 || !Number.isInteger(input.afterPosition)) {
    throw new ValidationFailedError("Global position must be a non-negative integer");
  }
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2_000);
  try {
    const result = await getDatabasePool().query<EventRow>(
      `SELECT ${eventColumns} FROM events
       WHERE workspace_id = $1 AND position > $2
       ORDER BY position LIMIT $3`,
      [input.workspaceId, input.afterPosition, limit],
    );
    return result.rows.map(mapEvent);
  } catch (error) {
    return translateDatabaseError(error);
  }
}
