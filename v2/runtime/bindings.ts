import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type MissionBinding = {
  missionId: string;
  projectId: string;
  issueNumber: number;
  codexThreadId?: string;
  architectResponseId?: string;
  lastProcessedRevision: number;
  inFlight?: { idempotencyKey: string; actor: "ENGINEER" | "ARCHITECT"; revision: number };
};

export interface BindingStore {
  get(missionId: string): Promise<MissionBinding | undefined>;
  put(binding: MissionBinding): Promise<void>;
  list(): Promise<MissionBinding[]>;
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
}

export class JsonBindingStore implements BindingStore {
  constructor(private readonly path: string) {}
  async get(missionId: string) {
    return (await this.read())[missionId];
  }
  async list() {
    return Object.values(await this.read());
  }
  async put(binding: MissionBinding) {
    const values = await this.read();
    values[binding.missionId] = binding;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
  private async read(): Promise<Record<string, MissionBinding>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, MissionBinding>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}
