import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { persistAcceptanceInventorySnapshot } from "../lib/acceptance-bootstrap-authority";
import { createGovernedAcceptanceResource } from "../lib/acceptance-resource-creator";
import { AcceptanceResourceInventory } from "../lib/acceptance-resource-inventory";
import { canonicalHash, canonicalJson } from "../lib/canonical-json";
import { waitForAcceptanceServerReadiness } from "../lib/acceptance-server-readiness";
import { assertProcessSignalAuthority } from "../lib/acceptance-process-cleanup";

async function main() {
  const [requestFile, responseFile] = process.argv.slice(2).map((path) => resolve(path));
  if (!requestFile || !responseFile) throw new Error("Restart coordinator requires request and response paths");
  if (
    process.env.APP_ENV !== "disposable_acceptance" ||
    !["mock_provider_acceptance", "consensus_real_provider_acceptance"].includes(
      process.env.CONSENSUS_PROVIDER_RUNTIME_MODE ?? "",
    )
  )
    throw new Error("Restart coordinator is disposable acceptance only");
  const request = JSON.parse(readFileSync(requestFile, "utf8"));
  const identityChecks = request.identityChecks as Array<{ kind: string; path: string; sha256: string }>;
  if (
    !Array.isArray(identityChecks) ||
    canonicalHash(identityChecks.map((item) => item.kind).sort()) !==
      canonicalHash(["candidate", "source", "contract", "registry"].sort()) ||
    identityChecks.some(
      (item) =>
        !item.path ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        createHash("sha256")
          .update(Uint8Array.from(readFileSync(resolve(item.path))))
          .digest("hex") !== item.sha256,
    )
  )
    throw new Error("Restart request candidate/source/contract/registry identity changed");
  const inventoryPath = resolve(request.inventoryPath);
  const inventory = AcceptanceResourceInventory.fromJournalSnapshot(JSON.parse(readFileSync(inventoryPath, "utf8")));
  if (
    inventory.acceptanceRunId !== request.acceptanceRunId ||
    inventory.journalSnapshot().sha256 !== request.inventorySha256
  )
    throw new Error("Restart request inventory binding changed");
  const original = inventory.resourceRecords().find((item) => item.resourceId === "mission-control-server");
  const listener = inventory.resourceRecords().find((item) => item.resourceId === "mission-control-listener");
  if (!original || !listener || original.identity.pid !== request.originalPid)
    throw new Error("Restart request original server/listener identity changed");
  const processIdentity = (pid: number) => {
    try {
      const observation = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "pid="], {
        encoding: "utf8",
      }).trim();
      return observation ? createHash("sha256").update(observation).digest("hex") : null;
    } catch {
      return null;
    }
  };
  const processAlive = (pid: number) => {
    try {
      const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
      return Boolean(state) && !state.startsWith("Z");
    } catch {
      return false;
    }
  };
  const persist = () =>
    persistAcceptanceInventorySnapshot(inventoryPath, `${canonicalJson(inventory.journalSnapshot())}\n`, true);
  const shutdownRequestIdentity = canonicalHash({
    acceptanceRunId: request.acceptanceRunId,
    pid: request.originalPid,
    processIdentitySha256: original.identity.processIdentitySha256,
    requestedAt: request.requestedAt,
  });
  const shutdownInitiatedAt = new Date().toISOString();
  if (Number(original.identity.pgid) !== Number(request.originalPid))
    throw new Error("Restart request original server process-group binding changed");
  assertProcessSignalAuthority({
    pid: Number(request.originalPid),
    currentPid: process.pid,
    expectedIdentity: String(original.identity.processIdentitySha256),
    observedIdentity: processIdentity(Number(request.originalPid)),
    processKind: "process_group",
  });
  process.kill(-Number(request.originalPid), "SIGTERM");
  let originalProcessTerminated = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processAlive(Number(request.originalPid))) {
      originalProcessTerminated = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!originalProcessTerminated) {
    assertProcessSignalAuthority({
      pid: Number(request.originalPid),
      currentPid: process.pid,
      expectedIdentity: String(original.identity.processIdentitySha256),
      observedIdentity: processIdentity(Number(request.originalPid)),
      processKind: "process_group",
    });
    process.kill(-Number(request.originalPid), "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processAlive(Number(request.originalPid))) {
        originalProcessTerminated = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  if (!originalProcessTerminated) throw new Error("Original Mission Control server survived bounded shutdown");
  let listenerStopped = false;
  for (let attempt = 0; attempt < 100 && !listenerStopped; attempt += 1) {
    listenerStopped = await fetch(request.healthUrl)
      .then(() => false)
      .catch(() => true);
    if (!listenerStopped) await new Promise((done) => setTimeout(done, 50));
  }
  if (!listenerStopped) throw new Error("Original Mission Control listener remained reachable");
  const generation = "restart-1";
  const serverEntryPath =
    process.env.NODE_ENV === "test" && request.testServerEntryPath
      ? resolve(String(request.testServerEntryPath))
      : resolve(".next/standalone/server.js");
  const restartedListenerResourceId = `mission-control-listener-${generation}`;
  const listenerReservationIdentity = canonicalHash({
    acceptanceRunId: request.acceptanceRunId,
    resourceId: restartedListenerResourceId,
    reservationId: randomUUID(),
  });
  inventory.reserve({
    resourceId: restartedListenerResourceId,
    type: "listener",
    identity: {
      host: request.host,
      port: request.port,
      generation,
      owningServerResourceId: `mission-control-server-${generation}`,
    },
    creatingStep: "recovery.mission_control_restart",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "stop",
    expectedTerminalState: "stopped",
    lifecycleState: "creation_reserved",
    reservationIdentity: listenerReservationIdentity,
    reservedAt: new Date().toISOString(),
  });
  persist();
  const child = await createGovernedAcceptanceResource({
    inventory,
    record: {
      resourceId: `mission-control-server-${generation}`,
      type: "mission_control_server",
      identity: { executable: process.execPath, generation },
      creatingStep: "recovery.mission_control_restart",
      createdAt: new Date().toISOString(),
      cleanupPolicy: "stop",
      expectedTerminalState: "stopped",
      dependsOn: [restartedListenerResourceId, "disposable-database", "disposable-registry-copy"],
    },
    persist,
    create: async ({ ownershipToken }) => {
      const server = spawn(process.execPath, [serverEntryPath], {
        cwd: resolve("."),
        env: { ...process.env, CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: ownershipToken },
        detached: true,
        stdio: "inherit",
      });
      if (!server.pid) throw new Error("Restarted server did not expose a PID");
      server.unref();
      await waitForAcceptanceServerReadiness({ pid: server.pid, healthUrl: request.healthUrl });
      return server.pid;
    },
    observeIdentity: (pid) => {
      const identity = processIdentity(pid);
      if (!identity) throw new Error("Restarted server identity disappeared after readiness");
      return { pid, pgid: pid, processIdentitySha256: identity, generation };
    },
    emergencyCleanup: (pid) => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    },
  });
  if (
    process.env.NODE_ENV === "test" &&
    process.env.CONSENSUS_ACCEPTANCE_TEST_CRASH_AFTER_RESTART_SERVER_PERSIST === "1"
  )
    throw new Error("Injected restart handoff crash after server persistence");
  inventory.markCreated(
    restartedListenerResourceId,
    {
      host: request.host,
      port: request.port,
      generation,
      owningServerResourceId: `mission-control-server-${generation}`,
    },
    new Date().toISOString(),
  );
  persist();
  const response = {
    schemaVersion: "mission-control-restart-observation/1",
    acceptanceRunId: request.acceptanceRunId,
    candidateIdentitySha256: request.candidateIdentitySha256,
    serverResourceId: original.resourceId,
    listenerResourceId: listener.resourceId,
    originalPid: request.originalPid,
    originalProcessIdentitySha256: original.identity.processIdentitySha256,
    originalListenerIdentitySha256: canonicalHash(listener.identity),
    preRestartDurableStateSha256: request.preRestartDurableStateSha256,
    preRestartEventRangeSha256: request.preRestartEventRangeSha256,
    shutdownRequestIdentity,
    shutdownInitiatedAt,
    shutdownCompletedAt: new Date().toISOString(),
    shutdownEvidenceIdentity: canonicalHash({ shutdownRequestIdentity, originalProcessTerminated, listenerStopped }),
    originalProcessTerminated,
    originalListenerStopped: listenerStopped,
    restartedServerResourceId: `mission-control-server-${generation}`,
    restartedPid: child,
    restartedProcessIdentitySha256: processIdentity(child),
    restartedListenerResourceId: `mission-control-listener-${generation}`,
    restartedListenerIdentitySha256: canonicalHash({ host: request.host, port: request.port, generation }),
    executableIdentitySha256: request.executableIdentitySha256,
    restartedExecutableIdentitySha256: request.executableIdentitySha256,
    readinessObserved: true,
    revalidation: Object.fromEntries(identityChecks.map((item) => [item.kind, true])),
    revalidationEvidenceSha256: canonicalHash(identityChecks),
    inventorySha256: inventory.journalSnapshot().sha256,
  };
  writeFileSync(responseFile, `${canonicalJson(response)}\n`, { mode: 0o600 });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
