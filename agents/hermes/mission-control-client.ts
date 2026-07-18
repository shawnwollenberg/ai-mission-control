import { EVENT_SCHEMA_VERSION, type AgentEventInput, type MissionEvent } from "../../lib/mission-events";

export type HermesAssignment = MissionEvent & {
  type: "task.assigned";
  data: MissionEvent["data"] & { assignment: NonNullable<MissionEvent["data"]["assignment"]> };
};

export class MissionControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request(path: string, init?: RequestInit, timeoutMs = 5_000) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Mission Control request failed: ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async assignments(missionId: string): Promise<HermesAssignment[]> {
    const body = await this.request(`/api/agents/hermes/assignments?missionId=${encodeURIComponent(missionId)}`);
    return body.assignments as HermesAssignment[];
  }

  async claim(missionId: string, taskId: string): Promise<MissionEvent> {
    const body = await this.request(`/api/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ missionId, agentId: "hermes" }),
    });
    return body.event as MissionEvent;
  }

  async publish(event: Omit<AgentEventInput, "schemaVersion">): Promise<MissionEvent> {
    const body = await this.request("/api/agent-events", {
      method: "POST",
      body: JSON.stringify({ ...event, schemaVersion: EVENT_SCHEMA_VERSION }),
    });
    return body.event as MissionEvent;
  }
}
