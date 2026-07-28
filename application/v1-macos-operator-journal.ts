import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "./v1-production-runtime-identity";

export const V1_OPERATOR_JOURNAL_SCHEMA = "mission-agent-v1-operator-journal-v1";
export const V1_OPERATOR_OPERATIONS = [
  "observe",
  "request_drain",
  "verify_drain",
  "lease_intent",
  "renew_lease",
  "stage_artifact",
  "verify_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "verify_process",
  "collect_heartbeats",
  "verify_capabilities",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback",
  "release_lease",
] as const;
export type V1OperatorOperation = (typeof V1_OPERATOR_OPERATIONS)[number];

export type V1OperatorBinding = {
  authorizationId: string;
  executionId: string;
  agentId: string;
  targetArtifactSha256: string;
  priorInventorySha256: string;
  authorizationFingerprint: string;
  fencingGeneration: number;
  operatorId: string;
  missionControlDeploymentId: string;
  rollbackObligationId: string;
};

export type V1OperatorRequest = V1OperatorBinding & {
  operation: V1OperatorOperation;
  providerMutationId: string;
  sequence: number;
  requestMessageId: string;
  nonce: string;
  issuedAt: string;
  forwardExpiresAt: string;
  rollbackObligationId?: string;
  expectedJournalChecksum: string;
  requestAuthenticationTag: string;
};

export type V1OperatorJournalEntry = {
  sequence: number;
  operation: V1OperatorOperation;
  providerMutationId: string;
  requestMessageId: string;
  nonce: string;
  requestChecksum: string;
  status: "intent_recorded" | "completed" | "verification_required" | "human_intervention_required";
  providerReceiptChecksum?: string;
  recordedAt: string;
  previousEntryChecksum: string | null;
  entryChecksum: string;
};

export type V1OperatorJournal = {
  schemaVersion: typeof V1_OPERATOR_JOURNAL_SCHEMA;
  binding: V1OperatorBinding;
  entries: V1OperatorJournalEntry[];
  journalChecksum: string;
  authenticationTag: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORWARD_MUTATIONS = new Set<V1OperatorOperation>([
  "stage_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
]);
const ROLLBACK_OPERATIONS = new Set<V1OperatorOperation>([
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
  "verify_rollback",
]);

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function authenticate(value: unknown, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

export function requestPayload(request: V1OperatorRequest): Omit<V1OperatorRequest, "requestAuthenticationTag"> {
  const { requestAuthenticationTag: _tag, ...payload } = request;
  return payload;
}

export function verifyV1OperatorRequest(
  request: V1OperatorRequest,
  key: string,
  expected: V1OperatorBinding,
  now = new Date(),
  options: { allowExactIntentRecovery?: boolean } = {},
): void {
  const issuedAt = Date.parse(request.issuedAt);
  const forwardExpiresAt = Date.parse(request.forwardExpiresAt);
  if (
    !V1_OPERATOR_OPERATIONS.includes(request.operation) ||
    !UUID.test(request.authorizationId) ||
    !UUID.test(request.executionId) ||
    !UUID.test(request.agentId) ||
    !UUID.test(request.operatorId) ||
    !UUID.test(request.rollbackObligationId) ||
    !UUID.test(request.providerMutationId) ||
    !UUID.test(request.requestMessageId) ||
    !request.nonce ||
    request.sequence < 1 ||
    request.fencingGeneration < 1 ||
    !SHA256.test(request.targetArtifactSha256) ||
    !SHA256.test(request.priorInventorySha256) ||
    !SHA256.test(request.authorizationFingerprint) ||
    !SHA256.test(request.expectedJournalChecksum) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(forwardExpiresAt) ||
    (FORWARD_MUTATIONS.has(request.operation) &&
      (forwardExpiresAt <= issuedAt || forwardExpiresAt - issuedAt > 15 * 60_000)) ||
    issuedAt > now.getTime() + 60_000 ||
    (!options.allowExactIntentRecovery && now.getTime() - issuedAt > 15 * 60_000) ||
    canonicalJson(
      Object.fromEntries(Object.keys(expected).map((name) => [name, request[name as keyof V1OperatorBinding]])),
    ) !== canonicalJson(expected)
  )
    throw new Error("V1 operator request binding is malformed or contradictory.");
  const supplied = Uint8Array.from(Buffer.from(request.requestAuthenticationTag, "hex"));
  const computed = Uint8Array.from(Buffer.from(authenticate(requestPayload(request), key), "hex"));
  if (supplied.length !== computed.length || !timingSafeEqual(supplied, computed))
    throw new Error("V1 operator request authentication failed.");
  if (
    FORWARD_MUTATIONS.has(request.operation) &&
    forwardExpiresAt <= now.getTime() &&
    !options.allowExactIntentRecovery
  )
    throw new Error("V1 forward mutation authority expired.");
  if (ROLLBACK_OPERATIONS.has(request.operation) && request.rollbackObligationId !== expected.rollbackObligationId)
    throw new Error("V1 rollback operation lacks its durable obligation.");
}

export function createV1OperatorRequest(
  value: Omit<V1OperatorRequest, "requestAuthenticationTag">,
  key: string,
): V1OperatorRequest {
  return { ...value, requestAuthenticationTag: authenticate(value, key) };
}

function sealJournal(
  value: Omit<V1OperatorJournal, "journalChecksum" | "authenticationTag">,
  key: string,
): V1OperatorJournal {
  const journalChecksum = checksum(value);
  return {
    ...value,
    journalChecksum,
    authenticationTag: authenticate({ ...value, journalChecksum }, key),
  };
}

export function emptyV1OperatorJournal(binding: V1OperatorBinding, key: string): V1OperatorJournal {
  return sealJournal({ schemaVersion: V1_OPERATOR_JOURNAL_SCHEMA, binding, entries: [] }, key);
}

export function appendV1OperatorJournal(
  journal: V1OperatorJournal,
  request: V1OperatorRequest,
  status: V1OperatorJournalEntry["status"],
  key: string,
  providerReceiptChecksum?: string,
  recordedAt = new Date().toISOString(),
): V1OperatorJournal {
  verifyV1OperatorJournal(journal, key);
  if (
    canonicalJson(journal.binding) !==
    canonicalJson(
      Object.fromEntries(Object.keys(journal.binding).map((name) => [name, request[name as keyof V1OperatorBinding]])),
    )
  )
    throw new Error("V1 operator request does not match the durable journal binding.");
  const existing = journal.entries.find(
    (entry) =>
      entry.requestMessageId === request.requestMessageId ||
      entry.nonce === request.nonce ||
      entry.providerMutationId === request.providerMutationId,
  );
  const requestChecksum = checksum(requestPayload(request));
  if (existing) {
    if (
      existing.requestChecksum === requestChecksum &&
      existing.status === status &&
      existing.providerReceiptChecksum === providerReceiptChecksum
    )
      return journal;
    throw new Error("V1 operator request replay or mutation identity reuse detected.");
  }
  if (request.sequence !== journal.entries.length + 1)
    throw new Error("V1 operator request sequence is not the exact successor.");
  const previousEntryChecksum = journal.entries.at(-1)?.entryChecksum ?? null;
  const unsealed = {
    sequence: request.sequence,
    operation: request.operation,
    providerMutationId: request.providerMutationId,
    requestMessageId: request.requestMessageId,
    nonce: request.nonce,
    requestChecksum,
    status,
    ...(providerReceiptChecksum ? { providerReceiptChecksum } : {}),
    recordedAt,
    previousEntryChecksum,
  };
  const entry = { ...unsealed, entryChecksum: checksum(unsealed) };
  return sealJournal(
    { schemaVersion: V1_OPERATOR_JOURNAL_SCHEMA, binding: journal.binding, entries: [...journal.entries, entry] },
    key,
  );
}

export function completeV1OperatorJournal(
  journal: V1OperatorJournal,
  request: V1OperatorRequest,
  providerReceiptChecksum: string,
  key: string,
  recordedAt = new Date().toISOString(),
): V1OperatorJournal {
  verifyV1OperatorJournal(journal, key);
  if (!SHA256.test(providerReceiptChecksum)) throw new Error("Provider receipt checksum is malformed.");
  const index = journal.entries.findIndex(
    (entry) =>
      entry.providerMutationId === request.providerMutationId &&
      entry.requestChecksum === checksum(requestPayload(request)),
  );
  if (index < 0) throw new Error("Provider completion lacks its durable local intent.");
  const existing = journal.entries[index];
  if (existing.status === "completed" && existing.providerReceiptChecksum === providerReceiptChecksum) return journal;
  if (existing.status !== "intent_recorded" || index !== journal.entries.length - 1)
    throw new Error("Provider completion is not the current durable intent.");
  const entries = journal.entries.map((entry, entryIndex) => {
    if (entryIndex !== index) return entry;
    const { entryChecksum: _checksum, ...prior } = entry;
    const payload = {
      ...prior,
      status: "completed" as const,
      providerReceiptChecksum,
      recordedAt,
    };
    return { ...payload, entryChecksum: checksum(payload) };
  });
  return sealJournal({ schemaVersion: V1_OPERATOR_JOURNAL_SCHEMA, binding: journal.binding, entries }, key);
}

export function verifyV1OperatorJournal(journal: V1OperatorJournal, key: string): void {
  const { journalChecksum, authenticationTag, ...unsealed } = journal;
  if (
    journal.schemaVersion !== V1_OPERATOR_JOURNAL_SCHEMA ||
    checksum(unsealed) !== journalChecksum ||
    authenticate({ ...unsealed, journalChecksum }, key) !== authenticationTag
  )
    throw new Error("V1 operator journal authentication failed.");
  let previous: string | null = null;
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index]!;
    const { entryChecksum, ...payload } = entry;
    if (entry.sequence !== index + 1 || entry.previousEntryChecksum !== previous || checksum(payload) !== entryChecksum)
      throw new Error("V1 operator journal hash chain is invalid.");
    previous = entryChecksum;
  }
}

export async function readV1OperatorJournal(path: string, key: string): Promise<V1OperatorJournal | null> {
  try {
    const journal = JSON.parse(await readFile(path, "utf8")) as V1OperatorJournal;
    verifyV1OperatorJournal(journal, key);
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeV1OperatorJournal(path: string, journal: V1OperatorJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journal)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
