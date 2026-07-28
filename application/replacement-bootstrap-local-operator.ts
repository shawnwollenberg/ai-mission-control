import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import {
  verifyReplacementAuthorizationPackage,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import {
  initialLocalJournal,
  localReplacementOperations,
  readLocalJournal,
  sealLocalJournal,
  writeLocalJournalAtomic,
  type LocalReplacementJournalUnsigned,
  type LocalReplacementOperation,
} from "./replacement-bootstrap-local-journal";
import {
  REPLACEMENT_PROVIDER,
  fixedConditionChecksum,
  fixedOperationChecksum,
  replacementOperationDefinitions,
} from "./replacement-bootstrap-state-machine";

export const LOCAL_OPERATOR_VERSION = "mission-agent-local-replacement-bootstrap-v1" as const;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type LocalOperationReceiptUnsigned = {
  receiptVersion: "1";
  authorizationId: string;
  executionId: string;
  credentialId: string;
  agentId: string;
  providerIdentifier: typeof REPLACEMENT_PROVIDER;
  authorizationFingerprint: string;
  claimGeneration: 1;
  operationId: string;
  operation: LocalReplacementOperation;
  sequence: number;
  requestNonce: string;
  receiptNonce: string;
  operationChecksum: string;
  resultChecksum: string;
  hostJournalChecksum: string;
  recovery: boolean;
  observation: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string;
  status: "succeeded";
  safeStdoutSummary: string;
  safeStderrSummary: "";
  inspectedChecksums: Record<string, string>;
  changedChecksums: Record<string, string>;
};
export type LocalOperationReceipt = LocalOperationReceiptUnsigned & {
  receiptChecksum: string;
  authentication: string;
};

export interface LocalFixedOperations {
  inspectHost(pkg: ReplacementAuthorizationPackage): Promise<void>;
  inspectMutation(input: {
    operation: LocalReplacementOperation;
    pkg: ReplacementAuthorizationPackage;
  }): Promise<"precondition" | "postcondition" | "partial" | "ambiguous">;
  execute(input: {
    operation: LocalReplacementOperation;
    operationId: string;
    pkg: ReplacementAuthorizationPackage;
  }): Promise<{
    startedAt: string;
    completedAt: string;
    safeStdoutSummary: string;
    inspectedChecksums: Record<string, string>;
    changedChecksums: Record<string, string>;
    observation?: Record<string, unknown>;
  }>;
}

export interface ReplacementControlPlane {
  claim(input: {
    pkg: ReplacementAuthorizationPackage;
    packageChecksum: string;
  }): Promise<{ claimed: true; nextSequence: 1; claimGeneration: 1 }>;
  createMutationIntent(input: {
    authorizationId: string;
    executionId: string;
    credentialId: string;
    agentId: string;
    providerIdentifier: typeof REPLACEMENT_PROVIDER;
    authorizationFingerprint: string;
    claimGeneration: 1;
    operationId: string;
    operation: LocalReplacementOperation;
    sequence: number;
    fixedArgumentsChecksum: string;
    expectedPreconditionChecksum: string;
    expectedPostconditionChecksum: string;
  }): Promise<{ intentChecksum: string; retryPolicy: "inspect-then-once" | "never" }>;
  recoveryState(input: {
    authorizationId: string;
    executionId: string;
    authorizationFingerprint: string;
    claimGeneration: 1;
  }): Promise<{
    state: string;
    lastAcceptedSequence: number;
    lastAcceptedOperation: LocalReplacementOperation | null;
    pendingIntent: {
      operationId: string;
      operation: LocalReplacementOperation;
      sequence: number;
      retryPolicy: "inspect-then-once" | "never";
      intentChecksum: string;
      expectedPostconditionChecksum: string;
    } | null;
  }>;
  beginRollback(input: {
    authorizationId: string;
    executionId: string;
    authorizationFingerprint: string;
    claimGeneration: 1;
    failureChecksum: string;
  }): Promise<{ rollbackRequired: true; nextOperation: "restore_artifact" }>;
  submitReceipt(receipt: LocalOperationReceipt): Promise<{ accepted: true; nextSequence: number }>;
  awaitSmokeDecision(input: {
    authorizationId: string;
    executionId: string;
  }): Promise<{ decision: "continue" | "rollback"; smokeEvidenceChecksum: string }>;
}

const forwardOperations: readonly LocalReplacementOperation[] = [
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
] as const;
const rollbackOperations: readonly LocalReplacementOperation[] = [
  "restore_artifact",
  "restore_plist",
  "restart_prior_service",
  "verify_prior_runtime",
  "verify_prior_identity",
  "verify_prior_heartbeats",
  "verify_prior_capabilities",
  "verify_prior_projection",
] as const;

function receipt(input: {
  pkg: ReplacementAuthorizationPackage;
  credentialSigningKey: string;
  operation: LocalReplacementOperation;
  operationId: string;
  sequence: number;
  requestNonce: string;
  resultChecksum: string;
  hostJournalChecksum: string;
  recovery: boolean;
  result: Awaited<ReturnType<LocalFixedOperations["execute"]>>;
}): LocalOperationReceipt {
  const unsigned: LocalOperationReceiptUnsigned = {
    receiptVersion: "1",
    authorizationId: input.pkg.authorization.authorizationId,
    executionId: input.pkg.executionId,
    credentialId: input.pkg.credentialId,
    agentId: input.pkg.authorization.agentId,
    providerIdentifier: REPLACEMENT_PROVIDER,
    authorizationFingerprint: input.pkg.authorizationFingerprint,
    claimGeneration: 1,
    operationId: input.operationId,
    operation: input.operation,
    sequence: input.sequence,
    requestNonce: input.requestNonce,
    receiptNonce: randomBytes(24).toString("base64url"),
    operationChecksum: fixedOperationChecksum({
      operation: input.operation,
      authorizationFingerprint: input.pkg.authorizationFingerprint,
      executionId: input.pkg.executionId,
      claimGeneration: 1,
    }),
    resultChecksum: input.resultChecksum,
    hostJournalChecksum: input.hostJournalChecksum,
    recovery: input.recovery,
    observation: input.result.observation ?? null,
    startedAt: input.result.startedAt,
    completedAt: input.result.completedAt,
    status: "succeeded",
    safeStdoutSummary: input.result.safeStdoutSummary,
    safeStderrSummary: "",
    inspectedChecksums: input.result.inspectedChecksums,
    changedChecksums: input.result.changedChecksums,
  };
  const bytes = canonicalJson(unsigned);
  return {
    ...unsigned,
    receiptChecksum: sha256(bytes),
    authentication: createHmac("sha256", input.credentialSigningKey).update(bytes).digest("hex"),
  };
}

function nextOperation(operation: LocalReplacementOperation): LocalReplacementOperation {
  if (operation === "verify_capabilities") return "report_evidence";
  const all = [...forwardOperations, ...rollbackOperations, "report_evidence"] as LocalReplacementOperation[];
  const index = all.indexOf(operation);
  return all[index + 1] ?? "report_evidence";
}

export async function inspectLocalReplacementPackage(input: {
  packagePath: string;
  credentialSigningKey: string;
  now?: Date;
  operations: LocalFixedOperations;
}): Promise<{
  operatorVersion: typeof LOCAL_OPERATOR_VERSION;
  packageChecksum: string;
  authorizationId: string;
  agentId: string;
  expiresAt: string;
  mutationPerformed: false;
}> {
  const pkg = verifyReplacementAuthorizationPackage({
    value: JSON.parse(await readFile(input.packagePath, "utf8")),
    credentialSigningKey: input.credentialSigningKey,
    now: input.now,
  });
  await input.operations.inspectHost(pkg);
  return {
    operatorVersion: LOCAL_OPERATOR_VERSION,
    packageChecksum: pkg.packageChecksum,
    authorizationId: pkg.authorization.authorizationId,
    agentId: pkg.authorization.agentId,
    expiresAt: pkg.expiresAt,
    mutationPerformed: false,
  };
}

export async function executeLocalReplacement(input: {
  packagePath: string;
  journalPath: string;
  credentialSigningKey: string;
  operations: LocalFixedOperations;
  controlPlane: ReplacementControlPlane;
  now?: Date;
}): Promise<{
  disposition: "completed" | "rolled_back";
  receipts: LocalOperationReceipt[];
  evidenceChecksum: string;
}> {
  if (process.platform !== "darwin") throw new Error("The local replacement operator requires macOS.");
  const pkg = verifyReplacementAuthorizationPackage({
    value: JSON.parse(await readFile(input.packagePath, "utf8")),
    credentialSigningKey: input.credentialSigningKey,
    now: input.now,
    allowExpiredRecovery: true,
  });
  const expired = Date.parse(pkg.expiresAt) <= (input.now ?? new Date()).getTime();
  const existing = await readLocalJournal(input.journalPath, pkg, input.credentialSigningKey);
  if (existing && ["completed", "rolled_back"].includes(existing.phase))
    throw new Error("The local replacement authorization is already terminal.");
  let journal: LocalReplacementJournalUnsigned;
  if (existing) {
    const authoritative = await input.controlPlane.recoveryState({
      authorizationId: pkg.authorization.authorizationId,
      executionId: pkg.executionId,
      authorizationFingerprint: pkg.authorizationFingerprint,
      claimGeneration: 1,
    });
    if (authoritative.state === "rollback-required" || authoritative.state.startsWith("rollback:")) {
      const rollbackOperation = authoritative.state.startsWith("rollback:")
        ? (authoritative.state.slice("rollback:".length) as LocalReplacementOperation)
        : "restore_artifact";
      if (
        ![
          "restore_artifact",
          "restore_plist",
          "restart_prior_service",
          "verify_prior_runtime",
          "verify_prior_identity",
          "verify_prior_heartbeats",
          "verify_prior_capabilities",
          "verify_prior_projection",
          "report_evidence",
        ].includes(rollbackOperation)
      )
        throw new Error("Mission Control returned an invalid rollback recovery state.");
      journal = {
        ...existing,
        phase: "rolling_back",
        nextPermittedOperation: rollbackOperation,
        receiptSequence: authoritative.lastAcceptedSequence,
        lastCompletedOperation: authoritative.lastAcceptedOperation,
        pendingOperationId: null,
        pendingOperation: null,
        pendingIntentChecksum: null,
        pendingPreconditionChecksum: null,
        pendingPostconditionChecksum: null,
        pendingMutationPhase: "none",
        rollbackObligationCreated: true,
      };
      await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    } else if (authoritative.lastAcceptedSequence === existing.receiptSequence + 1) {
      if (
        authoritative.lastAcceptedOperation !== existing.pendingOperation &&
        authoritative.lastAcceptedOperation !== existing.nextPermittedOperation
      )
        throw new Error("Mission Control recovery state does not match the prepared local operation.");
      const completed = authoritative.lastAcceptedOperation;
      if (!completed) throw new Error("Mission Control advanced without a durable operation.");
      journal = {
        ...existing,
        lastCompletedOperation: completed,
        nextPermittedOperation: nextOperation(completed),
        receiptSequence: authoritative.lastAcceptedSequence,
        pendingOperationId: null,
        pendingOperation: null,
        pendingIntentChecksum: null,
        pendingPreconditionChecksum: null,
        pendingPostconditionChecksum: null,
        pendingMutationPhase: "none",
      };
      await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    } else if (authoritative.lastAcceptedSequence === existing.receiptSequence) {
      if (!existing.pendingOperation && authoritative.pendingIntent) {
        const pending = authoritative.pendingIntent;
        const definition = replacementOperationDefinitions[pending.operation];
        const expectedPreconditionChecksum = fixedConditionChecksum({
          operation: pending.operation,
          condition: "precondition",
          authorizationFingerprint: pkg.authorizationFingerprint,
        });
        const expectedPostconditionChecksum = fixedConditionChecksum({
          operation: pending.operation,
          condition: "postcondition",
          authorizationFingerprint: pkg.authorizationFingerprint,
        });
        if (
          !definition?.mutating ||
          pending.operation !== existing.nextPermittedOperation ||
          pending.sequence !== existing.receiptSequence + 1 ||
          pending.retryPolicy !== (definition.retrySafe ? "inspect-then-once" : "never") ||
          pending.expectedPostconditionChecksum !== expectedPostconditionChecksum ||
          !/^[a-f0-9]{64}$/.test(pending.intentChecksum)
        )
          throw new Error("Authoritative pending intent cannot be adopted safely.");
        journal = {
          ...existing,
          phase: "executing",
          pendingOperationId: pending.operationId,
          pendingOperation: pending.operation,
          pendingIntentChecksum: pending.intentChecksum,
          pendingPreconditionChecksum: expectedPreconditionChecksum,
          pendingPostconditionChecksum: expectedPostconditionChecksum,
          pendingMutationPhase: "intent-committed",
          rollbackObligationCreated: existing.rollbackObligationCreated || definition.createsRollbackObligation,
        };
        await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
      } else {
        if (
          existing.pendingOperation &&
          (!authoritative.pendingIntent ||
            authoritative.pendingIntent.operationId !== existing.pendingOperationId ||
            authoritative.pendingIntent.operation !== existing.pendingOperation ||
            authoritative.pendingIntent.sequence !== existing.receiptSequence + 1)
        )
          throw new Error("Pending host mutation does not match the committed Mission Control intent.");
        journal = existing;
      }
    } else {
      throw new Error("Local journal and Mission Control ledger cannot be reconciled safely.");
    }
  } else {
    if (expired) throw new Error("An expired replacement package cannot begin a new execution.");
    await input.operations.inspectHost(pkg);
    const claim = await input.controlPlane.claim({ pkg, packageChecksum: pkg.packageChecksum });
    if (claim.claimGeneration !== 1) throw new Error("Mission Control returned an unsupported claim generation.");
    journal = initialLocalJournal(pkg);
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
  }
  const receipts: LocalOperationReceipt[] = [];

  if (expired && journal.phase !== "rolling_back") {
    const mutationMayHaveOccurred = journal.rollbackObligationCreated || journal.pendingOperation !== null;
    if (!mutationMayHaveOccurred) throw new Error("Expired replacement recovery has no rollback obligation.");
    const failureChecksum = sha256(
      canonicalJson({
        authorizationId: pkg.authorization.authorizationId,
        executionId: pkg.executionId,
        phase: journal.phase,
        lastCompletedOperation: journal.lastCompletedOperation,
        pendingOperation: journal.pendingOperation,
        errorClass: "ExpiredReplacementRecovery",
      }),
    );
    await input.controlPlane.beginRollback({
      authorizationId: pkg.authorization.authorizationId,
      executionId: pkg.executionId,
      authorizationFingerprint: pkg.authorizationFingerprint,
      claimGeneration: 1,
      failureChecksum,
    });
    journal = {
      ...journal,
      phase: "rolling_back",
      nextPermittedOperation: "restore_artifact",
    };
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
  }

  const run = async (operation: LocalReplacementOperation) => {
    if (!localReplacementOperations.includes(operation) || journal.nextPermittedOperation !== operation)
      throw new Error("Local replacement attempted an unlisted or out-of-order operation.");
    const sequence = journal.receiptSequence + 1;
    const recoveringPendingIntent = journal.pendingOperation === operation;
    const operationId = recoveringPendingIntent ? journal.pendingOperationId! : randomUUID();
    const definition = replacementOperationDefinitions[operation];
    const preconditionChecksum = fixedConditionChecksum({
      operation,
      condition: "precondition",
      authorizationFingerprint: pkg.authorizationFingerprint,
    });
    const postconditionChecksum = fixedConditionChecksum({
      operation,
      condition: "postcondition",
      authorizationFingerprint: pkg.authorizationFingerprint,
    });
    let intentChecksum: string | null = null;
    if (definition.mutating && !recoveringPendingIntent) {
      const intent = await input.controlPlane.createMutationIntent({
        authorizationId: pkg.authorization.authorizationId,
        executionId: pkg.executionId,
        credentialId: pkg.credentialId,
        agentId: pkg.authorization.agentId,
        providerIdentifier: REPLACEMENT_PROVIDER,
        authorizationFingerprint: pkg.authorizationFingerprint,
        claimGeneration: 1,
        operationId,
        operation,
        sequence,
        fixedArgumentsChecksum: fixedOperationChecksum({
          operation,
          authorizationFingerprint: pkg.authorizationFingerprint,
          executionId: pkg.executionId,
          claimGeneration: 1,
        }),
        expectedPreconditionChecksum: preconditionChecksum,
        expectedPostconditionChecksum: postconditionChecksum,
      });
      intentChecksum = intent.intentChecksum;
      journal = {
        ...journal,
        phase: "executing",
        nextPermittedOperation: operation,
        pendingOperationId: operationId,
        pendingOperation: operation,
        pendingIntentChecksum: intentChecksum,
        pendingPreconditionChecksum: preconditionChecksum,
        pendingPostconditionChecksum: postconditionChecksum,
        pendingMutationPhase: "intent-committed",
        rollbackObligationCreated: journal.rollbackObligationCreated || definition.createsRollbackObligation,
      };
      await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
      const observed = await input.operations.inspectMutation({ operation, pkg });
      if (observed === "partial" || observed === "ambiguous")
        throw new Error(`Mutation ${operation} has partial or ambiguous host state.`);
      if (observed === "precondition" && !definition.retrySafe && recoveringPendingIntent)
        throw new Error(`Non-retry-safe mutation ${operation} requires governed rollback after interruption.`);
      journal = { ...journal, pendingMutationPhase: observed === "postcondition" ? "post-observed" : "pre-observed" };
      await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    } else if (!definition.mutating) {
      journal = { ...journal, phase: "executing", nextPermittedOperation: operation };
      await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    }
    const observedBefore = definition.mutating
      ? await input.operations.inspectMutation({ operation, pkg })
      : "precondition";
    if (observedBefore === "partial" || observedBefore === "ambiguous")
      throw new Error(`Mutation ${operation} has partial or ambiguous host state and requires governed rollback.`);
    if (recoveringPendingIntent && observedBefore === "precondition" && !definition.retrySafe)
      throw new Error(`Interrupted non-retry-safe mutation ${operation} requires governed rollback.`);
    const recovery = observedBefore === "postcondition";
    const result = recovery
      ? {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          safeStdoutSummary: `Recovered ${operation} from verified postcondition without repeating mutation`,
          safeStderrSummary: "" as const,
          inspectedChecksums: { postcondition: postconditionChecksum },
          changedChecksums: {},
        }
      : await input.operations.execute({ operation, operationId, pkg });
    if (definition.mutating) {
      const observedAfter = await input.operations.inspectMutation({ operation, pkg });
      if (observedAfter !== "postcondition")
        throw new Error(`Mutation ${operation} did not reach its exact postcondition.`);
      journal = { ...journal, pendingMutationPhase: "post-observed" };
      await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    }
    const requestNonce = randomBytes(24).toString("base64url");
    const sealed = sealLocalJournal(journal, input.credentialSigningKey);
    const operationReceipt = receipt({
      pkg,
      credentialSigningKey: input.credentialSigningKey,
      operation,
      operationId,
      sequence,
      requestNonce,
      resultChecksum: definition.mutating ? postconditionChecksum : sha256(canonicalJson(result)),
      hostJournalChecksum: sealed.journalChecksum,
      recovery,
      result,
    });
    let acknowledgement: { accepted: true; nextSequence: number };
    try {
      acknowledgement = await input.controlPlane.submitReceipt(operationReceipt);
    } catch (error) {
      const authoritative = await input.controlPlane.recoveryState({
        authorizationId: pkg.authorization.authorizationId,
        executionId: pkg.executionId,
        authorizationFingerprint: pkg.authorizationFingerprint,
        claimGeneration: 1,
      });
      if (authoritative.lastAcceptedSequence !== sequence || authoritative.lastAcceptedOperation !== operation)
        throw error;
      acknowledgement = { accepted: true, nextSequence: sequence + 1 };
    }
    if (!acknowledgement.accepted || acknowledgement.nextSequence !== sequence + 1)
      throw new Error("Mission Control operation-ledger acknowledgement mismatch.");
    receipts.push(operationReceipt);
    journal = {
      ...journal,
      lastCompletedOperation: operation,
      nextPermittedOperation: nextOperation(operation),
      receiptSequence: sequence,
      pendingOperationId: null,
      pendingOperation: null,
      pendingIntentChecksum: null,
      pendingPreconditionChecksum: null,
      pendingPostconditionChecksum: null,
      pendingMutationPhase: "none",
    };
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
  };

  const finishRollback = async () => {
    const rollbackIndex = rollbackOperations.indexOf(journal.nextPermittedOperation);
    if (rollbackIndex < 0) throw new Error("Rollback journal does not identify an exact recoverable operation.");
    for (const operation of rollbackOperations.slice(rollbackIndex)) await run(operation);
    await run("report_evidence");
    journal = { ...journal, phase: "rolled_back" };
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    const evidenceChecksum = sha256(canonicalJson(receipts));
    return { disposition: "rolled_back" as const, receipts, evidenceChecksum };
  };

  try {
    if (journal.phase === "rolling_back") return await finishRollback();
    const startingIndex = forwardOperations.indexOf(journal.nextPermittedOperation);
    if (startingIndex < 0 && journal.phase !== "awaiting_smoke")
      throw new Error("Local journal does not identify a valid forward recovery point.");
    for (const operation of forwardOperations.slice(Math.max(0, startingIndex))) await run(operation);
    journal = { ...journal, phase: "awaiting_smoke" };
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    const decision = await input.controlPlane.awaitSmokeDecision({
      authorizationId: pkg.authorization.authorizationId,
      executionId: pkg.executionId,
    });
    if (!/^[a-f0-9]{64}$/.test(decision.smokeEvidenceChecksum))
      throw new Error("Mission Control smoke decision evidence is invalid.");
    if (decision.decision === "rollback") throw new Error("Mission Control required rollback after smoke.");
    await run("report_evidence");
    journal = { ...journal, phase: "completed" };
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    const evidenceChecksum = sha256(canonicalJson(receipts));
    return { disposition: "completed", receipts, evidenceChecksum };
  } catch (error) {
    if (journal.phase === "rolling_back") throw error;
    const mutated =
      journal.rollbackObligationCreated ||
      journal.pendingOperation !== null ||
      receipts.some((item) =>
        ["stop_service", "replace_artifact", "replace_plist", "start_service"].includes(item.operation),
      );
    if (!mutated) throw error;
    const failureChecksum = sha256(
      canonicalJson({
        authorizationId: pkg.authorization.authorizationId,
        executionId: pkg.executionId,
        phase: journal.phase,
        lastCompletedOperation: journal.lastCompletedOperation,
        pendingOperation: journal.pendingOperation,
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      }),
    );
    await input.controlPlane.beginRollback({
      authorizationId: pkg.authorization.authorizationId,
      executionId: pkg.executionId,
      authorizationFingerprint: pkg.authorizationFingerprint,
      claimGeneration: 1,
      failureChecksum,
    });
    journal = { ...journal, phase: "rolling_back", nextPermittedOperation: "restore_artifact" };
    await writeLocalJournalAtomic(input.journalPath, journal, input.credentialSigningKey);
    return await finishRollback();
  }
}
