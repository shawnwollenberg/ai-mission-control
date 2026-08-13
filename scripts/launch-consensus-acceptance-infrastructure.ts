import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { persistAcceptanceInventorySnapshot } from "../lib/acceptance-bootstrap-authority";
import { createGovernedAcceptanceResource } from "../lib/acceptance-resource-creator";
import { AcceptanceResourceInventory, type AcceptanceResourceRecord } from "../lib/acceptance-resource-inventory";
import { canonicalJson } from "../lib/canonical-json";

type Creation =
  | {
      kind: "process";
      executable: string;
      args: string[];
      cwd: string;
      readyUrl?: string;
      readinessAttempts?: number;
      readinessDelayMs?: number;
    }
  | { kind: "directory"; path: string }
  | {
      kind: "command";
      executable: string;
      args: string[];
      cwd: string;
      actualIdentity: Record<string, string | number>;
    };
type Request = {
  bootstrapInventoryPath: string;
  resources: Array<{ record: AcceptanceResourceRecord; creation: Creation }>;
};

const processIdentity = (pid: number) =>
  createHash("sha256")
    .update(
      execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "pid="], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim(),
    )
    .digest("hex");

const hashBytes = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const ownedProcesses = (token: string) =>
  execFileSync("/bin/ps", ["axeww", "-o", "pid=", "-o", "command="], { encoding: "utf8", timeout: 3_000 })
    .split(/\r?\n/)
    .filter((line) => line.includes(`CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN=${token}`))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
const listenerOwner = (host: string, port: number) => {
  try {
    const output = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP@${host}:${port}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const pid = Number(output.match(/^p(\d+)$/m)?.[1]);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};
const processPgid = (pid: number) => {
  try {
    const pgid = Number(
      execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 2_000 }).trim(),
    );
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
};
const processCarriesOwnershipToken = (pid: number, token: string) => {
  try {
    return execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).includes(`CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN=${token}`);
  } catch {
    return false;
  }
};
const listenerAlive = async (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(750) })
    .then(() => true)
    .catch(() => false);
const secretCleanExcerpt = (value: string) =>
  value
    .slice(-8_192)
    .replace(/authorization\s*:\s*[^\r\n]*/gi, "Authorization: [REDACTED]")
    .replace(/(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .replace(/bearer\s+\S+/gi, "Bearer [REDACTED]");
const prohibitedDiagnosticSecret = /authorization\s*:\s*(?!\[REDACTED\])\S|bearer\s+(?!\[REDACTED\])\S/i;
const credentialArgument = /^(?:--?)?(?:api[_-]?key|token|secret|password|authorization)$/i;
const secretCleanArguments = (args: string[]) => {
  const cleaned: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (credentialArgument.test(argument)) {
      cleaned.push(argument, "[REDACTED]");
      index += 1;
      continue;
    }
    cleaned.push(
      /^(?:--?)?(?:api[_-]?key|token|secret|password|authorization)=/i.test(argument)
        ? `${argument.slice(0, argument.indexOf("=") + 1)}[REDACTED]`
        : secretCleanExcerpt(argument),
    );
  }
  return cleaned;
};

const requestPath = process.argv[2];
if (!requestPath) throw new Error("Usage: launch-consensus-acceptance-infrastructure <request.json>");
const request = JSON.parse(readFileSync(resolve(requestPath), "utf8")) as Request;
const requestSha256 = createHash("sha256")
  .update(Uint8Array.from(readFileSync(resolve(requestPath))))
  .digest("hex");
const launcherSha256 = createHash("sha256")
  .update(Uint8Array.from(readFileSync(resolve("scripts/launch-consensus-acceptance-infrastructure.ts"))))
  .digest("hex");
const inventoryPath = resolve(request.bootstrapInventoryPath);
const inventory = AcceptanceResourceInventory.fromJournalSnapshot(
  JSON.parse(readFileSync(inventoryPath, "utf8")) as Record<string, unknown>,
);
const authority = inventory
  .resourceRecords()
  .find((resource) => resource.resourceId === "authoritative-resource-inventory");
if (
  authority?.identity.infrastructureLauncherSha256 !== launcherSha256 ||
  authority.identity.infrastructureRequestSha256 !== requestSha256
)
  throw new Error("Infrastructure launcher/request authority binding changed");
const persist = () => {
  const snapshot = inventory.journalSnapshot();
  persistAcceptanceInventorySnapshot(inventoryPath, `${canonicalJson(snapshot)}\n`, true);
};
const isWithin = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

async function main() {
  try {
    for (const item of request.resources) {
      if (item.creation.kind === "process" && item.creation.readyUrl) {
        const ownershipToken = randomUUID();
        const reservedAt = new Date().toISOString();
        const reservationIdentity = hashBytes(
          canonicalJson({
            acceptanceRunId: inventory.acceptanceRunId,
            resourceId: item.record.resourceId,
            type: item.record.type,
            intendedIdentity: item.record.identity,
            ownershipToken,
            reservedAt,
          }),
        );
        inventory.reserve({
          ...item.record,
          identity: { ...item.record.identity, ownershipToken },
          lifecycleState: "creation_reserved",
          reservationIdentity,
          reservedAt,
        });
        persist();
        const readyTarget = new URL(item.creation.readyUrl);
        if (listenerOwner(readyTarget.hostname, Number(readyTarget.port))) {
          inventory.markCreationFailed(item.record.resourceId, "Reserved listener was occupied before server spawn");
          persist();
          throw new Error(`Reserved listener was occupied before server spawn: ${item.record.resourceId}`);
        }
        const spawnedAt = new Date().toISOString();
        let stdout = "";
        let stderr = "";
        const child = spawn(item.creation.executable, item.creation.args, {
          cwd: resolve(item.creation.cwd),
          env: { ...process.env, CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: ownershipToken },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (!child.pid) {
          inventory.markCreationFailed(item.record.resourceId, "Reserved process did not expose a PID");
          persist();
          throw new Error(`Reserved process did not expose a PID: ${item.record.resourceId}`);
        }
        child.stdout?.on("data", (chunk) => (stdout = `${stdout}${String(chunk)}`.slice(-16_384)));
        child.stderr?.on("data", (chunk) => (stderr = `${stderr}${String(chunk)}`.slice(-16_384)));
        child.unref();
        const pid = child.pid;
        const pgid = pid;
        const executablePath = resolve(item.creation.executable);
        const executableSha256 = hashBytes(Uint8Array.from(readFileSync(executablePath)));
        const generation = String(item.record.identity.generation ?? "initial");
        const baseIdentity = {
          runId: inventory.acceptanceRunId,
          candidateArtifactSha256: String(inventory.candidateBindings.artifactSha256),
          serverGenerationId: generation,
          launcherPid: process.pid,
          pid,
          pgid,
          processIdentitySha256: processIdentity(pid),
          executable: executablePath,
          executableSha256,
          workingDirectory: resolve(item.creation.cwd),
          listenerHost: readyTarget.hostname,
          listenerPort: Number(readyTarget.port),
          spawnedAt,
          expectedReadinessTarget: item.creation.readyUrl,
          startupArgumentsJson: canonicalJson(secretCleanArguments(item.creation.args)),
        };
        inventory.transitionCreation(item.record.resourceId, "creation_reserved", "spawned", baseIdentity, spawnedAt);
        persist();
        inventory.transitionCreation(
          item.record.resourceId,
          "spawned",
          "identity_verified",
          { identityVerifiedAt: new Date().toISOString() },
          new Date().toISOString(),
        );
        persist();
        inventory.transitionCreation(
          item.record.resourceId,
          "identity_verified",
          "readiness_pending",
          { readinessPendingAt: new Date().toISOString() },
          new Date().toISOString(),
        );
        persist();
        const probes: Array<Record<string, unknown>> = [];
        let ready = false;
        let discoveredOwner: number | null = null;
        const attempts = item.creation.readinessAttempts ?? 150;
        for (let attempt = 1; attempt <= attempts && !ready; attempt += 1) {
          const observedOwner = listenerOwner(readyTarget.hostname, Number(readyTarget.port));
          if (
            observedOwner &&
            processPgid(observedOwner) === pgid &&
            ((observedOwner === pid && processIdentity(observedOwner) === baseIdentity.processIdentitySha256) ||
              processCarriesOwnershipToken(observedOwner, ownershipToken))
          )
            discoveredOwner ??= observedOwner;
          if (discoveredOwner) {
            const ownerIdentity = processIdentity(discoveredOwner);
            const listener = inventory
              .resourceRecords()
              .find((resource) => resource.resourceId === "mission-control-listener");
            if (listener && !listener.identity.owningPid)
              inventory.bindCreatedIdentity(
                listener.resourceId,
                {
                  serverGenerationId: generation,
                  owningPid: discoveredOwner,
                  owningPgid: pgid,
                  owningProcessIdentitySha256: ownerIdentity,
                  discoveredAt: new Date().toISOString(),
                  ownershipEvidenceSha256: hashBytes(
                    canonicalJson({ ownershipToken, discoveredOwner, ownerIdentity, pgid, generation }),
                  ),
                },
                new Date().toISOString(),
              );
            if (
              discoveredOwner !== pid &&
              !inventory.hasResource(`mission-control-server-descendant-${discoveredOwner}`)
            )
              inventory.register({
                resourceId: `mission-control-server-descendant-${discoveredOwner}`,
                type: "other_run_scoped_resource",
                identity: {
                  pid: discoveredOwner,
                  pgid,
                  processIdentitySha256: ownerIdentity,
                  ownershipToken,
                  parentServerResourceId: item.record.resourceId,
                  serverGenerationId: generation,
                },
                creatingStep: "infrastructure.server_listener_discovery",
                createdAt: new Date().toISOString(),
                cleanupPolicy: "stop",
                expectedTerminalState: "stopped",
                dependsOn: ["mission-control-listener"],
              });
            persist();
          }
          const result = await fetch(item.creation.readyUrl)
            .then((response) => ({ reachable: true, ok: response.ok, status: response.status }))
            .catch((error) => ({
              reachable: false,
              ok: false,
              failure: error instanceof Error ? error.name : "Error",
            }));
          probes.push({ attempt, observedAt: new Date().toISOString(), ...result });
          ready = result.ok && discoveredOwner !== null;
          if (!ready) await delay(item.creation.readinessDelayMs ?? 200);
        }
        const persistDiagnostic = (status: "ready" | "readiness_failed", cleanup: Record<string, unknown>) => {
          const diagnosticCore = {
            schemaVersion: "acceptance-server-startup-diagnostic/1",
            serverResourceId: item.record.resourceId,
            ...baseIdentity,
            readinessStatus: status,
            probes,
            stdoutExcerpt: secretCleanExcerpt(stdout),
            stdoutSha256: hashBytes(stdout),
            stderrExcerpt: secretCleanExcerpt(stderr),
            stderrSha256: hashBytes(stderr),
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            cleanup,
            persistedAt: new Date().toISOString(),
          };
          const diagnosticBytes = JSON.stringify(diagnosticCore);
          if (prohibitedDiagnosticSecret.test(diagnosticBytes))
            throw new Error("Server startup diagnostic secret scan rejected durable persistence");
          const diagnostics = {
            ...diagnosticCore,
            secretScan: {
              passed: true,
              policyIdentity: hashBytes("acceptance-server-startup-diagnostic-secret-scan/1"),
            },
          };
          const diagnosticPath = resolve(dirname(inventoryPath), `server-startup-${generation}.json`);
          writeFileSync(diagnosticPath, `${JSON.stringify(diagnostics, null, 2)}\n`, { mode: 0o600 });
          const evidenceRoot = inventory
            .resourceRecords()
            .find((resource) => resource.resourceId === "acceptance-evidence-root");
          inventory.register({
            resourceId: `server-startup-diagnostic-${generation}`,
            type: "diagnostic_artifact",
            identity: { path: diagnosticPath, sha256: hashBytes(Uint8Array.from(readFileSync(diagnosticPath))) },
            creatingStep: "infrastructure.server_readiness",
            createdAt: new Date().toISOString(),
            cleanupPolicy: "retain_evidence_only",
            expectedTerminalState: "retained_with_approved_reason",
            dependsOn: evidenceRoot ? [evidenceRoot.resourceId] : undefined,
            retentionPolicyIdentity: evidenceRoot?.retentionPolicyIdentity,
          });
          persist();
        };
        if (!ready) {
          inventory.transitionCreation(
            item.record.resourceId,
            "readiness_pending",
            "readiness_failed",
            { readinessFailedAt: new Date().toISOString() },
            new Date().toISOString(),
          );
          persist();
          const cleanup: Record<string, unknown> = { actions: [] };
          if (processAlive(pid) && processIdentity(pid) === baseIdentity.processIdentitySha256) {
            process.kill(-pgid, "SIGTERM");
            (cleanup.actions as unknown[]).push({ signal: "SIGTERM", at: new Date().toISOString() });
          } else for (const ownedPid of ownedProcesses(ownershipToken)) process.kill(ownedPid, "SIGTERM");
          for (
            let attempt = 0;
            attempt < 20 && (groupAlive(pgid) || ownedProcesses(ownershipToken).length);
            attempt += 1
          )
            await delay(100);
          const survivors = ownedProcesses(ownershipToken);
          if (groupAlive(pgid) || survivors.length) {
            if (processAlive(pid) && processIdentity(pid) === baseIdentity.processIdentitySha256)
              process.kill(-pgid, "SIGKILL");
            else for (const ownedPid of survivors) process.kill(ownedPid, "SIGKILL");
            (cleanup.actions as unknown[]).push({ signal: "SIGKILL", at: new Date().toISOString() });
          }
          for (
            let attempt = 0;
            attempt < 20 && (groupAlive(pgid) || ownedProcesses(ownershipToken).length);
            attempt += 1
          )
            await delay(100);
          cleanup.survivingPids = ownedProcesses(ownershipToken);
          cleanup.processGroupSurviving = groupAlive(pgid);
          cleanup.listenerSurviving = await listenerAlive(item.creation.readyUrl);
          cleanup.completedAt = new Date().toISOString();
          persistDiagnostic("readiness_failed", cleanup);
          if (cleanup.processGroupSurviving || cleanup.listenerSurviving || (cleanup.survivingPids as number[]).length)
            throw new Error(`Server readiness cleanup failed: ${item.record.resourceId}`);
          throw new Error(`Reserved process did not become ready: ${item.record.resourceId}`);
        }
        inventory.transitionCreation(
          item.record.resourceId,
          "readiness_pending",
          "created",
          { readinessVerifiedAt: new Date().toISOString() },
          new Date().toISOString(),
        );
        persistDiagnostic("ready", { actions: [], listenerSurviving: true });
        // The governed server is detached and owns these pipes after readiness.
        // Unreference the read handles so the one-shot infrastructure launcher
        // can return control to the contract harness while retaining bounded
        // startup output captured above.
        (child.stdout as typeof child.stdout & { unref?: () => void })?.unref?.();
        (child.stderr as typeof child.stderr & { unref?: () => void })?.unref?.();
        continue;
      }
      await createGovernedAcceptanceResource({
        inventory,
        record: item.record,
        persist,
        create: async ({ ownershipToken }) => {
          if (item.creation.kind === "directory") {
            mkdirSync(resolve(item.creation.path), { recursive: false, mode: 0o700 });
            return { kind: "directory" as const, path: resolve(item.creation.path) };
          }
          if (item.creation.kind === "command") {
            execFileSync(item.creation.executable, item.creation.args, {
              cwd: resolve(item.creation.cwd),
              env: { ...process.env, CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: ownershipToken },
              stdio: "inherit",
            });
            return { kind: "command" as const, identity: item.creation.actualIdentity };
          }
          const child = spawn(item.creation.executable, item.creation.args, {
            cwd: resolve(item.creation.cwd),
            env: { ...process.env, CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN: ownershipToken },
            detached: true,
            stdio: "inherit",
          });
          if (!child.pid) throw new Error(`Reserved process did not expose a PID: ${item.record.resourceId}`);
          child.unref();
          if (item.creation.readyUrl) {
            let ready = false;
            for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
              ready = await fetch(item.creation.readyUrl)
                .then((response) => response.ok)
                .catch(() => false);
              if (!ready) await new Promise((done) => setTimeout(done, 200));
            }
            if (!ready) throw new Error(`Reserved process did not become ready: ${item.record.resourceId}`);
          }
          return { kind: "process" as const, pid: child.pid };
        },
        observeIdentity: (created) => {
          if (created.kind === "directory") {
            if (item.record.type !== "sandbox_root") return { path: created.path };
            const info = lstatSync(created.path);
            const canonicalPath = realpathSync(created.path);
            const acceptanceRoot = realpathSync(resolve(String(process.env.CONSENSUS_ACCEPTANCE_ROOT ?? "")));
            if (
              info.isSymbolicLink() ||
              !info.isDirectory() ||
              !isWithin(acceptanceRoot, canonicalPath) ||
              (info.mode & 0o777) !== 0o700 ||
              (typeof process.getuid === "function" && info.uid !== process.getuid())
            )
              throw new Error(`Governed directory identity verification failed: ${created.path}`);
            return {
              path: canonicalPath,
              canonicalPath,
              fileType: "directory",
              mode: info.mode & 0o777,
              ownerUid: info.uid,
              filesystemAuthorityIdentity: hashBytes(
                canonicalJson({
                  acceptanceRunId: inventory.acceptanceRunId,
                  resourceId: item.record.resourceId,
                  canonicalPath,
                  purpose: item.record.identity.rootPurpose ?? item.record.type,
                }),
              ),
            };
          }
          if (created.kind === "command") return created.identity;
          return {
            pid: created.pid,
            pgid: created.pid,
            processIdentitySha256: processIdentity(created.pid),
            ...(item.record.type === "mission_control_server"
              ? { generation: String(item.record.identity.generation ?? "initial") }
              : {}),
          };
        },
        emergencyCleanup: async (created) => {
          if (created.kind === "directory") await rm(created.path, { recursive: true, force: true });
          else if (created.kind === "process") {
            try {
              process.kill(-created.pid, "SIGKILL");
            } catch {}
          }
        },
      });
      if (item.creation.kind === "directory" && item.record.type === "sandbox_root") {
        inventory.markVerified(
          item.record.resourceId,
          { verifiedAt: new Date().toISOString() },
          new Date().toISOString(),
        );
        persist();
        process.env.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS = canonicalJson(
          inventory
            .resourceRecords()
            .filter((resource) => resource.type === "sandbox_root" && resource.lifecycleState === "verified")
            .map((resource) => ({
              resourceId: resource.resourceId,
              acceptanceRunId: inventory.acceptanceRunId,
              rootPurpose: String(resource.identity.rootPurpose),
              intendedPath: String(resource.identity.intendedPath),
              canonicalPath: String(resource.identity.canonicalPath),
              filesystemAuthorityIdentity: String(resource.identity.filesystemAuthorityIdentity),
            })),
        );
      }
    }
    process.stdout.write(
      `${canonicalJson({ inventory: inventory.journalSnapshot(), infrastructureLauncherSha256: launcherSha256, infrastructureRequestSha256: requestSha256 })}\n`,
    );
  } catch (primaryError) {
    const failureHarnessPath = `${inventoryPath}.infrastructure-failure-harness.json`;
    const cleanupPath = `${inventoryPath}.infrastructure-failure-cleanup.json`;
    const snapshot = inventory.journalSnapshot();
    writeFileSync(
      failureHarnessPath,
      `${JSON.stringify(
        {
          workspaceId: inventory.acceptanceRunId,
          candidateBindings: snapshot.candidateBindings,
          evidenceIndex: { sha256: createHash("sha256").update("infrastructure-failure").digest("hex") },
          runResourceInventory: snapshot,
          primaryOutcome: {
            status: "failed",
            classification: "infrastructure_creation_failure",
            message: primaryError instanceof Error ? primaryError.message : String(primaryError),
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/cleanup-consensus-acceptance.ts"), failureHarnessPath, cleanupPath],
        { cwd: process.cwd(), env: process.env, stdio: "inherit" },
      );
    } catch {}
    throw primaryError;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
