import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArchitectDecision, EngineerReport } from "../routing/contracts";

export type ProviderFailureCode =
  | "CODEX_AUTHENTICATION_EXPIRED"
  | "CODEX_USAGE_LIMIT_REACHED"
  | "PROVIDER_THREAD_UNAVAILABLE"
  | "PROVIDER_OUTPUT_INVALID"
  | "PROVIDER_PROCESS_FAILED"
  | "PROVIDER_DISPATCH_INDETERMINATE"
  | "MISSION_SOURCE_CHANGED"
  | "GITHUB_UNAVAILABLE";

export type ProviderFailure = {
  code: ProviderFailureCode;
  message: string;
  actor: "ENGINEER" | "ARCHITECT";
  revision: number;
  occurredAt: string;
};

export type InFlightDispatch = {
  idempotencyKey: string;
  actor: "ENGINEER" | "ARCHITECT";
  revision: number;
  result?: EngineerReport | ArchitectDecision;
  providerThreadId?: string;
};

export type MissionBinding = {
  missionId: string;
  projectId: string;
  issueNumber: number;
  sourceMissionDigest?: string;
  codexThreadId?: string;
  architectThreadId?: string;
  architectResponseId?: string;
  lastProcessedRevision: number;
  inFlight?: InFlightDispatch;
  failure?: ProviderFailure;
};

export interface BindingStore {
  get(missionId: string): Promise<MissionBinding | undefined>;
  put(binding: MissionBinding): Promise<void>;
  list(): Promise<MissionBinding[]>;
  update(missionId: string, mutate: (current?: MissionBinding) => MissionBinding): Promise<MissionBinding>;
}

export class MemoryBindingStore implements BindingStore {
  private values = new Map<string, MissionBinding>();
  async get(missionId: string) {
    return this.values.get(missionId);
  }
  async put(binding: MissionBinding) {
    this.values.set(binding.missionId, structuredClone(binding));
  }
  async list() {
    return Array.from(this.values.values(), (value) => structuredClone(value));
  }
  async update(missionId: string, mutate: (current?: MissionBinding) => MissionBinding) {
    const next = mutate(this.values.get(missionId));
    this.values.set(missionId, structuredClone(next));
    return structuredClone(next);
  }
}

export class JsonBindingStore implements BindingStore {
  private static queues = new Map<string, Promise<void>>();
  constructor(private readonly path: string) {}
  async get(missionId: string) {
    return (await this.read())[missionId];
  }
  async list() {
    return Object.values(await this.read());
  }
  async put(binding: MissionBinding) {
    await this.update(binding.missionId, () => binding);
  }
  async update(missionId: string, mutate: (current?: MissionBinding) => MissionBinding) {
    return this.exclusive(async () => {
      const values = await this.read();
      const next = mutate(values[missionId]);
      values[missionId] = next;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return next;
    });
  }
  private async read(): Promise<Record<string, MissionBinding>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, MissionBinding>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = JsonBindingStore.queues.get(this.path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    JsonBindingStore.queues.set(
      this.path,
      previous.then(() => current),
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
