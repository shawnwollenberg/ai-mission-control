import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { V1ProviderReceipt, V1MacOSOperatorProvider } from "./v1-macos-operator-provider";
import {
  appendV1OperatorJournal,
  completeV1OperatorJournal,
  emptyV1OperatorJournal,
  readV1OperatorJournal,
  requestPayload,
  verifyV1OperatorRequest,
  writeV1OperatorJournal,
  type V1OperatorBinding,
  type V1OperatorRequest,
} from "./v1-macos-operator-journal";
import { canonicalJson } from "./v1-production-runtime-identity";

export const V1_OPERATOR_INSTALL_PATH =
  "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs";
export const V1_OPERATOR_JOURNAL_ROOT =
  "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/journal";
export const V1_OPERATOR_LAUNCH_LABEL = "com.wallyweb.mission-agent.replacement-operator";

const MUTATIONS = new Set([
  "stage_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
  "remove_staged_artifact",
  "restore_previous_launch_configuration",
  "restore_previous_version",
]);
const HOST_OPERATIONS = new Set([
  "observe",
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
]);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const executeFile = promisify(execFile);

export type V1OperatorRuntimeBoundary = {
  executablePath: string;
  executableChecksum: string;
  expectedUid: number;
  actualUid: number;
  platform: NodeJS.Platform;
  journalPath: string;
};

export async function assertV1OperatorRuntimeBoundary(boundary: V1OperatorRuntimeBoundary): Promise<void> {
  if (
    boundary.platform !== "darwin" ||
    boundary.actualUid !== boundary.expectedUid ||
    boundary.actualUid === 0 ||
    resolve(boundary.executablePath) !== V1_OPERATOR_INSTALL_PATH ||
    !boundary.journalPath.startsWith(`${V1_OPERATOR_JOURNAL_ROOT}/`) ||
    !/^[a-f0-9]{64}$/.test(boundary.executableChecksum)
  )
    throw new Error("V1 macOS operator runtime boundary is invalid.");
  const executable = await lstat(boundary.executablePath);
  const parent = await lstat(dirname(boundary.executablePath));
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.uid !== boundary.expectedUid ||
    (executable.mode & 0o777) !== 0o500 ||
    parent.uid !== boundary.expectedUid ||
    (parent.mode & 0o077) !== 0 ||
    sha256(Uint8Array.from(await readFile(boundary.executablePath))) !== boundary.executableChecksum
  )
    throw new Error("V1 macOS operator checksum, owner, or permissions differ.");
}

export type AuthenticatedProviderReceipt = {
  receipt: V1ProviderReceipt;
  requestChecksum: string;
  intentEntryChecksum: string;
  authenticationTag: string;
};

function providerResultChecksum(receipt: V1ProviderReceipt): string {
  return sha256(
    JSON.stringify({
      providerMutationId: receipt.providerMutationId,
      operation: receipt.operation,
      observations: receipt.observations,
    }),
  );
}

function receiptAuthenticationTag(
  value: Omit<AuthenticatedProviderReceipt, "authenticationTag">,
  credentialKey: string,
): string {
  return createHmac("sha256", credentialKey).update(canonicalJson(value)).digest("hex");
}

async function writeReceipt(
  path: string,
  receipt: V1ProviderReceipt,
  requestChecksum: string,
  intentEntryChecksum: string,
  credentialKey: string,
): Promise<{ checksum: string; authenticated: AuthenticatedProviderReceipt; bytes: string }> {
  if (providerResultChecksum(receipt) !== receipt.resultChecksum)
    throw new Error("Provider receipt result checksum is invalid.");
  const unsigned = { receipt, requestChecksum, intentEntryChecksum };
  const authenticated: AuthenticatedProviderReceipt = {
    ...unsigned,
    authenticationTag: receiptAuthenticationTag(unsigned, credentialKey),
  };
  const bytes = `${JSON.stringify(authenticated)}\n`;
  const checksum = sha256(bytes);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (sha256(Uint8Array.from(await readFile(path))) !== checksum)
      throw new Error("Existing provider receipt contradicts recovered provider state.");
  }
  return { checksum, authenticated, bytes };
}

async function readReceipt(
  path: string,
  request: V1OperatorRequest,
  requestChecksum: string,
  intentEntryChecksum: string,
  credentialKey: string,
): Promise<{
  receipt: V1ProviderReceipt;
  checksum: string;
  authenticated: AuthenticatedProviderReceipt;
  bytes: string;
} | null> {
  try {
    const bytes = await readFile(path);
    const authenticated = JSON.parse(bytes.toString("utf8")) as AuthenticatedProviderReceipt;
    const { authenticationTag, ...unsigned } = authenticated;
    const supplied = Uint8Array.from(Buffer.from(authenticationTag ?? "", "hex"));
    const computed = Uint8Array.from(Buffer.from(receiptAuthenticationTag(unsigned, credentialKey), "hex"));
    const receipt = authenticated.receipt;
    if (
      supplied.length !== computed.length ||
      !timingSafeEqual(supplied, computed) ||
      authenticated.requestChecksum !== requestChecksum ||
      authenticated.intentEntryChecksum !== intentEntryChecksum ||
      receipt.providerMutationId !== request.providerMutationId ||
      receipt.operation !== request.operation ||
      !/^[a-f0-9]{64}$/.test(receipt.resultChecksum) ||
      providerResultChecksum(receipt) !== receipt.resultChecksum
    )
      throw new Error("Existing provider receipt is unauthenticated or contradicts the authorized operation.");
    return { receipt, checksum: sha256(Uint8Array.from(bytes)), authenticated, bytes: bytes.toString("utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withOperatorLock<T>(journalPath: string, callback: () => Promise<T>): Promise<T> {
  const lockPath = `${journalPath}.lock`;
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = await open(`${lockPath}/owner`, "wx", 0o600);
      try {
        await owner.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            uid: process.getuid?.() ?? -1,
            processStartIdentity: await processStartIdentity(process.pid),
          })}\n`,
        );
        await owner.sync();
      } finally {
        await owner.close();
      }
      const directory = await open(dirname(lockPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      try {
        return await callback();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      const owner = JSON.parse(await readFile(`${lockPath}/owner`, "utf8")) as {
        pid?: number;
        uid?: number;
        processStartIdentity?: string;
      };
      if (owner.uid !== (process.getuid?.() ?? -1) || !Number.isSafeInteger(owner.pid) || !owner.processStartIdentity)
        throw new Error("Operator lock ownership is contradictory.");
      try {
        const observedStartIdentity = await processStartIdentity(owner.pid!);
        if (observedStartIdentity === owner.processStartIdentity)
          throw new Error("Another v1 operator process holds the execution lock.");
      } catch (probe) {
        if (
          (probe as Error).message === "Another v1 operator process holds the execution lock." ||
          !["ESRCH", "ENOENT"].includes((probe as NodeJS.ErrnoException).code ?? "")
        )
          throw probe;
      }
      await rm(lockPath, { recursive: true });
    }
  }
  throw new Error("V1 operator lock could not be acquired.");
}

async function processStartIdentity(pid: number): Promise<string> {
  process.kill(pid, 0);
  const result = await executeFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024,
  });
  const value = result.stdout.trim();
  if (!value) throw Object.assign(new Error("Process is no longer running."), { code: "ESRCH" });
  return sha256(`${pid}:${value}`);
}

export async function executeV1OperatorRequest(input: {
  request: V1OperatorRequest;
  expectedBinding: V1OperatorBinding;
  credentialKey: string;
  boundary: V1OperatorRuntimeBoundary;
  provider: V1MacOSOperatorProvider;
  confirmWithControlPlane(input: {
    request: V1OperatorRequest;
    requestChecksum: string;
    journalChecksum: string;
  }): Promise<{ accepted: true; currentJournalChecksum: string }>;
  now?: Date;
  /** Acceptance seam; the packaged CLI never supplies this override. */
  assertRuntimeBoundary?: (boundary: V1OperatorRuntimeBoundary) => Promise<void>;
  /** Crash-boundary acceptance seam; the packaged CLI never supplies this callback. */
  afterProviderExecuted?: (receipt: V1ProviderReceipt) => Promise<void>;
  /** Crash-boundary acceptance seam; the packaged CLI never supplies this callback. */
  afterReceiptPersisted?: (receiptChecksum: string) => Promise<void>;
}): Promise<{
  disposition: "completed" | "receipt_recovered";
  receiptChecksum: string;
  providerReceipt: AuthenticatedProviderReceipt;
  receiptBytes: string;
  operatorJournalChecksum: string;
  localJournalEntryId: string;
}> {
  const { request, expectedBinding, credentialKey, boundary, provider } = input;
  if (!HOST_OPERATIONS.has(request.operation))
    throw new Error(`Control-plane operation ${request.operation} is not a host-provider operation.`);
  await (input.assertRuntimeBoundary ?? assertV1OperatorRuntimeBoundary)(boundary);
  return withOperatorLock(boundary.journalPath, async () => {
    let journal =
      (await readV1OperatorJournal(boundary.journalPath, credentialKey)) ??
      emptyV1OperatorJournal(expectedBinding, credentialKey);
    const expectedRequestChecksum = sha256(canonicalJson(requestPayload(request)));
    const existing = journal.entries.find((entry) => entry.providerMutationId === request.providerMutationId);
    const exactDurableIntent =
      existing !== undefined &&
      existing.requestChecksum === expectedRequestChecksum &&
      ["intent_recorded", "completed"].includes(existing.status);
    verifyV1OperatorRequest(request, credentialKey, expectedBinding, input.now, {
      allowExactIntentRecovery: exactDurableIntent,
    });
    if (
      journal.journalChecksum !== request.expectedJournalChecksum &&
      existing?.requestChecksum !== expectedRequestChecksum
    )
      throw new Error("V1 operator journal does not match the controller's monotonic head.");
    if (existing?.status === "completed" && existing.requestChecksum !== expectedRequestChecksum)
      throw new Error("Completed provider mutation ID was reused by a contradictory request.");
    if (!existing) {
      journal = appendV1OperatorJournal(journal, request, "intent_recorded", credentialKey);
      await writeV1OperatorJournal(boundary.journalPath, journal);
    }
    const requestChecksum = sha256(canonicalJson(request));
    const confirmation = await input.confirmWithControlPlane({
      request,
      requestChecksum,
      journalChecksum: journal.journalChecksum,
    });
    if (confirmation.accepted !== true || confirmation.currentJournalChecksum !== journal.journalChecksum)
      throw new Error("Mission Control did not confirm the exact operator journal head.");
    if (existing?.status === "completed" && existing.providerReceiptChecksum) {
      const recoveredReceipt = await readReceipt(
        `${dirname(boundary.journalPath)}/receipts/${request.providerMutationId}.json`,
        request,
        expectedRequestChecksum,
        existing.entryChecksum,
        credentialKey,
      );
      if (!recoveredReceipt) throw new Error("Completed journal entry lacks its durable provider receipt.");
      return {
        disposition: "receipt_recovered",
        receiptChecksum: recoveredReceipt.checksum,
        providerReceipt: recoveredReceipt.authenticated,
        receiptBytes: recoveredReceipt.bytes,
        operatorJournalChecksum: journal.journalChecksum,
        localJournalEntryId: existing.localJournalEntryId,
      };
    }
    const intent = journal.entries.find(
      (entry) =>
        entry.providerMutationId === request.providerMutationId && entry.requestChecksum === expectedRequestChecksum,
    );
    if (!intent) throw new Error("Provider operation lacks its durable authenticated intent.");
    const receiptPath = `${dirname(boundary.journalPath)}/receipts/${request.providerMutationId}.json`;
    const durableReceipt = await readReceipt(
      receiptPath,
      request,
      expectedRequestChecksum,
      intent.entryChecksum,
      credentialKey,
    );
    if (durableReceipt) {
      journal = completeV1OperatorJournal(journal, request, durableReceipt.checksum, credentialKey);
      await writeV1OperatorJournal(boundary.journalPath, journal);
      return {
        disposition: "receipt_recovered",
        receiptChecksum: durableReceipt.checksum,
        providerReceipt: durableReceipt.authenticated,
        receiptBytes: durableReceipt.bytes,
        operatorJournalChecksum: journal.journalChecksum,
        localJournalEntryId: intent.localJournalEntryId,
      };
    }
    const state = await provider.inspect(request);
    if (state === "ambiguous") throw new Error("Provider state is ambiguous; human intervention is required.");
    let receipt: V1ProviderReceipt;
    let disposition: "completed" | "receipt_recovered";
    if (!MUTATIONS.has(request.operation)) {
      receipt = await provider.execute(request);
      disposition = "completed";
    } else if (state === "postcondition") {
      receipt = await provider.verify(request);
      disposition = "receipt_recovered";
    } else {
      receipt = await provider.execute(request);
      disposition = "completed";
    }
    await input.afterProviderExecuted?.(receipt);
    const persistedReceipt = await writeReceipt(
      receiptPath,
      receipt,
      expectedRequestChecksum,
      intent.entryChecksum,
      credentialKey,
    );
    await input.afterReceiptPersisted?.(persistedReceipt.checksum);
    journal = completeV1OperatorJournal(journal, request, persistedReceipt.checksum, credentialKey);
    await writeV1OperatorJournal(boundary.journalPath, journal);
    return {
      disposition,
      receiptChecksum: persistedReceipt.checksum,
      providerReceipt: persistedReceipt.authenticated,
      receiptBytes: persistedReceipt.bytes,
      operatorJournalChecksum: journal.journalChecksum,
      localJournalEntryId: intent.localJournalEntryId,
    };
  });
}
