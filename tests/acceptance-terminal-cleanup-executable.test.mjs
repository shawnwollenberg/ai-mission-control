import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  AcceptanceResourceInventory,
  adoptPersistedAcceptanceInventoryForTerminalCleanup,
  assertExactAcceptanceResourceReconciliation,
} from "../lib/acceptance-resource-inventory.ts";
import { waitForAcceptanceServerReadiness } from "../lib/acceptance-server-readiness.ts";
import { runAcceptanceCleanup } from "../scripts/cleanup-consensus-acceptance.ts";
import { canonicalJson } from "../lib/canonical-json.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const processIdentity = (pid) =>
  hash(
    execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "pid="], {
      encoding: "utf8",
    }).trim(),
  );
const freePort = async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
};
const listenerAlive = (port) =>
  fetch(`http://127.0.0.1:${port}`)
    .then(() => true)
    .catch(() => false);
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function runFixture(
  generations,
  ignoreTerm = false,
  corruptIdentity = false,
  orphanLeader = false,
  primaryFailure = null,
) {
  const root = await mkdtemp(resolve(tmpdir(), "mc-terminal-cleanup-"));
  const runId = randomUUID();
  const harnessIdentity = "a".repeat(64);
  const bindings = {
    artifactSha256: "1".repeat(64),
    artifactMetadataSha256: "2".repeat(64),
    capabilityManifestSha256: "3".repeat(64),
    acceptanceSourceManifestSha256: "4".repeat(64),
    acceptanceContractSha256: "5".repeat(64),
    executableRegistrySha256: "6".repeat(64),
    disposableRegistrySha256: "7".repeat(64),
    providerRequirementsSha256: "8".repeat(64),
    providerProfilesSha256: "9".repeat(64),
    runtimeBindingsSha256: "a".repeat(64),
    modelAssignmentsSha256: "b".repeat(64),
    validatorRegistrySha256: "c".repeat(64),
    reviewChecklistSha256: "d".repeat(64),
    finalizerChecklistSha256: "e".repeat(64),
    reviewerImplementationSha256: "f".repeat(64),
    resourceInventoryImplementationSha256: "0".repeat(64),
    cleanupFinalizerSha256: "1".repeat(64),
    realAcceptanceHarnessSha256: harnessIdentity,
  };
  const inventory = new AcceptanceResourceInventory(runId, bindings, harnessIdentity, new Date().toISOString());
  const retainedPath = resolve(root, "retained-evidence.txt");
  await writeFile(retainedPath, "evidence-v1\n");
  inventory.register({
    resourceId: "retained-evidence",
    type: "diagnostic_artifact",
    identity: { path: retainedPath },
    creatingStep: "test.evidence",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "retain_evidence_only",
    expectedTerminalState: "retained_with_approved_reason",
    retentionPolicyIdentity: "9".repeat(64),
  });
  const registry = resolve(root, "validation-authorization");
  await mkdir(registry, { mode: 0o700 });
  await writeFile(resolve(registry, "authorization.json"), "{}\n", { mode: 0o400 });
  await chmod(registry, 0o500);
  inventory.register({
    resourceId: "registry",
    type: "registry_copy",
    identity: { path: registry },
    creatingStep: "test.registry",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "delete",
    expectedTerminalState: "deleted",
  });
  const processes = [];
  const ports = [];
  for (let index = 0; index < generations; index += 1) {
    const generation = `generation-${index + 1}`;
    const port = await freePort();
    const token = randomUUID();
    const serverProgram = `const http=require('http');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}http.createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')`;
    const child = spawn(
      orphanLeader ? "/bin/sh" : process.execPath,
      orphanLeader
        ? ["-c", `${process.execPath} -e ${JSON.stringify(serverProgram)} & sleep 0.2`]
        : ["-e", serverProgram],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: token },
      },
    );
    child.unref();
    for (let attempt = 0; attempt < 100 && !(await listenerAlive(port)); attempt += 1)
      await new Promise((done) => setTimeout(done, 20));
    assert.equal(await listenerAlive(port), true);
    const recordedIdentity = processIdentity(child.pid);
    if (orphanLeader)
      for (let attempt = 0; attempt < 100 && processAlive(child.pid); attempt += 1)
        await new Promise((done) => setTimeout(done, 20));
    const listenerId = `listener-${generation}`;
    const serverId = `server-${generation}`;
    inventory.register({
      resourceId: listenerId,
      type: "listener",
      identity: { host: "127.0.0.1", port, generation, owningServerResourceId: serverId },
      creatingStep: "test.listener",
      createdAt: new Date().toISOString(),
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
    });
    inventory.register({
      resourceId: serverId,
      type: "mission_control_server",
      identity: {
        pid: child.pid,
        pgid: child.pid,
        processIdentitySha256: corruptIdentity ? "f".repeat(64) : recordedIdentity,
        ownershipToken: token,
        generation,
      },
      creatingStep: "test.server",
      createdAt: new Date().toISOString(),
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
      dependsOn: [listenerId, "registry"],
    });
    processes.push(child.pid);
    ports.push(port);
  }
  const snapshot = inventory.journalSnapshot();
  const harnessPath = resolve(root, "harness.json");
  const cleanupPath = resolve(root, "cleanup.json");
  await writeFile(
    harnessPath,
    JSON.stringify({
      workspaceId: runId,
      candidateBindings: snapshot.candidateBindings,
      evidenceIndex: { sha256: "e".repeat(64) },
      ...(primaryFailure ? { primaryOutcome: { status: "failed", classification: primaryFailure } } : {}),
      runResourceInventory: snapshot,
    }),
  );
  await runAcceptanceCleanup(harnessPath, cleanupPath, {
    assertSafety: () => ({ acceptanceRoot: root, evidence: {} }),
  });
  const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
  return { root, cleanup, processes, ports, registry, harnessPath, retainedPath };
}

for (const classification of ["semantic_failure", "review_failure", "unexpected_exception"])
  test(`outer terminal cleanup reconciles both generations after ${classification}`, async () => {
    const fixture = await runFixture(2, false, false, false, classification);
    try {
      assert.equal(assertExactAcceptanceResourceReconciliation(fixture.cleanup.resourceInventory), true);
      assert.equal(fixture.processes.some(processAlive), false);
      assert.equal((await Promise.all(fixture.ports.map(listenerAlive))).some(Boolean), false);
      assert.equal(
        fixture.cleanup.resourceInventory.outcomes.some((outcome) => outcome.state.startsWith("cleanup_failed")),
        false,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

test("restart identity remains stable when the server changes its process title during readiness", async () => {
  const port = await freePort();
  const program = `const http=require('http');setTimeout(()=>{process.title='governed-restarted-server';http.createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')},150)`;
  const child = spawn(process.execPath, ["-e", program], { detached: true, stdio: "ignore" });
  child.unref();
  const identityBeforeReadiness = processIdentity(child.pid);
  try {
    await waitForAcceptanceServerReadiness({ pid: child.pid, healthUrl: `http://127.0.0.1:${port}` });
    const identityAfterReadiness = processIdentity(child.pid);
    assert.equal(identityAfterReadiness, identityBeforeReadiness);
    assert.equal(identityAfterReadiness, processIdentity(child.pid));
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
});

test("outer cleanup adopts a coordinator inventory after a crash before restart response", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-real-restart-cleanup-"));
  const port = await freePort();
  const runId = randomUUID();
  const bindings = {
    artifactSha256: "1".repeat(64),
    artifactMetadataSha256: "2".repeat(64),
    capabilityManifestSha256: "3".repeat(64),
    acceptanceSourceManifestSha256: "4".repeat(64),
    acceptanceContractSha256: "5".repeat(64),
    executableRegistrySha256: "6".repeat(64),
    disposableRegistrySha256: "7".repeat(64),
    providerRequirementsSha256: "8".repeat(64),
    providerProfilesSha256: "9".repeat(64),
    runtimeBindingsSha256: "a".repeat(64),
    modelAssignmentsSha256: "b".repeat(64),
    validatorRegistrySha256: "c".repeat(64),
    reviewChecklistSha256: "d".repeat(64),
    finalizerChecklistSha256: "e".repeat(64),
    reviewerImplementationSha256: "f".repeat(64),
    resourceInventoryImplementationSha256: "0".repeat(64),
    cleanupFinalizerSha256: "1".repeat(64),
    realAcceptanceHarnessSha256: "a".repeat(64),
  };
  const inventory = new AcceptanceResourceInventory(runId, bindings, "a".repeat(64), new Date().toISOString());
  const databasePath = resolve(root, "database-marker");
  const registryPath = resolve(root, "registry-marker");
  await mkdir(databasePath);
  await mkdir(registryPath);
  for (const [resourceId, path] of [
    ["disposable-database", databasePath],
    ["disposable-registry-copy", registryPath],
  ])
    inventory.register({
      resourceId,
      type: "registry_copy",
      identity: { path },
      creatingStep: "test.real_restart",
      createdAt: new Date().toISOString(),
      cleanupPolicy: "delete",
      expectedTerminalState: "deleted",
    });
  const ownershipToken = randomUUID();
  const testServerPath = resolve(root, "test-server.mjs");
  await writeFile(
    testServerPath,
    "import{createServer}from'node:http';createServer((q,r)=>{r.statusCode=200;r.end('ok')}).listen(Number(process.env.PORT),process.env.HOSTNAME);\n",
  );
  const original = spawn(process.execPath, [testServerPath], {
    cwd: resolve("."),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: ownershipToken,
    },
  });
  original.unref();
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  let restartedPid;
  try {
    await waitForAcceptanceServerReadiness({ pid: original.pid, healthUrl, timeoutMs: 15_000 });
    inventory.register({
      resourceId: "mission-control-listener",
      type: "listener",
      identity: { host: "127.0.0.1", port, generation: "initial", owningServerResourceId: "mission-control-server" },
      creatingStep: "test.real_restart",
      createdAt: new Date().toISOString(),
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
    });
    inventory.register({
      resourceId: "mission-control-server",
      type: "mission_control_server",
      identity: {
        pid: original.pid,
        pgid: original.pid,
        processIdentitySha256: processIdentity(original.pid),
        ownershipToken,
        generation: "initial",
      },
      creatingStep: "test.real_restart",
      createdAt: new Date().toISOString(),
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
      dependsOn: ["mission-control-listener", "disposable-database", "disposable-registry-copy"],
    });
    const inventoryPath = resolve(root, "inventory.json");
    const stalePreRestartSnapshot = inventory.journalSnapshot();
    await writeFile(inventoryPath, `${canonicalJson(stalePreRestartSnapshot)}\n`);
    const identityChecks = [];
    for (const kind of ["candidate", "source", "contract", "registry"]) {
      const path = resolve(root, `${kind}.identity`);
      await writeFile(path, `${kind}\n`);
      identityChecks.push({ kind, path, sha256: hash(`${kind}\n`) });
    }
    const requestPath = resolve(root, "restart-request.json");
    const responsePath = resolve(root, "restart-response.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        acceptanceRunId: runId,
        candidateIdentitySha256: "1".repeat(64),
        executableIdentitySha256: "2".repeat(64),
        inventoryPath,
        inventorySha256: inventory.journalSnapshot().sha256,
        originalPid: original.pid,
        requestedAt: new Date().toISOString(),
        host: "127.0.0.1",
        port,
        healthUrl,
        preRestartDurableStateSha256: "3".repeat(64),
        preRestartEventRangeSha256: "4".repeat(64),
        identityChecks,
        testServerEntryPath: testServerPath,
      }),
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/restart-consensus-acceptance-server.ts", requestPath, responsePath],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            APP_ENV: "disposable_acceptance",
            CONSENSUS_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
            CONSENSUS_ACCEPTANCE_TEST_CRASH_AFTER_RESTART_SERVER_PERSIST: "1",
            NODE_ENV: "test",
            PORT: String(port),
            HOSTNAME: "127.0.0.1",
          },
          stdio: "ignore",
          timeout: 30_000,
        },
      ),
    );
    assert.equal(
      await readFile(responsePath, "utf8")
        .then(() => true)
        .catch(() => false),
      false,
    );
    for (let attempt = 0; attempt < 100 && !(await listenerAlive(port)); attempt += 1)
      await new Promise((done) => setTimeout(done, 20));
    assert.equal(await listenerAlive(port), true);
    const persistedAfterCrash = JSON.parse(await readFile(inventoryPath, "utf8"));
    const staleHarnessInventory = AcceptanceResourceInventory.fromJournalSnapshot(stalePreRestartSnapshot);
    staleHarnessInventory.bindRepositorySnapshot("f".repeat(64));
    const adoptedInventory = adoptPersistedAcceptanceInventoryForTerminalCleanup(
      staleHarnessInventory,
      persistedAfterCrash,
    );
    const restartedSnapshot = adoptedInventory.journalSnapshot();
    assert.equal(restartedSnapshot.candidateBindings.repositorySnapshotSha256, "f".repeat(64));
    const restartedServer = restartedSnapshot.resources.find(
      (resource) => resource.resourceId === "mission-control-server-restart-1",
    );
    const restartedListener = restartedSnapshot.resources.find(
      (resource) => resource.resourceId === "mission-control-listener-restart-1",
    );
    restartedPid = restartedServer.identity.pid;
    assert.equal(restartedServer.lifecycleState, "created");
    assert.equal(restartedListener.lifecycleState, "creation_reserved");
    const harnessPath = resolve(root, "harness.json");
    const cleanupPath = resolve(root, "cleanup.json");
    await writeFile(
      harnessPath,
      JSON.stringify({
        workspaceId: runId,
        candidateBindings: restartedSnapshot.candidateBindings,
        evidenceIndex: { sha256: "e".repeat(64) },
        primaryOutcome: { status: "failed", classification: "semantic_failure" },
        runResourceInventory: restartedSnapshot,
      }),
    );
    await runAcceptanceCleanup(harnessPath, cleanupPath, {
      assertSafety: () => ({ acceptanceRoot: root, evidence: {} }),
    });
    const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
    assert.equal(assertExactAcceptanceResourceReconciliation(cleanup.resourceInventory), true);
    assert.equal(
      cleanup.resourceInventory.outcomes.some((outcome) => outcome.state.startsWith("cleanup_failed")),
      false,
    );
    assert.equal(processAlive(restartedPid), false);
    assert.equal(await listenerAlive(port), false);
  } finally {
    for (const pid of [original.pid, restartedPid].filter(Boolean))
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("governed terminal cleanup reconciles two server/listener generations and registry copy", async () => {
  for (let run = 0; run < 3; run += 1) {
    const fixture = await runFixture(2);
    try {
      assert.equal(assertExactAcceptanceResourceReconciliation(fixture.cleanup.resourceInventory), true);
      assert.equal(
        fixture.cleanup.resourceInventory.outcomes.every((outcome) => !outcome.state.startsWith("cleanup_failed")),
        true,
      );
      assert.equal(fixture.processes.some(processAlive), false);
      assert.equal((await Promise.all(fixture.ports.map(listenerAlive))).some(Boolean), false);
      assert.equal(
        await stat(fixture.registry)
          .then(() => true)
          .catch(() => false),
        false,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("governed terminal cleanup escalates a proven non-graceful server generation", async () => {
  const fixture = await runFixture(1, true);
  try {
    const server = fixture.cleanup.resourceInventory.outcomes.find((outcome) =>
      outcome.resourceId.startsWith("server-"),
    );
    assert.deepEqual(
      server.observation.signalActions.map((action) => action.signal),
      ["SIGTERM", "SIGKILL"],
    );
    assert.equal(server.state, "stopped");
    assert.equal(fixture.processes.some(processAlive), false);
    assert.equal(await listenerAlive(fixture.ports[0]), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("governed terminal cleanup fails closed without signaling a mismatched server identity", async () => {
  const fixture = await runFixture(1, false, true);
  try {
    const server = fixture.cleanup.resourceInventory.outcomes.find((outcome) =>
      outcome.resourceId.startsWith("server-"),
    );
    assert.equal(server.state, "cleanup_failed");
    assert.match(server.observation.error, /Possible PID reuse/);
    assert.equal(processAlive(fixture.processes[0]), true);
    assert.equal(await listenerAlive(fixture.ports[0]), true);
  } finally {
    try {
      process.kill(-fixture.processes[0], "SIGKILL");
    } catch {}
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resumed cleanup re-probes completed listener evidence instead of trusting a stale journal outcome", async () => {
  const fixture = await runFixture(1);
  let replacement;
  try {
    replacement = spawn(
      process.execPath,
      ["-e", `require('http').createServer((q,r)=>r.end('replacement')).listen(${fixture.ports[0]},'127.0.0.1')`],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: randomUUID() },
      },
    );
    replacement.unref();
    for (let attempt = 0; attempt < 100 && !(await listenerAlive(fixture.ports[0])); attempt += 1)
      await new Promise((done) => setTimeout(done, 20));
    const retryPath = resolve(fixture.root, "cleanup-retry.json");
    await runAcceptanceCleanup(fixture.harnessPath, retryPath, {
      assertSafety: () => ({ acceptanceRoot: fixture.root, evidence: {} }),
    });
    const retry = JSON.parse(await readFile(retryPath, "utf8"));
    const listener = retry.resourceInventory.outcomes.find((outcome) => outcome.resourceId.startsWith("listener-"));
    assert.equal(listener.state, "cleanup_failed");
    assert.equal(listener.observation.surviving, true);
    assert.equal(
      listener.observation.cleanupStartedAt ===
        fixture.cleanup.resourceInventory.outcomes.find((outcome) => outcome.resourceId === listener.resourceId)
          .observation.cleanupStartedAt,
      false,
    );
  } finally {
    if (replacement?.pid)
      try {
        process.kill(-replacement.pid, "SIGKILL");
      } catch {}
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("restarted-generation orphan descendants are terminated using their durable ownership token", async () => {
  const fixture = await runFixture(1, false, false, true);
  try {
    const server = fixture.cleanup.resourceInventory.outcomes.find((outcome) =>
      outcome.resourceId.startsWith("server-"),
    );
    assert.equal(server.state, "stopped");
    assert.equal(await listenerAlive(fixture.ports[0]), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resumed cleanup re-hashes retained evidence instead of reusing stale journal bytes", async () => {
  const fixture = await runFixture(1);
  try {
    const prior = fixture.cleanup.resourceInventory.outcomes.find(
      (outcome) => outcome.resourceId === "retained-evidence",
    );
    await writeFile(fixture.retainedPath, "evidence-v2-mutated\n");
    const retryPath = resolve(fixture.root, "cleanup-retained-retry.json");
    await runAcceptanceCleanup(fixture.harnessPath, retryPath, {
      assertSafety: () => ({ acceptanceRoot: fixture.root, evidence: {} }),
    });
    const retry = JSON.parse(await readFile(retryPath, "utf8"));
    const current = retry.resourceInventory.outcomes.find((outcome) => outcome.resourceId === "retained-evidence");
    assert.notEqual(current.observation.retainedArtifactSha256, prior.observation.retainedArtifactSha256);
    assert.notEqual(current.observation.retainedArtifactSize, prior.observation.retainedArtifactSize);
    assert.equal(current.state, "retained_with_approved_reason");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
