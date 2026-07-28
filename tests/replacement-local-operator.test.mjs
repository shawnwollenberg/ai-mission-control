import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReplacementAuthorizationPackage } from "../integrations/mission-agent/replacement-authorization-package.ts";
import {
  executeLocalReplacement,
  inspectLocalReplacementPackage,
} from "../application/replacement-bootstrap-local-operator.ts";
import {
  initialLocalJournal,
  reconcileLocalJournalWithLedger,
  readLocalJournal,
  sealLocalJournal,
  writeLocalJournalAtomic,
} from "../application/replacement-bootstrap-local-journal.ts";
import {
  fixedConditionChecksum,
  replacementForwardOperations,
} from "../application/replacement-bootstrap-state-machine.ts";
import { key, unsigned } from "./replacement-authorization-package.test.mjs";

async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-replacement-"));
  const packagePath = join(root, "authorization.json");
  const journalPath = join(root, "journal.json");
  const pkg = createReplacementAuthorizationPackage({ unsigned, credentialSigningKey: key });
  await writeFile(packagePath, `${JSON.stringify(pkg)}\n`, { mode: 0o600 });
  const operationsSeen = [];
  const completedMutations = new Set();
  const operations = {
    async inspectHost() {},
    async inspectMutation({ operation }) {
      return completedMutations.has(operation) ? "postcondition" : "precondition";
    },
    async execute({ operation }) {
      operationsSeen.push(operation);
      if (options.failAt === operation) throw new Error(`injected ${operation}`);
      completedMutations.add(operation);
      return {
        startedAt: "2026-07-28T00:00:00.000Z",
        completedAt: "2026-07-28T00:00:01.000Z",
        safeStdoutSummary: `${operation} passed`,
        inspectedChecksums: { inspected: "1".repeat(64) },
        changedChecksums: operation.includes("replace") ? { changed: "2".repeat(64) } : {},
      };
    },
  };
  let nextSequence = options.nextSequence ?? 1;
  const consumed = new Set();
  const controlPlane = {
    async claim() {
      if (options.claimed) throw new Error("authorization already claimed");
      return { claimed: true, nextSequence: 1, claimGeneration: 1 };
    },
    async createMutationIntent() {
      return { intentChecksum: "9".repeat(64), retryPolicy: "inspect-then-once" };
    },
    async recoveryState() {
      return (
        options.recoveryState ?? {
          state: "claimed",
          lastAcceptedSequence: 0,
          lastAcceptedOperation: null,
          pendingIntent: null,
        }
      );
    },
    async beginRollback() {
      return { rollbackRequired: true, nextOperation: "restore_artifact" };
    },
    async submitReceipt(receipt) {
      if (consumed.has(receipt.receiptNonce) || receipt.sequence !== nextSequence) throw new Error("receipt replay");
      consumed.add(receipt.receiptNonce);
      nextSequence += 1;
      return { accepted: true, nextSequence };
    },
    async awaitSmokeDecision() {
      return { decision: options.smokeDecision ?? "continue", smokeEvidenceChecksum: "3".repeat(64) };
    },
  };
  return {
    root,
    pkg,
    packagePath,
    journalPath,
    operations,
    operationsSeen,
    completedMutations,
    controlPlane,
  };
}

test("local dry run authenticates and inspects without mutation", async () => {
  const context = await setup();
  const result = await inspectLocalReplacementPackage({
    packagePath: context.packagePath,
    credentialSigningKey: key,
    now: new Date("2026-07-28T00:00:00.000Z"),
    operations: context.operations,
  });
  assert.equal(result.mutationPerformed, false);
  assert.deepEqual(context.operationsSeen, []);
});

test("local operator completes fixed ordered operations and one-use ledger", async () => {
  const context = await setup();
  const result = await executeLocalReplacement({
    packagePath: context.packagePath,
    journalPath: context.journalPath,
    credentialSigningKey: key,
    operations: context.operations,
    controlPlane: context.controlPlane,
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(result.disposition, "completed");
  assert.equal(result.receipts.at(-1).operation, "report_evidence");
  assert.equal(new Set(result.receipts.map((item) => item.receiptNonce)).size, result.receipts.length);
  const journal = await readLocalJournal(context.journalPath, context.pkg, key);
  assert.equal(journal.phase, "completed");
});

test("post-switch failure and smoke rejection restore exact prior service once", async () => {
  for (const options of [{ failAt: "verify_heartbeats" }, { smokeDecision: "rollback" }]) {
    const context = await setup(options);
    const result = await executeLocalReplacement({
      packagePath: context.packagePath,
      journalPath: context.journalPath,
      credentialSigningKey: key,
      operations: context.operations,
      controlPlane: context.controlPlane,
      now: new Date("2026-07-28T00:00:00.000Z"),
    });
    assert.equal(result.disposition, "rolled_back");
    assert.deepEqual(
      result.receipts.slice(-9).map((item) => item.operation),
      [
        "restore_artifact",
        "restore_plist",
        "restart_prior_service",
        "verify_prior_runtime",
        "verify_prior_identity",
        "verify_prior_heartbeats",
        "verify_prior_capabilities",
        "verify_prior_projection",
        "report_evidence",
      ],
    );
  }
});

test("package and operation replay, corrupt journal, and pre-mutation failure halt", async () => {
  const claimed = await setup({ claimed: true });
  await assert.rejects(
    () =>
      executeLocalReplacement({
        packagePath: claimed.packagePath,
        journalPath: claimed.journalPath,
        credentialSigningKey: key,
        operations: claimed.operations,
        controlPlane: claimed.controlPlane,
        now: new Date("2026-07-28T00:00:00.000Z"),
      }),
    /already claimed/i,
  );
  const early = await setup({ failAt: "stage_node_archive" });
  await assert.rejects(
    () =>
      executeLocalReplacement({
        packagePath: early.packagePath,
        journalPath: early.journalPath,
        credentialSigningKey: key,
        operations: early.operations,
        controlPlane: early.controlPlane,
        now: new Date("2026-07-28T00:00:00.000Z"),
      }),
    /injected/i,
  );
  assert.equal(early.operationsSeen.includes("restore_artifact"), false);
  const corrupt = await setup();
  await writeFile(corrupt.journalPath, JSON.stringify({ corrupt: true }));
  await assert.rejects(() => readLocalJournal(corrupt.journalPath, corrupt.pkg, key), /missing or unknown/i);
});

test("journal and authoritative ledger reconcile interruption boundaries fail closed", async () => {
  const context = await setup();
  const base = initialLocalJournal(context.pkg);
  const prepared = sealLocalJournal(
    {
      ...base,
      phase: "executing",
      lastCompletedOperation: "stage_target_plist",
      nextPermittedOperation: "verify_target_plist",
      receiptSequence: 11,
    },
    key,
  );
  assert.equal(
    reconcileLocalJournalWithLedger({
      journal: prepared,
      ledgerSequence: 11,
      ledgerLastOperation: "stage_target_plist",
      authorizationExpired: false,
    }).action,
    "resume",
  );
  assert.equal(
    reconcileLocalJournalWithLedger({
      journal: prepared,
      ledgerSequence: 12,
      ledgerLastOperation: "verify_target_plist",
      authorizationExpired: false,
    }).action,
    "advance_journal",
  );
  for (const nextPermittedOperation of ["stop_service", "replace_artifact", "replace_plist", "start_service"]) {
    const journal = sealLocalJournal({ ...prepared, nextPermittedOperation }, key);
    assert.equal(
      reconcileLocalJournalWithLedger({
        journal,
        ledgerSequence: journal.receiptSequence,
        ledgerLastOperation: journal.lastCompletedOperation,
        authorizationExpired: false,
      }).action,
      "rollback",
    );
  }
  assert.equal(
    reconcileLocalJournalWithLedger({
      journal: prepared,
      ledgerSequence: 15,
      ledgerLastOperation: "start_service",
      authorizationExpired: false,
    }).action,
    "halt",
  );
  assert.equal(
    reconcileLocalJournalWithLedger({
      journal: prepared,
      ledgerSequence: 11,
      ledgerLastOperation: "stage_target_plist",
      authorizationExpired: true,
    }).action,
    "halt",
  );
});

test("receipt loss after every forward mutation recovers from postcondition without executing twice", async () => {
  const mutations = replacementForwardOperations.filter((operation) =>
    ["extract_node_runtime", "stop_service", "replace_artifact", "replace_plist", "start_service"].includes(operation),
  );
  for (const operation of mutations) {
    const sequence = replacementForwardOperations.indexOf(operation) + 1;
    const operationId = "77777777-7777-4777-8777-777777777777";
    const pendingPostconditionChecksum = fixedConditionChecksum({
      operation,
      condition: "postcondition",
      authorizationFingerprint: unsigned.authorizationFingerprint,
    });
    const context = await setup({
      nextSequence: sequence,
      recoveryState: {
        state: `intent:${operation}`,
        lastAcceptedSequence: sequence - 1,
        lastAcceptedOperation: sequence > 1 ? replacementForwardOperations[sequence - 2] : null,
        pendingIntent: {
          operationId,
          operation,
          sequence,
          retryPolicy: operation === "extract_node_runtime" ? "inspect-then-once" : "never",
          expectedPostconditionChecksum: pendingPostconditionChecksum,
        },
      },
    });
    context.completedMutations.add(operation);
    const base = initialLocalJournal(context.pkg);
    await writeLocalJournalAtomic(
      context.journalPath,
      {
        ...base,
        phase: "executing",
        lastCompletedOperation: sequence > 1 ? replacementForwardOperations[sequence - 2] : null,
        nextPermittedOperation: operation,
        receiptSequence: sequence - 1,
        pendingOperationId: operationId,
        pendingOperation: operation,
        pendingIntentChecksum: "8".repeat(64),
        pendingPreconditionChecksum: fixedConditionChecksum({
          operation,
          condition: "precondition",
          authorizationFingerprint: unsigned.authorizationFingerprint,
        }),
        pendingPostconditionChecksum,
        pendingMutationPhase: "post-observed",
      },
      key,
    );
    const result = await executeLocalReplacement({
      packagePath: context.packagePath,
      journalPath: context.journalPath,
      credentialSigningKey: key,
      operations: context.operations,
      controlPlane: context.controlPlane,
      now: new Date("2026-07-28T00:00:00.000Z"),
    });
    assert.equal(result.disposition, "completed");
    assert.equal(context.operationsSeen.filter((seen) => seen === operation).length, 0);
    assert.equal(result.receipts.find((item) => item.operation === operation)?.recovery, true);
  }
});

test("rollback obligation remains monotonic through later read-only verification and smoke wait", async () => {
  const recoveryPoints = [
    ["verify_runtime", "verify_version", "executing"],
    ["verify_version", "verify_identity", "executing"],
    ["verify_identity", "verify_registration", "executing"],
    ["verify_registration", "verify_heartbeats", "executing"],
    ["verify_heartbeats", "verify_capabilities", "executing"],
    ["verify_capabilities", "report_evidence", "awaiting_smoke"],
  ];
  for (const [lastCompletedOperation, nextPermittedOperation, phase] of recoveryPoints) {
    const receiptSequence = replacementForwardOperations.indexOf(lastCompletedOperation) + 1;
    const context = await setup({
      nextSequence: receiptSequence + 1,
      recoveryState: {
        state: phase === "awaiting_smoke" ? "awaiting-authoritative-smoke" : `ready:${nextPermittedOperation}`,
        lastAcceptedSequence: receiptSequence,
        lastAcceptedOperation: lastCompletedOperation,
        pendingIntent: null,
      },
    });
    const base = initialLocalJournal(context.pkg);
    await writeLocalJournalAtomic(
      context.journalPath,
      {
        ...base,
        phase,
        lastCompletedOperation,
        nextPermittedOperation,
        receiptSequence,
        rollbackObligationCreated: true,
      },
      key,
    );
    const result = await executeLocalReplacement({
      packagePath: context.packagePath,
      journalPath: context.journalPath,
      credentialSigningKey: key,
      operations: context.operations,
      controlPlane: context.controlPlane,
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    assert.equal(result.disposition, "rolled_back");
    assert.equal(result.receipts[0]?.operation, "restore_artifact");
  }
});

test("restart adopts a centrally committed intent missing from the local journal", async () => {
  const operation = "extract_node_runtime";
  const sequence = replacementForwardOperations.indexOf(operation) + 1;
  const operationId = "88888888-8888-4888-8888-888888888888";
  const context = await setup({
    nextSequence: sequence,
    recoveryState: {
      state: `intent:${operation}`,
      lastAcceptedSequence: sequence - 1,
      lastAcceptedOperation: replacementForwardOperations[sequence - 2],
      pendingIntent: {
        operationId,
        operation,
        sequence,
        retryPolicy: "inspect-then-once",
        intentChecksum: "8".repeat(64),
        expectedPostconditionChecksum: fixedConditionChecksum({
          operation,
          condition: "postcondition",
          authorizationFingerprint: unsigned.authorizationFingerprint,
        }),
      },
    },
  });
  context.completedMutations.add(operation);
  const base = initialLocalJournal(context.pkg);
  await writeLocalJournalAtomic(
    context.journalPath,
    {
      ...base,
      phase: "executing",
      lastCompletedOperation: replacementForwardOperations[sequence - 2],
      nextPermittedOperation: operation,
      receiptSequence: sequence - 1,
    },
    key,
  );
  const result = await executeLocalReplacement({
    packagePath: context.packagePath,
    journalPath: context.journalPath,
    credentialSigningKey: key,
    operations: context.operations,
    controlPlane: context.controlPlane,
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(result.disposition, "completed");
  assert.equal(context.operationsSeen.filter((seen) => seen === operation).length, 0);
});

test("restart adopts authoritative rollback after the local rollback-journal write was lost", async () => {
  const receiptSequence = replacementForwardOperations.indexOf("verify_runtime") + 1;
  const context = await setup({
    nextSequence: receiptSequence + 1,
    recoveryState: {
      state: "rollback-required",
      lastAcceptedSequence: receiptSequence,
      lastAcceptedOperation: "verify_runtime",
      pendingIntent: null,
    },
  });
  const base = initialLocalJournal(context.pkg);
  await writeLocalJournalAtomic(
    context.journalPath,
    {
      ...base,
      phase: "executing",
      lastCompletedOperation: "verify_runtime",
      nextPermittedOperation: "verify_version",
      receiptSequence,
      rollbackObligationCreated: true,
    },
    key,
  );
  const result = await executeLocalReplacement({
    packagePath: context.packagePath,
    journalPath: context.journalPath,
    credentialSigningKey: key,
    operations: context.operations,
    controlPlane: context.controlPlane,
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(result.disposition, "rolled_back");
  assert.equal(result.receipts[0]?.operation, "restore_artifact");
  assert.equal(context.operationsSeen.includes("verify_version"), false);
});

test("unexpired restart rolls back when later verification fails after an accepted mutation", async () => {
  const receiptSequence = replacementForwardOperations.indexOf("verify_runtime") + 1;
  const context = await setup({
    failAt: "verify_version",
    nextSequence: receiptSequence + 1,
    recoveryState: {
      state: "ready:verify_version",
      lastAcceptedSequence: receiptSequence,
      lastAcceptedOperation: "verify_runtime",
      pendingIntent: null,
    },
  });
  const base = initialLocalJournal(context.pkg);
  await writeLocalJournalAtomic(
    context.journalPath,
    {
      ...base,
      phase: "executing",
      lastCompletedOperation: "verify_runtime",
      nextPermittedOperation: "verify_version",
      receiptSequence,
      rollbackObligationCreated: true,
    },
    key,
  );
  const result = await executeLocalReplacement({
    packagePath: context.packagePath,
    journalPath: context.journalPath,
    credentialSigningKey: key,
    operations: context.operations,
    controlPlane: context.controlPlane,
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(result.disposition, "rolled_back");
  assert.equal(result.receipts[0]?.operation, "restore_artifact");
});
