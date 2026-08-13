import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { canonicalJson } from "./canonical-json";

export async function sealCanonicalAcceptanceArtifact(
  path: string,
  value: Record<string, unknown>,
  writer: (path: string, bytes: string) => Promise<void> = async (target, bytes) => {
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  },
) {
  const bytes = `${canonicalJson(value)}\n`;
  await writer(path, bytes);
  return Object.freeze({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: Buffer.byteLength(bytes),
  });
}

export function createFinalAcceptanceRecord(args: {
  acceptanceRunId: string;
  candidateBindings: Record<string, unknown>;
  terminalInventoryLedgerPath: string;
  terminalInventoryLedgerSha256: string;
  cleanupJournalTerminalSha256: string;
  evidenceIndexSha256: string;
  independentReviewIdentity: string;
  independentReviewResult: Record<string, unknown>;
  finalSourceClosureIdentity: string;
  unresolvedHighCount: number;
  unresolvedMediumCount: number;
  finalizedAt: string;
}) {
  if (
    !/^[a-f0-9]{64}$/.test(args.terminalInventoryLedgerSha256) ||
    !/^[a-f0-9]{64}$/.test(args.cleanupJournalTerminalSha256) ||
    args.unresolvedHighCount !== 0 ||
    args.unresolvedMediumCount !== 0
  )
    throw new Error("Final acceptance record success gates are not satisfied");
  return Object.freeze({
    schemaVersion: "consensus-final-acceptance-record/1",
    acceptanceRunId: args.acceptanceRunId,
    candidateBindings: args.candidateBindings,
    acceptanceContractSha256: args.candidateBindings.acceptanceContractSha256,
    executableRegistrySha256: args.candidateBindings.executableRegistrySha256,
    validatorRegistrySha256: args.candidateBindings.validatorRegistrySha256,
    terminalInventoryLedgerPath: args.terminalInventoryLedgerPath,
    terminalInventoryLedgerSha256: args.terminalInventoryLedgerSha256,
    cleanupJournalTerminalSha256: args.cleanupJournalTerminalSha256,
    evidenceIndexSha256: args.evidenceIndexSha256,
    independentReviewIdentity: args.independentReviewIdentity,
    independentReviewResult: args.independentReviewResult,
    finalSourceClosureIdentity: args.finalSourceClosureIdentity,
    acceptanceOutcome: "passed",
    unresolvedHighCount: args.unresolvedHighCount,
    unresolvedMediumCount: args.unresolvedMediumCount,
    finalizedAt: args.finalizedAt,
  });
}
