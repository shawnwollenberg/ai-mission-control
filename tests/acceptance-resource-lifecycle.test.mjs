import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { bootstrapAcceptanceRun } from "../lib/acceptance-bootstrap-authority.ts";
import { createGovernedAcceptanceResource } from "../lib/acceptance-resource-creator.ts";
import { createFinalAcceptanceRecord, sealCanonicalAcceptanceArtifact } from "../lib/acceptance-terminal-ledger.ts";
import { runAcceptanceCleanup } from "../scripts/cleanup-consensus-acceptance.ts";
import {
  appendCleanupJournal,
  latestCompletedCleanupOutcomes,
  nextCleanupAttempt,
  readCleanupJournal,
} from "../lib/acceptance-cleanup-journal.ts";
import {
  AcceptanceResourceInventory,
  assertAcceptanceCleanupAuthority,
  appendSealedRetainedArtifact,
  assertExactAcceptanceResourceReconciliation,
  extendAcceptanceResourceInventorySnapshot,
  orderAcceptanceResourcesForCleanup,
  planAcceptanceFinalizationResources,
} from "../lib/acceptance-resource-inventory.ts";
import {
  awaitBoundedProcessGroupExit,
  assertProcessSignalAuthority,
  confirmTerminalQuiescence,
  planProcessGroupCleanup,
} from "../lib/acceptance-process-cleanup.ts";

test("bounded process-group exit escalates a TERM-resistant leader", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  assert.ok(child.pid);
  await new Promise((resolveReady, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolveReady);
  });
  const leaderExit = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const started = Date.now();
  const result = await awaitBoundedProcessGroupExit({
    leaderExit,
    timeoutMs: 50,
    graceMs: 50,
    groupAlive,
    signalGroup: (signal) => process.kill(-child.pid, signal),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(groupAlive(), false);
  assert.ok(Date.now() - started < 2_000);
});

test("bounded process-group exit cancels a long deadline after fast leader exit", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  const result = await awaitBoundedProcessGroupExit({
    leaderExit: new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    timeoutMs: 60_000,
    groupAlive: () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    signalGroup: (signal) => process.kill(-child.pid, signal),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
});

const run = "00000000-0000-4000-8000-000000000060";
const now = "2026-08-07T00:00:00.000Z";
const bindings = Object.fromEntries(
  [
    "artifactSha256",
    "artifactMetadataSha256",
    "capabilityManifestSha256",
    "acceptanceSourceManifestSha256",
    "acceptanceContractSha256",
    "executableRegistrySha256",
    "disposableRegistrySha256",
    "providerRequirementsSha256",
    "providerProfilesSha256",
    "runtimeBindingsSha256",
    "modelAssignmentsSha256",
    "validatorRegistrySha256",
    "reviewChecklistSha256",
    "finalizerChecklistSha256",
    "reviewerImplementationSha256",
    "resourceInventoryImplementationSha256",
    "cleanupFinalizerSha256",
    "realAcceptanceHarnessSha256",
  ].map((key, index) => [key, (index % 10).toString(16).repeat(64)]),
);
const retentionPolicyIdentity = "f".repeat(64);

test("provider gate executes only after durable group registration and records the real child", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-provider-gate-"));
  try {
    const journal = resolve(root, "resources.ndjson");
    const go = resolve(root, "go");
    const gateFixture = resolve(root, "mission-agent-gate-fixture.mjs");
    const template = await readFile(resolve("scripts/mission-agent-080.template.mjs"), "utf8");
    await writeFile(
      gateFixture,
      template
        .replace("__MISSION_AGENT_PROVIDER_RUNTIME_REQUIREMENTS__", "{}")
        .replace("__MISSION_AGENT_PROVIDER_RUNTIME_PROFILES__", "{}")
        .replace("__MISSION_AGENT_BUILD_SOURCE_COMMIT__", "0".repeat(40)),
    );
    await writeFile(go, "go\n");
    const intent = {
      event: "provider_spawn_intent",
      registrationId: "registration-1",
      recordedAt: now,
      executionId: "execution-1",
      assignmentId: "assignment-1",
      attempt: 1,
      provider: "codex",
      model: "test-model",
      runtimeProfileId: "test-profile",
      sandboxRoot: root,
      temporaryRoot: root,
      workingDirectory: root,
      diagnosticRoot: root,
    };
    await promisify(execFile)(
      process.execPath,
      [await realpath(gateFixture), "internal-provider-gate", await realpath(go), "/usr/bin/true"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MISSION_AGENT_RESOURCE_JOURNAL: journal,
          MISSION_AGENT_PROVIDER_GATE_RECORD: Buffer.from(JSON.stringify(intent)).toString("base64url"),
        },
      },
    );
    const events = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      ["provider_resources_created", "provider_descendant_intent", "provider_descendant_created"],
    );
    assert.ok(events[0].processIdentitySha256);
    assert.ok(events[1].ownershipToken);
    assert.ok(events[2].descendantIdentitySha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative inventory accepts planned finalization resources until sealing and reconciles exact IDs", () => {
  const inventory = new AcceptanceResourceInventory(run, bindings, "a".repeat(64), now);
  inventory.register({
    resourceId: "database",
    type: "disposable_database",
    identity: { databaseName: "acceptance" },
    creatingStep: "inventory.startup",
    createdAt: now,
    cleanupPolicy: "delete",
    expectedTerminalState: "deleted",
  });
  const extended = extendAcceptanceResourceInventorySnapshot(inventory.journalSnapshot(), [
    {
      resourceId: "final-report",
      type: "final_acceptance_report",
      identity: { path: "/tmp/acceptance/final.json", planned: 1 },
      creatingStep: "finalization.report",
      createdAt: now,
      cleanupPolicy: "retain_evidence_only",
      expectedTerminalState: "retained_with_approved_reason",
      retentionPolicyIdentity,
    },
  ]);
  const outcomes = extended.resources.map((resource) => ({ resourceId: resource.resourceId }));
  assert.equal(assertExactAcceptanceResourceReconciliation({ ...extended, outcomes }), true);
  assert.throws(
    () => assertExactAcceptanceResourceReconciliation({ ...extended, outcomes: outcomes.slice(1) }),
    /reconciliation mismatch/,
  );
  assert.throws(
    () =>
      assertExactAcceptanceResourceReconciliation({ ...extended, outcomes: [...outcomes, { resourceId: "unknown" }] }),
    /reconciliation mismatch/,
  );
});

test("inventory dependency graph rejects unregistered prerequisites and duplicate resources", () => {
  const inventory = new AcceptanceResourceInventory(run, bindings, "a".repeat(64), now);
  const process = {
    resourceId: "provider",
    type: "provider_subprocess",
    identity: { pid: 42 },
    creatingStep: "provider.spawn",
    createdAt: now,
    cleanupPolicy: "stop",
    expectedTerminalState: "stopped",
    dependsOn: ["provider-group"],
  };
  assert.throws(() => inventory.register(process), /dependency/);
  inventory.register({
    ...process,
    resourceId: "provider-group",
    type: "process_group",
    identity: { pgid: 42 },
    dependsOn: [],
  });
  inventory.register(process);
  assert.throws(() => inventory.register(process), /already registered/);
});

test("executable cleanup planning stops owners before probes and removes databases before stopping services", () => {
  const record = (resourceId, type, dependsOn = []) => ({
    resourceId,
    type,
    identity: type === "listener" ? { port: 3000 } : { pid: 42 },
    creatingStep: "inventory.bootstrap",
    createdAt: now,
    cleanupPolicy: type === "disposable_database" ? "delete" : "stop",
    expectedTerminalState: type === "disposable_database" ? "deleted" : "stopped",
    dependsOn,
  });
  const ordered = orderAcceptanceResourcesForCleanup([
    record("database-service", "database_process"),
    record("database", "disposable_database", ["database-service"]),
    record("listener", "listener"),
    record("server", "mission_control_server", ["listener"]),
  ]).map((resource) => resource.resourceId);
  assert.ok(ordered.indexOf("database") < ordered.indexOf("database-service"));
  assert.ok(ordered.indexOf("server") < ordered.indexOf("listener"));
});

test("PID and PGID signaling refuses missing identity and possible PID reuse", () => {
  const expectedIdentity = "a".repeat(64);
  assert.equal(
    assertProcessSignalAuthority({
      pid: 42,
      currentPid: 999,
      expectedIdentity,
      observedIdentity: expectedIdentity,
      processKind: "process",
    }),
    true,
  );
  assert.throws(
    () =>
      assertProcessSignalAuthority({
        pid: 42,
        currentPid: 999,
        expectedIdentity,
        observedIdentity: "b".repeat(64),
        processKind: "process_group",
      }),
    /PID reuse/,
  );
  assert.throws(
    () =>
      assertProcessSignalAuthority({
        pid: 42,
        currentPid: 999,
        expectedIdentity: undefined,
        observedIdentity: expectedIdentity,
        processKind: "process",
      }),
    /identity is missing/,
  );
});

test("terminal process state requires repeated quiescence and detects a surviving descendant", async () => {
  const absent = [false, false, false];
  assert.equal(
    await confirmTerminalQuiescence(
      () => absent.shift() ?? false,
      async () => undefined,
    ),
    true,
  );
  const survivor = [false, true, false, false, false];
  assert.equal(
    await confirmTerminalQuiescence(
      () => survivor.shift() ?? false,
      async () => undefined,
    ),
    true,
  );
  assert.equal(
    await confirmTerminalQuiescence(
      () => true,
      async () => undefined,
    ),
    false,
  );
});

test("orphan process-group planning signals only exact live ownership", () => {
  const identity = "a".repeat(64);
  assert.equal(
    planProcessGroupCleanup({
      groupAlive: true,
      leaderPid: 42,
      expectedLeaderIdentity: identity,
      observedLeaderIdentity: identity,
    }).action,
    "signal_process_group",
  );
  assert.equal(
    planProcessGroupCleanup({
      groupAlive: true,
      leaderPid: 42,
      expectedLeaderIdentity: identity,
      observedLeaderIdentity: "b".repeat(64),
    }).action,
    "fail_unsafe_identity",
  );
  assert.deepEqual(
    planProcessGroupCleanup({
      groupAlive: true,
      leaderPid: 42,
      expectedLeaderIdentity: identity,
      observedLeaderIdentity: null,
      persistedDescendants: [{ pid: 43, identity }],
      observedDescendants: [{ pid: 43, identity }],
    }),
    { action: "signal_proven_descendants", pids: [43] },
  );
  assert.equal(
    planProcessGroupCleanup({
      groupAlive: true,
      leaderPid: 42,
      expectedLeaderIdentity: identity,
      observedLeaderIdentity: null,
      persistedDescendants: [{ pid: 43, identity }],
      observedDescendants: [{ pid: 43, identity: "c".repeat(64) }],
    }).action,
    "fail_unsafe_identity",
  );
  assert.equal(
    planProcessGroupCleanup({
      groupAlive: false,
      leaderPid: 42,
      expectedLeaderIdentity: identity,
      observedLeaderIdentity: null,
    }).action,
    "already_vanished",
  );
});

test("every required terminal path is governed by the outer authoritative cleanup handler", async () => {
  const source = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  assert.match(source, /main\(\)\.catch\(async \(error: unknown\)/);
  assert.match(source, /await cleanupTerminalFailure\(error\)/);
  assert.match(source, /primaryOutcome/);
  assert.match(source, /cleanupOutcome/);
  const terminalPaths = [
    "normal_success",
    "setup_failure",
    "planner_failure",
    "critique_revision_failure",
    "synthesis_failure",
    "verdict_failure",
    "approval_failure",
    "child_creation_failure",
    "executor_failure",
    "timeout",
    "cancellation",
    "lease_loss",
    "source_closure_failure",
    "review_failure",
    "cleanup_failure",
    "unexpected_exception",
  ];
  assert.equal(new Set(terminalPaths).size, 16);
});

test("finalizer seals every late evidence category in the same inventory schema", async () => {
  const source = await readFile(new URL("../scripts/finalize-consensus-real-acceptance.ts", import.meta.url), "utf8");
  for (const category of [
    "source_checkpoint_artifact",
    "review_artifact",
    "cleanup_artifact",
    "finalizer_proof_artifact",
    "final_evidence_index",
  ])
    assert.match(source, new RegExp(`\\"${category}\\"`));
  assert.match(source, /extendAcceptanceResourceInventorySnapshot/);
  assert.match(source, /appendSealedRetainedArtifact/);
  assert.match(source, /terminalInventoryLedger/);
  assert.match(source, /createFinalAcceptanceRecord/);
});

test("governed bootstrap durably creates only the inventory and evidence root before handoff", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-bootstrap-"));
  try {
    const launcher = resolve(root, "launcher.ts");
    await writeFile(launcher, "governed launcher\n");
    const launcherSha256 = createHash("sha256").update("governed launcher\n").digest("hex");
    const evidenceRoot = resolve(root, "evidence");
    const inventoryPath = resolve(evidenceRoot, "inventory.json");
    const handoff = bootstrapAcceptanceRun({
      acceptanceRunId: run,
      acceptanceRoot: root,
      evidenceRoot,
      inventoryPath,
      candidateBindings: bindings,
      launcherImplementationPath: launcher,
      expectedLauncherSha256: launcherSha256,
      infrastructureLauncherPath: launcher,
      expectedInfrastructureLauncherSha256: launcherSha256,
      infrastructureRequestSha256: "c".repeat(64),
      createdAt: now,
    });
    const snapshot = JSON.parse(await readFile(inventoryPath, "utf8"));
    assert.equal(handoff.inventorySha256, snapshot.sha256);
    assert.deepEqual(
      snapshot.resources.map((resource) => resource.resourceId),
      ["acceptance-evidence-root", "authoritative-resource-inventory"],
    );
    assert.throws(
      () => AcceptanceResourceInventory.fromJournalSnapshot({ ...snapshot, sha256: "0".repeat(64) }),
      /invalid/,
    );
    assert.equal(
      assertAcceptanceCleanupAuthority({
        acceptanceRunId: run,
        candidateBindings: snapshot.candidateBindings,
        inventory: snapshot,
      }),
      true,
    );
    assert.throws(
      () =>
        assertAcceptanceCleanupAuthority({
          acceptanceRunId: run,
          candidateBindings: { ...snapshot.candidateBindings, artifactSha256: "f".repeat(64) },
          inventory: snapshot,
        }),
      /authority binding changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap crash windows never expose a partial authoritative inventory", async () => {
  for (const crashPoint of ["afterEvidenceRootCreated", "afterInventoryPersisted"]) {
    const root = await mkdtemp(resolve(tmpdir(), `mc-bootstrap-crash-${crashPoint}-`));
    try {
      const launcher = resolve(root, "launcher.ts");
      await writeFile(launcher, "governed launcher\n");
      const request = {
        acceptanceRunId: run,
        acceptanceRoot: root,
        evidenceRoot: resolve(root, "evidence"),
        inventoryPath: resolve(root, "evidence", "inventory.json"),
        candidateBindings: bindings,
        launcherImplementationPath: launcher,
        expectedLauncherSha256: createHash("sha256").update("governed launcher\n").digest("hex"),
        infrastructureLauncherPath: launcher,
        expectedInfrastructureLauncherSha256: createHash("sha256").update("governed launcher\n").digest("hex"),
        infrastructureRequestSha256: "c".repeat(64),
        createdAt: now,
      };
      assert.throws(
        () =>
          bootstrapAcceptanceRun(request, {
            [crashPoint]: () => {
              throw new Error("simulated crash");
            },
          }),
        /simulated crash/,
      );
      const bytes = await readFile(request.inventoryPath, "utf8").catch(() => null);
      if (crashPoint === "afterEvidenceRootCreated") assert.equal(bytes, null);
      else assert.equal(AcceptanceResourceInventory.fromJournalSnapshot(JSON.parse(bytes)).resourceRecords().length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("resource reservations survive creation crashes and emergency-clean created resources on transition failure", async () => {
  const baseRecord = {
    resourceId: "fixture-worktree",
    type: "worktree",
    identity: { intendedPath: "/disposable/fixture-worktree" },
    creatingStep: "test.infrastructure",
    createdAt: now,
    cleanupPolicy: "delete",
    expectedTerminalState: "deleted",
  };
  {
    const inventory = new AcceptanceResourceInventory(run, bindings, "a".repeat(64), now);
    const persisted = [];
    await assert.rejects(
      createGovernedAcceptanceResource({
        inventory,
        record: baseRecord,
        persist: (event) => persisted.push({ event, snapshot: inventory.journalSnapshot() }),
        create: () => {
          throw new Error("simulated creation crash");
        },
        observeIdentity: () => ({}),
        emergencyCleanup: () => assert.fail("nothing was created"),
        now: () => now,
      }),
      /simulated creation crash/,
    );
    assert.deepEqual(
      persisted.map((item) => item.event),
      ["resource_creation_reserved", "resource_creation_failed"],
    );
    assert.equal(inventory.resourceRecords()[0].lifecycleState, "creation_failed");
  }
  {
    const root = await mkdtemp(resolve(tmpdir(), "mc-reservation-transition-"));
    const createdPath = resolve(root, "created");
    const inventory = new AcceptanceResourceInventory(run, bindings, "a".repeat(64), now);
    let emergencyCleanup = false;
    try {
      await assert.rejects(
        createGovernedAcceptanceResource({
          inventory,
          record: { ...baseRecord, resourceId: "created-before-transition", identity: { intendedPath: createdPath } },
          persist: (event) => {
            if (event === "resource_created") throw new Error("simulated inventory fsync failure");
          },
          create: async () => {
            await writeFile(createdPath, "created\n");
            return createdPath;
          },
          observeIdentity: (path) => ({ path }),
          emergencyCleanup: async (path) => {
            emergencyCleanup = true;
            await rm(path, { force: true });
          },
          now: () => now,
        }),
        /durable transition failed/,
      );
      assert.equal(emergencyCleanup, true);
      assert.equal(await readFile(createdPath, "utf8").catch(() => null), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("governed infrastructure launcher persists reservations before creating local infrastructure", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-infrastructure-launch-"));
  let processPid;
  try {
    const launcherPath = resolve("scripts/bootstrap-consensus-real-acceptance.ts");
    const launcherSha256 = createHash("sha256")
      .update(await readFile(launcherPath))
      .digest("hex");
    const evidenceRoot = resolve(root, "evidence");
    const inventoryPath = resolve(evidenceRoot, "inventory.json");
    const requestPath = resolve(root, "infrastructure-request.json");
    const directoryPath = resolve(root, "registry-copy");
    await writeFile(
      requestPath,
      JSON.stringify({
        bootstrapInventoryPath: inventoryPath,
        resources: [
          {
            record: {
              resourceId: "disposable-registry-copy",
              type: "registry_copy",
              identity: { intendedPath: directoryPath },
              creatingStep: "test.infrastructure.registry",
              createdAt: now,
              cleanupPolicy: "delete",
              expectedTerminalState: "deleted",
            },
            creation: { kind: "directory", path: directoryPath },
          },
          {
            record: {
              resourceId: "mission-control-server",
              type: "mission_control_server",
              identity: { executable: "/bin/sleep" },
              creatingStep: "test.infrastructure.server",
              createdAt: now,
              cleanupPolicy: "stop",
              expectedTerminalState: "stopped",
            },
            creation: { kind: "process", executable: "/bin/sleep", args: ["30"], cwd: root },
          },
        ],
      }),
    );
    const infrastructureLauncherPath = resolve("scripts/launch-consensus-acceptance-infrastructure.ts");
    const infrastructureLauncherSha256 = createHash("sha256")
      .update(await readFile(infrastructureLauncherPath))
      .digest("hex");
    const infrastructureRequestSha256 = createHash("sha256")
      .update(await readFile(requestPath))
      .digest("hex");
    bootstrapAcceptanceRun({
      acceptanceRunId: run,
      acceptanceRoot: root,
      evidenceRoot,
      inventoryPath,
      candidateBindings: bindings,
      launcherImplementationPath: launcherPath,
      expectedLauncherSha256: launcherSha256,
      infrastructureLauncherPath,
      expectedInfrastructureLauncherSha256: infrastructureLauncherSha256,
      infrastructureRequestSha256,
      createdAt: now,
    });
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", resolve("scripts/launch-consensus-acceptance-infrastructure.ts"), requestPath],
      { cwd: process.cwd() },
    );
    const snapshot = JSON.parse(await readFile(inventoryPath, "utf8"));
    const created = snapshot.resources.filter((resource) => resource.lifecycleState === "created");
    assert.equal(created.length, 4);
    processPid = created.find((resource) => resource.resourceId === "mission-control-server").identity.pid;
    assert.ok(Number.isSafeInteger(processPid));
  } finally {
    if (processPid)
      try {
        process.kill(-processPid, "SIGKILL");
      } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("abrupt launcher death after a filesystem side effect leaves a recoverable durable reservation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-infrastructure-crash-"));
  try {
    const bootstrapLauncherPath = resolve("scripts/bootstrap-consensus-real-acceptance.ts");
    const infrastructureLauncherPath = resolve("scripts/launch-consensus-acceptance-infrastructure.ts");
    const evidenceRoot = resolve(root, "evidence");
    const inventoryPath = resolve(evidenceRoot, "inventory.json");
    const createdPath = resolve(root, "created-before-transition");
    const requestPath = resolve(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        bootstrapInventoryPath: inventoryPath,
        resources: [
          {
            record: {
              resourceId: "crash-window-directory",
              type: "registry_copy",
              identity: { intendedPath: createdPath },
              creatingStep: "test.crash_window",
              createdAt: now,
              cleanupPolicy: "delete",
              expectedTerminalState: "deleted",
            },
            creation: {
              kind: "command",
              executable: "/bin/sh",
              args: ["-c", 'mkdir "$1"; sleep 2', "fixture", createdPath],
              cwd: root,
              actualIdentity: { path: createdPath },
            },
          },
        ],
      }),
    );
    const bootstrapSha256 = createHash("sha256")
      .update(await readFile(bootstrapLauncherPath))
      .digest("hex");
    const infrastructureSha256 = createHash("sha256")
      .update(await readFile(infrastructureLauncherPath))
      .digest("hex");
    bootstrapAcceptanceRun({
      acceptanceRunId: run,
      acceptanceRoot: root,
      evidenceRoot,
      inventoryPath,
      candidateBindings: bindings,
      launcherImplementationPath: bootstrapLauncherPath,
      expectedLauncherSha256: bootstrapSha256,
      infrastructureLauncherPath,
      expectedInfrastructureLauncherSha256: infrastructureSha256,
      infrastructureRequestSha256: createHash("sha256")
        .update(await readFile(requestPath))
        .digest("hex"),
      createdAt: now,
    });
    const launcher = spawn(process.execPath, ["--import", "tsx", infrastructureLauncherPath, requestPath], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !(await readFile(inventoryPath, "utf8")).includes("creation_reserved"))
      await new Promise((done) => setTimeout(done, 10));
    while (
      Date.now() < deadline &&
      !(await stat(createdPath)
        .then(() => true)
        .catch(() => false))
    )
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(
      await stat(createdPath)
        .then(() => true)
        .catch(() => false),
      true,
    );
    launcher.kill("SIGKILL");
    await new Promise((done) => launcher.once("close", done));
    const snapshot = JSON.parse(await readFile(inventoryPath, "utf8"));
    assert.equal(
      snapshot.resources.find((resource) => resource.resourceId === "crash-window-directory").lifecycleState,
      "creation_reserved",
    );
    const harnessPath = resolve(root, "crash-cleanup-harness.json");
    const cleanupPath = resolve(root, "crash-cleanup.json");
    await writeFile(
      harnessPath,
      JSON.stringify({
        workspaceId: run,
        candidateBindings: snapshot.candidateBindings,
        evidenceIndex: { sha256: "e".repeat(64) },
        runResourceInventory: snapshot,
      }),
    );
    const assertSafety = () => ({ acceptanceRoot: root, evidence: {} });
    await runAcceptanceCleanup(harnessPath, cleanupPath, { assertSafety });
    const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
    const crashOutcome = cleanup.resourceInventory.outcomes.find(
      (outcome) => outcome.resourceId === "crash-window-directory",
    );
    assert.equal(crashOutcome.state, "deleted");
    assert.equal(
      cleanup.resourceInventory.resources.find((resource) => resource.resourceId === "crash-window-directory")
        .lifecycleState,
      "creation_failed",
    );
    assert.equal(cleanup.allRunResourcesAccounted, true);
    assert.equal(await stat(`${harnessPath}.cleanup-journal.ndjson`).then(() => true), true);
    assert.equal(assertExactAcceptanceResourceReconciliation(cleanup.resourceInventory), true);
    const retryPath = resolve(root, "crash-cleanup-retry.json");
    await runAcceptanceCleanup(harnessPath, retryPath, { assertSafety });
    const retry = JSON.parse(await readFile(retryPath, "utf8"));
    assert.deepEqual(
      retry.resourceInventory.outcomes.map((outcome) => [outcome.resourceId, outcome.state]),
      cleanup.resourceInventory.outcomes.map((outcome) => [outcome.resourceId, outcome.state]),
    );
    assert.equal(
      retry.resourceInventory.outcomes.every(
        (outcome) =>
          outcome.observation.resourceTerminallyVerified === true &&
          Date.parse(outcome.observation.resourceTerminallyVerifiedAt) >=
            Date.parse(
              cleanup.resourceInventory.outcomes.find((prior) => prior.resourceId === outcome.resourceId).observation
                .resourceTerminallyVerifiedAt,
            ),
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup journal is append-only, hash-bound, and resumes completed resources", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-cleanup-journal-"));
  try {
    const path = resolve(root, "cleanup.ndjson");
    const inventorySha256 = "a".repeat(64);
    const base = {
      cleanupOperationId: "operation-1",
      acceptanceRunId: run,
      inventorySha256,
      resourceId: "server",
      expectedPriorState: "registered",
      attemptedAction: "stop",
      attempt: 1,
      startedAt: now,
    };
    appendCleanupJournal(path, { ...base, phase: "started" });
    const outcome = {
      resourceId: "server",
      acceptanceRunId: run,
      state: "stopped",
      completedAt: now,
      observation: {},
      cleanupEvidenceIdentity: "b".repeat(64),
    };
    appendCleanupJournal(path, { ...base, phase: "completed", completedAt: now, outcome });
    const entries = readCleanupJournal(path, run, inventorySha256);
    assert.equal(entries.length, 2);
    assert.equal(latestCompletedCleanupOutcomes(entries).get("server").state, "stopped");
    assert.equal(nextCleanupAttempt(entries, "server"), 2);
    const tampered = (await readFile(path, "utf8")).replace('"attempt":1', '"attempt":9');
    await writeFile(path, tampered);
    assert.throws(() => readCleanupJournal(path, run, inventorySha256), /hash chain/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup restart resumes after every dependency stage without replaying completed work", async () => {
  const stages = ["provider", "server", "listener", "database", "database-service"];
  for (let crashAfter = 0; crashAfter < stages.length; crashAfter += 1) {
    const root = await mkdtemp(resolve(tmpdir(), "mc-cleanup-restart-"));
    try {
      const path = resolve(root, "cleanup.ndjson");
      const inventorySha256 = createHash("sha256").update(stages.join(":")).digest("hex");
      for (let index = 0; index <= crashAfter; index += 1) {
        const resourceId = stages[index];
        const base = {
          cleanupOperationId: `operation-${index}`,
          acceptanceRunId: run,
          inventorySha256,
          resourceId,
          expectedPriorState: "registered",
          attemptedAction: "terminal_action",
          attempt: 1,
          startedAt: now,
        };
        appendCleanupJournal(path, { ...base, phase: "started" });
        appendCleanupJournal(path, {
          ...base,
          phase: "completed",
          completedAt: now,
          outcome: {
            resourceId,
            acceptanceRunId: run,
            state: resourceId.includes("database") && resourceId !== "database-service" ? "deleted" : "stopped",
            completedAt: now,
            observation: {},
            cleanupEvidenceIdentity: "d".repeat(64),
          },
        });
      }
      const resumed = latestCompletedCleanupOutcomes(readCleanupJournal(path, run, inventorySha256));
      assert.deepEqual([...resumed.keys()], stages.slice(0, crashAfter + 1));
      assert.deepEqual(
        stages.filter((stage) => !resumed.has(stage)),
        stages.slice(crashAfter + 1),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("planned finalization resources cannot reconcile; sealed final bytes can", () => {
  const inventory = new AcceptanceResourceInventory(run, bindings, "a".repeat(64), now);
  inventory.bindRepositorySnapshot("b".repeat(64));
  const empty = inventory.snapshot();
  const record = {
    resourceId: "review",
    type: "review_artifact",
    identity: { path: "/disposable/review.json" },
    creatingStep: "finalization.review",
    createdAt: now,
    cleanupPolicy: "retain_evidence_only",
    expectedTerminalState: "retained_with_approved_reason",
    retentionPolicyIdentity,
  };
  assert.throws(() =>
    appendSealedRetainedArtifact(empty, record, { sha256: "", size: 0, createdAt: now, sealedAt: now }),
  );
  const planned = planAcceptanceFinalizationResources(empty, [record]);
  const sealed = appendSealedRetainedArtifact(planned, record, {
    sha256: "c".repeat(64),
    size: 42,
    createdAt: now,
    sealedAt: now,
  });
  assert.equal(sealed.resources.length, 1);
  assert.equal(sealed.outcomes[0].observation.retainedArtifactSha256, "c".repeat(64));
});

test("terminal ledger seals once and the outer acceptance record anchors it without self-hashing", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-terminal-ledger-"));
  try {
    const ledgerPath = resolve(root, "terminal-ledger.json");
    const sealed = await sealCanonicalAcceptanceArtifact(ledgerPath, {
      schemaVersion: "consensus-acceptance-terminal-inventory-ledger/1",
      acceptanceRunId: run,
      resources: [],
    });
    assert.equal(
      sealed.sha256,
      createHash("sha256")
        .update(await readFile(ledgerPath))
        .digest("hex"),
    );
    const record = createFinalAcceptanceRecord({
      acceptanceRunId: run,
      candidateBindings: bindings,
      terminalInventoryLedgerPath: ledgerPath,
      terminalInventoryLedgerSha256: sealed.sha256,
      cleanupJournalTerminalSha256: "d".repeat(64),
      evidenceIndexSha256: "e".repeat(64),
      independentReviewIdentity: "f".repeat(64),
      independentReviewResult: { unresolvedHigh: 0, unresolvedMedium: 0 },
      finalSourceClosureIdentity: "1".repeat(64),
      unresolvedHighCount: 0,
      unresolvedMediumCount: 0,
      finalizedAt: now,
    });
    assert.equal(record.terminalInventoryLedgerSha256, sealed.sha256);
    assert.equal("sha256" in record, false);
    assert.throws(() => createFinalAcceptanceRecord({ ...record, unresolvedHighCount: 1 }), /gates/);
    await assert.rejects(
      sealCanonicalAcceptanceArtifact(resolve(root, "failed-ledger.json"), { run }, async () => {
        throw new Error("simulated terminal ledger fsync failure");
      }),
      /simulated terminal ledger fsync failure/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup evidence is per-resource substantive and dependency-driven", async () => {
  const source = await readFile(new URL("../scripts/cleanup-consensus-acceptance.ts", import.meta.url), "utf8");
  for (const field of [
    "resourceId",
    "resourceType",
    "expectedTerminalState",
    "observedTerminalState",
    "cleanupAction",
    "probeIdentity",
    "cleanupStartedAt",
    "cleanupCompletedAt",
    "cleanupEvidenceIdentity",
  ])
    assert.match(source, new RegExp(field));
  assert.match(source, /orderAcceptanceResourcesForCleanup/);
  assert.match(source, /cleanupSucceeded: acceptanceCleanupSucceeded/);
});
