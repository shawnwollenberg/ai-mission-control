import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import {
  CONTROLLED_EVENT_TEMPLATES,
  EVENT_SCHEMA_VERSION,
  projectMission,
  type ControlledEventTemplate,
  type AgentEventInput,
  type MissionEvent,
  type MissionProjection,
} from "@/lib/mission-events";
import { appendDynamoMissionEvent, readDynamoMissionEvents } from "@/lib/dynamodb-event-store";

const DATA_DIR = process.env.MISSION_CONTROL_DATA_DIR ?? path.join(process.cwd(), ".mission-control", "events");
const appendQueues = new Map<string, Promise<unknown>>();
const useDynamoDb = process.env.EVENT_STORE === "dynamodb";

function eventFile(missionId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(missionId)) throw new Error("Invalid mission id");
  return path.join(DATA_DIR, `${missionId}.jsonl`);
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function readMissionEvents(missionId: string): Promise<MissionEvent[]> {
  if (useDynamoDb) return readDynamoMissionEvents(missionId);
  await ensureDataDir();
  try {
    const contents = await readFile(eventFile(missionId), "utf8");
    if (!contents.trim()) return [];
    return contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MissionEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendMissionEvent(
  missionId: string,
  template: ControlledEventTemplate,
  options: { eventId?: string; causationId?: string; occurredAt?: string } = {},
): Promise<MissionEvent> {
  if (useDynamoDb) return appendDynamoMissionEvent(missionId, template, options);
  const previous = appendQueues.get(missionId) ?? Promise.resolve();
  const pending = previous.then(async () => {
    const events = await readMissionEvents(missionId);
    if (options.eventId) {
      const duplicate = events.find((event) => event.eventId === options.eventId);
      if (duplicate) return duplicate;
    }
    const prior = events.at(-1);
    const event: MissionEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: options.eventId ?? randomUUID(),
      missionId,
      sequence: events.length + 1,
      type: template.type,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      producer: template.producer,
      correlationId: missionId,
      ...((options.causationId ?? prior?.eventId) ? { causationId: options.causationId ?? prior?.eventId } : {}),
      ...(template.subject ? { subject: template.subject } : {}),
      data: template.data,
    };
    await ensureDataDir();
    const nextContents = `${events.map((existing) => JSON.stringify(existing)).join("\n")}${events.length ? "\n" : ""}${JSON.stringify(event)}\n`;
    await writeFile(eventFile(missionId), nextContents, "utf8");
    return event;
  });
  appendQueues.set(
    missionId,
    pending.catch(() => undefined),
  );
  return pending;
}

export async function appendAgentEvent(input: AgentEventInput): Promise<MissionEvent> {
  if (input.schemaVersion !== EVENT_SCHEMA_VERSION) throw new Error("Unsupported event schema version");
  if (
    !input.eventId ||
    !input.missionId ||
    !input.type ||
    !input.occurredAt ||
    !input.producer?.id ||
    !input.data?.message
  ) {
    throw new Error("Invalid canonical agent event");
  }
  return appendMissionEvent(
    input.missionId,
    {
      type: input.type,
      producer: input.producer,
      ...(input.subject ? { subject: input.subject } : {}),
      data: input.data,
    },
    {
      eventId: input.eventId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      occurredAt: input.occurredAt,
    },
  );
}

export function getAssignments(events: MissionEvent[], agentId: string) {
  const claimedTaskIds = new Set(
    events.filter((event) => event.type === "task.claimed").map((event) => event.subject?.id),
  );
  return events.filter(
    (event) =>
      event.type === "task.assigned" &&
      event.producer.kind === "agent" &&
      event.producer.id === agentId &&
      event.subject?.kind === "task" &&
      event.data.assignment &&
      !claimedTaskIds.has(event.subject.id),
  );
}

export async function claimAssignment(
  missionId: string,
  taskId: string,
  agentId: string,
): Promise<MissionEvent | undefined> {
  const events = await readMissionEvents(missionId);
  const assignment = events.find(
    (event) => event.type === "task.assigned" && event.subject?.id === taskId && event.producer.id === agentId,
  );
  if (!assignment) return undefined;
  const claimed = events.find((event) => event.type === "task.claimed" && event.subject?.id === taskId);
  if (claimed) return claimed;
  return appendMissionEvent(
    missionId,
    {
      type: "task.claimed",
      producer: { kind: "agent", id: agentId, label: agentId === "hermes" ? "Hermes" : agentId },
      subject: { kind: "task", id: taskId },
      data: { message: "Implementation claimed", detail: "Hermes accepted the bounded assignment" },
    },
    { eventId: `${missionId}:${taskId}:claimed` },
  );
}

export async function createMission(input: {
  objective: string;
  deadline: string;
  priority: "High" | "Normal" | "Low";
}): Promise<MissionProjection> {
  const missionId = randomUUID();
  await appendMissionEvent(missionId, {
    type: "mission.created",
    producer: { kind: "human", id: "commander", label: "You" },
    subject: { kind: "mission", id: missionId },
    data: {
      message: "Mission accepted",
      detail: `${input.priority} priority · deadline ${input.deadline.toLowerCase()}`,
      objective: input.objective.trim(),
      deadline: input.deadline.trim() || "Today",
      priority: input.priority,
      commander: "Hermes",
    },
  });
  return getMissionProjection(missionId) as Promise<MissionProjection>;
}

export async function getMissionProjection(missionId: string): Promise<MissionProjection | undefined> {
  const events = await readMissionEvents(missionId);
  return events.length ? projectMission(events) : undefined;
}

export async function appendNextControlledEvent(missionId: string): Promise<MissionEvent | undefined> {
  const events = await readMissionEvents(missionId);
  if (!events.length) return undefined;
  const lastEvent = events.at(-1);
  if (lastEvent?.type === "organization.reconfigured") {
    return appendMissionEvent(
      missionId,
      {
        type: "task.assigned",
        producer: { kind: "agent", id: "hermes", label: "Hermes" },
        subject: { kind: "task", id: "task-servicepilot-pricing" },
        data: {
          message: "Implementation assigned to Codex",
          detail: "Hermes can begin the independent annual-pricing path",
          assignment: {
            objective:
              "Add the annual ServicePilot pricing option and update its validation without changing checkout preview behavior.",
            allowedPaths: ["src/pricing-plans.ts", "tests/pricing-plans.test.mjs"],
            validationCommand: "node --import tsx --test tests/pricing-plans.test.mjs",
          },
        },
      },
      { eventId: `${missionId}:task-servicepilot-pricing:assigned` },
    );
  }
  if (events.some((event) => event.subject?.id === "task-servicepilot-pricing")) return undefined;
  const nextTemplate = CONTROLLED_EVENT_TEMPLATES[events.length - 1];
  if (!nextTemplate || nextTemplate.type === "recommendation.approved") return undefined;
  return appendMissionEvent(missionId, nextTemplate, {
    eventId: `${missionId}:controlled:${events.length + 1}`,
  });
}

export async function approveRecommendation(missionId: string): Promise<MissionEvent | undefined> {
  const events = await readMissionEvents(missionId);
  const approved = events.find((event) => event.type === "recommendation.approved");
  if (approved) return approved;
  const expected = CONTROLLED_EVENT_TEMPLATES[events.length - 1];
  if (expected?.type !== "recommendation.approved") return undefined;
  return appendMissionEvent(missionId, expected, {
    eventId: `${missionId}:recommendation:approved`,
  });
}
