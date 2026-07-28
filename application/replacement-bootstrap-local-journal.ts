import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import type { ReplacementAuthorizationPackage } from "../integrations/mission-agent/replacement-authorization-package";

export const localReplacementOperations = [
  "inspect_host",
  "inspect_agent",
  "inventory_configuration",
  "verify_rollback_assets",
  "stage_node_archive",
  "verify_node_archive",
  "extract_node_runtime",
  "verify_node_executable",
  "stage_target_artifact",
  "verify_release",
  "stage_target_plist",
  "verify_target_plist",
  "drain_agent",
  "stop_service",
  "replace_artifact",
  "replace_plist",
  "start_service",
  "verify_runtime",
  "verify_version",
  "verify_identity",
  "verify_registration",
  "verify_heartbeats",
  "verify_capabilities",
  "restore_artifact",
  "restore_plist",
  "restart_prior_service",
  "verify_prior_runtime",
  "verify_prior_identity",
  "verify_prior_heartbeats",
  "verify_prior_capabilities",
  "verify_prior_projection",
  "report_evidence",
] as const;
export type LocalReplacementOperation = (typeof localReplacementOperations)[number];

export type LocalReplacementJournalUnsigned = {
  journalVersion: "1";
  authorizationId: string;
  authorizationFingerprint: string;
  nonce: string;
  agentId: string;
  hostIdentity: string;
  currentArtifactSha256: string;
  targetArtifactSha256: string;
  nodeArchiveSha256: string;
  nodeExecutableSha256: string;
  currentPlistSha256: string;
  targetPlistSha256: string;
  rollbackPlistSha256: string;
  lastCompletedOperation: LocalReplacementOperation | null;
  nextPermittedOperation: LocalReplacementOperation;
  pendingOperationId: string | null;
  pendingOperation: LocalReplacementOperation | null;
  pendingIntentChecksum: string | null;
  pendingPreconditionChecksum: string | null;
  pendingPostconditionChecksum: string | null;
  pendingMutationPhase: "none" | "intent-committed" | "pre-observed" | "post-observed";
  rollbackObligationCreated: boolean;
  missionControlExecutionId: string;
  receiptSequence: number;
  phase: "prepared" | "executing" | "awaiting_smoke" | "completed" | "rolling_back" | "rolled_back";
};
export type LocalReplacementJournal = LocalReplacementJournalUnsigned & {
  journalChecksum: string;
  authentication: string;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const unsignedKeys = [
  "journalVersion",
  "authorizationId",
  "authorizationFingerprint",
  "nonce",
  "agentId",
  "hostIdentity",
  "currentArtifactSha256",
  "targetArtifactSha256",
  "nodeArchiveSha256",
  "nodeExecutableSha256",
  "currentPlistSha256",
  "targetPlistSha256",
  "rollbackPlistSha256",
  "lastCompletedOperation",
  "nextPermittedOperation",
  "pendingOperationId",
  "pendingOperation",
  "pendingIntentChecksum",
  "pendingPreconditionChecksum",
  "pendingPostconditionChecksum",
  "pendingMutationPhase",
  "rollbackObligationCreated",
  "missionControlExecutionId",
  "receiptSequence",
  "phase",
] as const;

export function initialLocalJournal(pkg: ReplacementAuthorizationPackage): LocalReplacementJournalUnsigned {
  const authorization = pkg.authorization;
  return {
    journalVersion: "1",
    authorizationId: authorization.authorizationId,
    authorizationFingerprint: pkg.authorizationFingerprint,
    nonce: pkg.nonce,
    agentId: authorization.agentId,
    hostIdentity: authorization.hostIdentity,
    currentArtifactSha256: authorization.currentArtifactSha256,
    targetArtifactSha256: authorization.targetArtifactSha256,
    nodeArchiveSha256: authorization.nodeRuntime.archiveSha256,
    nodeExecutableSha256: authorization.nodeRuntime.executableSha256,
    currentPlistSha256: authorization.serviceReplacement.currentDefinitionSha256,
    targetPlistSha256: authorization.serviceReplacement.targetDefinitionSha256,
    rollbackPlistSha256: authorization.serviceReplacement.rollbackDefinitionSha256,
    lastCompletedOperation: null,
    nextPermittedOperation: "inspect_host",
    pendingOperationId: null,
    pendingOperation: null,
    pendingIntentChecksum: null,
    pendingPreconditionChecksum: null,
    pendingPostconditionChecksum: null,
    pendingMutationPhase: "none",
    rollbackObligationCreated: false,
    missionControlExecutionId: pkg.executionId,
    receiptSequence: 0,
    phase: "prepared",
  };
}

export function sealLocalJournal(
  unsigned: LocalReplacementJournalUnsigned,
  credentialSigningKey: string,
): LocalReplacementJournal {
  if (!/^[a-f0-9]{64}$/.test(credentialSigningKey)) throw new Error("Local journal credential key is invalid.");
  const bytes = canonicalJson(unsigned);
  return {
    ...unsigned,
    journalChecksum: sha256(bytes),
    authentication: createHmac("sha256", credentialSigningKey).update(bytes).digest("hex"),
  };
}

export function verifyLocalJournal(input: {
  value: unknown;
  pkg: ReplacementAuthorizationPackage;
  credentialSigningKey: string;
}): LocalReplacementJournal {
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value))
    throw new Error("Local replacement journal is malformed.");
  const value = input.value as LocalReplacementJournal;
  if (
    canonicalJson(Object.keys(value).sort()) !==
    canonicalJson([...unsignedKeys, "journalChecksum", "authentication"].sort())
  )
    throw new Error("Local replacement journal contains missing or unknown fields.");
  const { journalChecksum, authentication, ...unsigned } = value;
  const bytes = canonicalJson(unsigned);
  const expectedChecksum = sha256(bytes);
  const expectedAuthentication = createHmac("sha256", input.credentialSigningKey).update(bytes).digest("hex");
  if (
    !/^[a-f0-9]{64}$/.test(journalChecksum) ||
    !/^[a-f0-9]{64}$/.test(authentication) ||
    !timingSafeEqual(
      Uint8Array.from(Buffer.from(journalChecksum, "hex")),
      Uint8Array.from(Buffer.from(expectedChecksum, "hex")),
    ) ||
    !timingSafeEqual(
      Uint8Array.from(Buffer.from(authentication, "hex")),
      Uint8Array.from(Buffer.from(expectedAuthentication, "hex")),
    ) ||
    unsigned.authorizationId !== input.pkg.authorization.authorizationId ||
    unsigned.authorizationFingerprint !== input.pkg.authorizationFingerprint ||
    unsigned.nonce !== input.pkg.nonce ||
    unsigned.missionControlExecutionId !== input.pkg.executionId ||
    unsigned.agentId !== input.pkg.authorization.agentId ||
    unsigned.hostIdentity !== input.pkg.authorization.hostIdentity ||
    !localReplacementOperations.includes(unsigned.nextPermittedOperation) ||
    (unsigned.pendingOperation !== null && !localReplacementOperations.includes(unsigned.pendingOperation)) ||
    !["none", "intent-committed", "pre-observed", "post-observed"].includes(unsigned.pendingMutationPhase) ||
    typeof unsigned.rollbackObligationCreated !== "boolean" ||
    (unsigned.pendingOperationId !== null &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(unsigned.pendingOperationId)) ||
    [unsigned.pendingIntentChecksum, unsigned.pendingPreconditionChecksum, unsigned.pendingPostconditionChecksum].some(
      (value) => value !== null && !/^[a-f0-9]{64}$/.test(value),
    ) ||
    (unsigned.pendingMutationPhase === "none" &&
      [unsigned.pendingOperationId, unsigned.pendingOperation, unsigned.pendingIntentChecksum].some(
        (value) => value !== null,
      )) ||
    (unsigned.lastCompletedOperation !== null &&
      !localReplacementOperations.includes(unsigned.lastCompletedOperation)) ||
    !Number.isSafeInteger(unsigned.receiptSequence) ||
    unsigned.receiptSequence < 0
  )
    throw new Error("Local replacement journal authentication or binding failed.");
  return value;
}

export async function writeLocalJournalAtomic(
  path: string,
  unsigned: LocalReplacementJournalUnsigned,
  credentialSigningKey: string,
): Promise<LocalReplacementJournal> {
  const value = sealLocalJournal(unsigned, credentialSigningKey);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return value;
}

export async function readLocalJournal(
  path: string,
  pkg: ReplacementAuthorizationPackage,
  credentialSigningKey: string,
): Promise<LocalReplacementJournal | null> {
  try {
    return verifyLocalJournal({
      value: JSON.parse(await readFile(path, "utf8")),
      pkg,
      credentialSigningKey,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const nonIdempotentOperations: readonly LocalReplacementOperation[] = [
  "stop_service",
  "replace_artifact",
  "replace_plist",
  "start_service",
] as const;

export function reconcileLocalJournalWithLedger(input: {
  journal: LocalReplacementJournal;
  ledgerSequence: number;
  ledgerLastOperation: LocalReplacementOperation | null;
  authorizationExpired: boolean;
}): {
  action: "resume" | "advance_journal" | "rollback" | "halt";
  operation?: LocalReplacementOperation;
  reason: string;
} {
  if (!Number.isSafeInteger(input.ledgerSequence) || input.ledgerSequence < 0)
    return { action: "halt", reason: "Mission Control ledger sequence is invalid." };
  if (["completed", "rolled_back"].includes(input.journal.phase))
    return { action: "halt", reason: "Local journal is terminal." };
  if (input.ledgerSequence === input.journal.receiptSequence + 1 && input.ledgerLastOperation) {
    if (input.ledgerLastOperation !== input.journal.nextPermittedOperation)
      return { action: "halt", reason: "Mission Control ledger operation is not the locally prepared operation." };
    return {
      action: "advance_journal",
      operation: input.ledgerLastOperation,
      reason: "Mission Control durably consumed the receipt before the local journal acknowledgement update.",
    };
  }
  if (input.ledgerSequence !== input.journal.receiptSequence)
    return { action: "halt", reason: "Local journal and Mission Control ledger differ by more than one receipt." };
  if (
    input.journal.phase === "rolling_back" ||
    nonIdempotentOperations.includes(input.journal.nextPermittedOperation) ||
    nonIdempotentOperations.includes(input.journal.lastCompletedOperation as LocalReplacementOperation)
  )
    return {
      action: "rollback",
      reason: "A non-idempotent host boundary is ambiguous; exact rollback is required.",
    };
  if (input.authorizationExpired)
    return { action: "halt", reason: "Authorization expired before the next forward operation." };
  return {
    action: "resume",
    operation: input.journal.nextPermittedOperation,
    reason: "The next fixed operation is idempotent and has no consumed ledger receipt.",
  };
}
