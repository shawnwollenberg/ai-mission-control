import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "./canonical-json";
import type { AcceptanceResourceOutcome } from "./acceptance-resource-inventory";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export type CleanupJournalEntry = Readonly<{
  schemaVersion: "acceptance-cleanup-attempt/1";
  cleanupRunId: string;
  cleanupOperationId: string;
  acceptanceRunId: string;
  inventorySha256: string;
  resourceId: string;
  expectedPriorState: string;
  attemptedAction: string;
  attempt: number;
  phase: "started" | "completed" | "terminally_verified";
  startedAt: string;
  completedAt?: string;
  outcome?: AcceptanceResourceOutcome;
  error?: string;
  previousEntrySha256: string | null;
  entrySha256: string;
}>;

export function readCleanupJournal(path: string, acceptanceRunId: string, inventorySha256: string) {
  if (!existsSync(path)) return [];
  const entries = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CleanupJournalEntry);
  let previous: string | null = null;
  for (const entry of entries) {
    const { entrySha256, ...base } = entry;
    if (
      entry.schemaVersion !== "acceptance-cleanup-attempt/1" ||
      entry.acceptanceRunId !== acceptanceRunId ||
      entry.inventorySha256 !== inventorySha256 ||
      entry.previousEntrySha256 !== previous ||
      entrySha256 !== hash(base)
    )
      throw new Error("Cleanup journal authority or hash chain changed");
    previous = entrySha256;
  }
  return entries;
}

export function appendCleanupJournal(
  path: string,
  entry: Omit<CleanupJournalEntry, "schemaVersion" | "cleanupRunId" | "previousEntrySha256" | "entrySha256"> & {
    cleanupRunId?: string;
  },
) {
  const existing = readCleanupJournal(path, entry.acceptanceRunId, entry.inventorySha256);
  const base = {
    schemaVersion: "acceptance-cleanup-attempt/1" as const,
    cleanupRunId: entry.cleanupRunId ?? randomUUID(),
    ...entry,
    previousEntrySha256: existing.at(-1)?.entrySha256 ?? null,
  };
  const record = { ...base, entrySha256: hash(base) };
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(record)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return record;
}

export function latestCompletedCleanupOutcomes(entries: readonly CleanupJournalEntry[]) {
  const outcomes = new Map<string, AcceptanceResourceOutcome>();
  for (const entry of entries)
    if (["completed", "terminally_verified"].includes(entry.phase) && entry.outcome)
      outcomes.set(entry.resourceId, entry.outcome);
  return outcomes;
}

export function nextCleanupAttempt(entries: readonly CleanupJournalEntry[], resourceId: string) {
  return entries.filter((entry) => entry.resourceId === resourceId && entry.phase === "started").length + 1;
}
