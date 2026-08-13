import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../lib/canonical-json";
import {
  appendCleanupJournal,
  latestCompletedCleanupOutcomes,
  nextCleanupAttempt,
  readCleanupJournal,
} from "../lib/acceptance-cleanup-journal";
import {
  assertProcessSignalAuthority,
  confirmTerminalQuiescence,
  cleanupReservedPath,
  planProcessGroupCleanup,
} from "../lib/acceptance-process-cleanup";
import {
  assertAcceptanceCleanupAuthority,
  orderAcceptanceResourcesForCleanup,
  type AcceptanceResourceRecord,
} from "../lib/acceptance-resource-inventory";
import { assertDisposableAcceptanceHarnessSafety } from "../lib/runtime-trust";
import { Pool } from "pg";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hashText = (value: string) => createHash("sha256").update(value).digest("hex");
const observeRetainedPath = async (path: string): Promise<{ sha256: string; size: number }> => {
  const stat = await lstat(path);
  if (stat.isFile())
    return {
      sha256: createHash("sha256")
        .update(Uint8Array.from(await readFile(path)))
        .digest("hex"),
      size: stat.size,
    };
  if (!stat.isDirectory()) throw new Error("retained evidence is neither a regular file nor directory");
  const entries = await readdir(path, { withFileTypes: true });
  const children = [];
  let size = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = await observeRetainedPath(resolve(path, entry.name));
    size += child.size;
    children.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file", ...child });
  }
  return { sha256: hash(children), size };
};
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
const processIdentity = (pid: number) => {
  try {
    return hashText(
      execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "pid="], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim(),
    );
  } catch {
    return null;
  }
};
const processCarriesOwnershipToken = (pid: number, token: string) => {
  if (!token) return false;
  try {
    return execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).includes(`MISSION_AGENT_PROVIDER_OWNERSHIP_TOKEN=${token}`);
  } catch {
    return false;
  }
};
const processCarriesAcceptanceOwnershipToken = (pid: number, token: string) => {
  if (!token) return false;
  try {
    return execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).includes(`CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN=${token}`);
  } catch {
    return false;
  }
};
const processesWithOwnershipToken = (token: string) => {
  if (!token) return [];
  try {
    return execFileSync("/bin/ps", ["axeww", "-o", "pid=", "-o", "command="], {
      encoding: "utf8",
      timeout: 3_000,
    })
      .split(/\r?\n/)
      .filter((line) => line.includes(`CONSENSUS_ACCEPTANCE_RESOURCE_TOKEN=${token}`))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  } catch {
    return [];
  }
};
const processGroupMembers = (pgid: number) => {
  try {
    return execFileSync("/bin/ps", ["-g", String(pgid), "-o", "pid="], { encoding: "utf8", timeout: 2_000 })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1)
      .map((pid) => ({ pid, identity: processIdentity(pid) }))
      .filter((member): member is { pid: number; identity: string } => Boolean(member.identity));
  } catch {
    return [];
  }
};
const listenerAlive = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const socket = createConnection({ host, port });
    const finish = (alive: boolean) => {
      socket.destroy();
      done(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });

export const acceptanceCleanupSucceeded = (
  resources: Array<Record<string, unknown>>,
  outcomes: Array<Record<string, unknown>>,
) =>
  outcomes.length === resources.length &&
  outcomes.every((outcome) => {
    const resource = resources.find((candidate) => candidate.resourceId === outcome.resourceId);
    const terminalObservation = outcome.observation as Record<string, unknown> | undefined;
    const stoppedResource = [
      "database_process",
      "mission_control_server",
      "listener",
      "mission_agent_process",
      "provider_subprocess",
      "process_group",
      "other_run_scoped_resource",
    ].includes(String(resource?.type));
    const deletedResource = resource?.cleanupPolicy === "delete";
    return (
      resource &&
      terminalObservation &&
      terminalObservation.resourceTerminallyVerified === true &&
      typeof terminalObservation.resourceTerminallyVerifiedAt === "string" &&
      outcome.state === resource.expectedTerminalState &&
      terminalObservation.observedTerminalState === outcome.state &&
      outcome.state !== "cleanup_failed" &&
      outcome.state !== "cleanup_failed_unsafe_identity" &&
      terminalObservation.error === undefined &&
      terminalObservation?.surviving !== true &&
      terminalObservation?.stillListening !== true &&
      (!stoppedResource || outcome.state !== "stopped" || terminalObservation.surviving === false) &&
      (!deletedResource || outcome.state !== "deleted" || terminalObservation.exists === false)
    );
  });

const boundedAcceptancePath = async (
  candidate: string,
  acceptanceRoot: string,
  options: { allowGovernedSupervisorRoot?: boolean } = {},
) => {
  const root = await realpath(resolve(acceptanceRoot));
  const absolute = resolve(candidate);
  let existingAncestor = absolute;
  const missingSegments: string[] = [];
  while (
    !(await lstat(existingAncestor)
      .then(() => true)
      .catch(() => false))
  ) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("cleanup path has no canonical ancestor");
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const path = resolve(await realpath(existingAncestor), ...missingSegments);
  if (path !== root && path.startsWith(`${root}${sep}`)) return path;
  if (options.allowGovernedSupervisorRoot) {
    const privateTmp = await realpath("/private/tmp");
    const relativeExternal = relative(privateTmp, path);
    const [supervisorName] = relativeExternal.split(sep);
    if (
      /^mc-it-[a-f0-9]{20}$/.test(supervisorName ?? "") &&
      relativeExternal !== "" &&
      !relativeExternal.startsWith(`..${sep}`) &&
      relativeExternal !== ".."
    )
      return path;
  }
  throw new Error("cleanup path escapes acceptance root");
};
const governedExternalSupervisorResource = (resource: AcceptanceResourceRecord) =>
  ["sandbox_root", "temporary_directory", "diagnostic_artifact"].includes(resource.type) &&
  String(resource.creatingStep).startsWith("provider.spawn");

const removeBoundedPostgresDirectory = async (candidate: string, acceptanceRoot: string) => {
  const path = await boundedAcceptancePath(candidate, acceptanceRoot);
  const entry = await lstat(path).catch(() => null);
  if (!entry) return path;
  if (entry.isSymbolicLink()) throw new Error("PostgreSQL data-directory path is a symbolic link");
  if (!entry.isDirectory()) throw new Error("PostgreSQL data-directory path is not a directory");
  const parent = await realpath(dirname(path));
  const name = basename(path);
  if (!name || name === "." || name === "..") throw new Error("PostgreSQL data-directory basename is unsafe");
  // The child starts with its cwd bound to the already-canonical parent inode. If an
  // ancestor is renamed or replaced after validation, relative rm remains anchored to
  // that inode. If the final entry is swapped for a symlink, rm removes the link itself
  // and does not traverse its target.
  execFileSync(
    "/bin/sh",
    [
      "-c",
      'test "$(/bin/pwd -P)" = "$1" || exit 71; exec /bin/rm -rf -- "$2"',
      "bounded-postgres-cleanup",
      parent,
      name,
    ],
    {
      cwd: parent,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "test" },
      stdio: "ignore",
      timeout: 30_000,
    },
  );
  return path;
};

const shutdownOwnedServerGeneration = async (
  identity: Record<string, unknown>,
  observation: Record<string, unknown>,
) => {
  const pid = Number(identity.pid);
  const pgid = Number(identity.pgid ?? pid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !Number.isSafeInteger(pgid) || pgid <= 1)
    throw new Error("invalid Mission Control server generation identity");
  const expectedIdentity = String(identity.processIdentitySha256 ?? "");
  const ownershipToken = String(identity.ownershipToken ?? "");
  const leaderIdentity = processIdentity(pid);
  const members = processGroupMembers(pgid);
  const tokenPids = processesWithOwnershipToken(ownershipToken);
  const allObservedPids = Array.from(new Set([...members.map((member) => member.pid), ...tokenPids]));
  const provenMembers = members.filter(
    (member) => member.pid === pid || processCarriesAcceptanceOwnershipToken(member.pid, ownershipToken),
  );
  if (leaderIdentity) {
    assertProcessSignalAuthority({
      pid,
      currentPid: process.pid,
      expectedIdentity,
      observedIdentity: leaderIdentity,
      processKind: "process",
    });
  } else if (members.length && (!ownershipToken || provenMembers.length !== members.length)) {
    throw new Error("cleanup_failed_unsafe_identity: server leader vanished and process-group ownership is ambiguous");
  }
  observation.serverGeneration = identity.generation ?? "initial";
  observation.pid = pid;
  observation.pgid = pgid;
  observation.processIdentitySha256 = expectedIdentity;
  observation.freshObservedGroupMembersBeforeCleanup = members;
  observation.freshOwnedDescendantPidsBeforeCleanup = tokenPids;
  observation.shutdownState = "shutdown_requested";
  observation.signalActions = [];
  const signal = (name: NodeJS.Signals) => {
    const currentMembers = processGroupMembers(pgid);
    const currentOwnedPids = processesWithOwnershipToken(ownershipToken);
    if (processIdentity(pid) === expectedIdentity) process.kill(-pgid, name);
    else {
      if (
        !ownershipToken ||
        currentMembers.some((member) => !processCarriesAcceptanceOwnershipToken(member.pid, ownershipToken))
      )
        throw new Error("cleanup_failed_unsafe_identity: server process-group identity changed during shutdown");
      for (const member of currentMembers) process.kill(member.pid, name);
    }
    for (const ownedPid of currentOwnedPids)
      if (ownedPid !== pid && !currentMembers.some((member) => member.pid === ownedPid) && processAlive(ownedPid))
        process.kill(ownedPid, name);
    (observation.signalActions as Array<Record<string, unknown>>).push({ signal: name, at: new Date().toISOString() });
  };
  if (groupAlive(pgid) || allObservedPids.some(processAlive)) signal("SIGTERM");
  observation.shutdownState = "sigterm_sent";
  let stopped = await confirmTerminalQuiescence(
    () => groupAlive(pgid) || processesWithOwnershipToken(ownershipToken).some(processAlive),
    () => delay(100),
  );
  if (!stopped) {
    signal("SIGKILL");
    observation.shutdownState = "sigkill_sent";
    stopped = await confirmTerminalQuiescence(
      () => groupAlive(pgid) || processesWithOwnershipToken(ownershipToken).some(processAlive),
      () => delay(100),
    );
  }
  observation.shutdownState = stopped ? "process_stopped" : "cleanup_failed";
  observation.surviving = !stopped;
  return stopped;
};

const freshTerminalVerification = async (
  resource: AcceptanceResourceRecord,
  acceptanceRoot: string,
  resources: Array<Record<string, unknown>>,
): Promise<Record<string, unknown> & { verified: boolean; verifiedAt: string }> => {
  const identity = resource.identity as Record<string, unknown>;
  const verifiedAt = new Date().toISOString();
  const evidence: Record<string, unknown> = {
    verifiedAt,
    resourceId: resource.resourceId,
    resourceType: resource.type,
  };
  if (resource.expectedTerminalState === "stopped") {
    if (resource.type === "listener") {
      if (
        typeof identity.host !== "string" ||
        !identity.host ||
        !Number.isSafeInteger(Number(identity.port)) ||
        Number(identity.port) <= 0 ||
        Number(identity.port) > 65535
      )
        return { ...evidence, verified: false, verificationError: "listener probe identity is invalid", verifiedAt };
      const alive = await listenerAlive(String(identity.host), Number(identity.port));
      return { ...evidence, verified: !alive, surviving: alive, stillListening: alive, verifiedAt };
    }
    const pid = Number(identity.pid);
    const pgid = Number(identity.pgid ?? identity.pid);
    const ownershipToken = String(identity.ownershipToken ?? "");
    const processLike = [
      "database_process",
      "mission_control_server",
      "mission_agent_process",
      "provider_subprocess",
      "other_run_scoped_resource",
    ].includes(resource.type);
    if (
      (resource.type === "process_group" && (!Number.isSafeInteger(pgid) || pgid <= 1)) ||
      (processLike &&
        (!Number.isSafeInteger(pid) ||
          pid <= 1 ||
          typeof identity.processIdentitySha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(identity.processIdentitySha256))) ||
      (["database_process", "mission_control_server"].includes(resource.type) &&
        (!Number.isSafeInteger(pgid) || pgid <= 1 || !ownershipToken))
    )
      return {
        ...evidence,
        verified: false,
        surviving: true,
        verificationError: "process terminal probe identity is missing or invalid",
        verifiedAt,
      };
    const matchingPid =
      Number.isSafeInteger(pid) && pid > 1 && processIdentity(pid) === String(identity.processIdentitySha256 ?? "");
    const groupMembers = Number.isSafeInteger(pgid) && pgid > 1 ? processGroupMembers(pgid) : [];
    const ownedDescendantPids = ownershipToken ? processesWithOwnershipToken(ownershipToken) : [];
    const linkedListeners = resources
      .filter(
        (candidate) =>
          candidate.type === "listener" &&
          (candidate.dependsOn as string[] | undefined)?.includes(String(resource.resourceId)),
      )
      .concat(
        resources.filter(
          (candidate) =>
            (candidate.identity as Record<string, unknown> | undefined)?.owningServerResourceId ===
              resource.resourceId ||
            (candidate.type === "postgres_data_directory" &&
              (candidate.identity as Record<string, unknown> | undefined)?.databaseServiceResourceId ===
                resource.resourceId),
        ),
      );
    const listenerObservations = await Promise.all(
      linkedListeners.map(async (candidate) => {
        const listener = candidate.identity as Record<string, unknown>;
        return {
          resourceId: candidate.resourceId,
          host: listener.host,
          port: listener.port,
          alive: await listenerAlive(String(listener.host), Number(listener.port)),
        };
      }),
    );
    const surviving =
      matchingPid ||
      groupMembers.length > 0 ||
      ownedDescendantPids.length > 0 ||
      listenerObservations.some((item) => item.alive);
    return {
      ...evidence,
      verified: !surviving,
      surviving,
      matchingPid,
      groupMembers,
      ownedDescendantPids,
      listenerObservations,
      verifiedAt,
    };
  }
  if (
    resource.expectedTerminalState === "deleted" &&
    (typeof identity.path === "string" || typeof identity.worktreePath === "string")
  ) {
    const path = await boundedAcceptancePath(String(identity.path ?? identity.worktreePath), acceptanceRoot, {
      allowGovernedSupervisorRoot: governedExternalSupervisorResource(resource),
    }).catch(() => null);
    if (!path)
      return {
        ...evidence,
        verified: false,
        exists: true,
        verificationError: "cleanup path authority is invalid",
        verifiedAt,
      };
    const exists = await lstat(path)
      .then(() => true)
      .catch(() => false);
    return { ...evidence, verified: !exists, exists, canonicalPath: path, verifiedAt };
  }
  if (resource.type === "disposable_database" && resource.expectedTerminalState === "deleted") {
    const serviceId = String((resource.dependsOn as string[] | undefined)?.[0] ?? "");
    const service = resources.find(
      (candidate) => candidate.resourceId === serviceId && candidate.type === "database_process",
    );
    const serviceIdentity = service?.identity as Record<string, unknown> | undefined;
    const directory = resources.find(
      (candidate) =>
        candidate.type === "postgres_data_directory" &&
        (candidate.identity as Record<string, unknown> | undefined)?.databaseServiceResourceId === serviceId,
    );
    const directoryIdentity = directory?.identity as Record<string, unknown> | undefined;
    const pid = Number(serviceIdentity?.pid);
    const pgid = Number(serviceIdentity?.pgid ?? serviceIdentity?.pid);
    const ownershipToken = String(serviceIdentity?.ownershipToken ?? "");
    const processIdentitySha256 = String(serviceIdentity?.processIdentitySha256 ?? "");
    const port = Number(directoryIdentity?.port);
    const host = String(directoryIdentity?.host ?? "");
    if (
      !service ||
      !directory ||
      typeof directoryIdentity?.path !== "string" ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      !Number.isSafeInteger(pgid) ||
      pgid <= 1 ||
      !/^[a-f0-9]{64}$/.test(processIdentitySha256) ||
      !ownershipToken ||
      !host ||
      !Number.isSafeInteger(port) ||
      port <= 0 ||
      port > 65535
    )
      return {
        ...evidence,
        verified: false,
        verificationError: "database terminal probe authority is incomplete",
        verifiedAt,
      };
    const directoryPath = await boundedAcceptancePath(directoryIdentity.path, acceptanceRoot).catch(() => null);
    const directoryExists = directoryPath
      ? await lstat(directoryPath)
          .then(() => true)
          .catch(() => false)
      : true;
    const listening = await listenerAlive(host, port);
    const matchingPid = processIdentity(pid) === processIdentitySha256;
    const groupMembers = Number.isSafeInteger(pgid) && pgid > 1 ? processGroupMembers(pgid) : [];
    const ownedDescendantPids = ownershipToken ? processesWithOwnershipToken(ownershipToken) : [];
    const verified =
      !directoryExists && !listening && !matchingPid && groupMembers.length === 0 && ownedDescendantPids.length === 0;
    return {
      ...evidence,
      verified,
      exists: !verified,
      databaseName: identity.databaseName,
      databaseServiceResourceId: serviceId,
      directoryPath,
      directoryExists,
      listening,
      matchingPid,
      groupMembers,
      ownedDescendantPids,
      verificationBasis: "governed_cluster_absent",
      verifiedAt,
    };
  }
  if (
    resource.expectedTerminalState === "retained_with_approved_reason" &&
    typeof identity.path === "string" &&
    !identity.path.includes("#")
  ) {
    const retained = await observeRetainedPath(await boundedAcceptancePath(identity.path, acceptanceRoot)).catch(
      () => null,
    );
    return {
      ...evidence,
      verified: retained !== null,
      retainedArtifactSha256: retained?.sha256,
      retainedArtifactSize: retained?.size,
      verifiedAt,
    };
  }
  return { ...evidence, verified: true, verifiedAt };
};

const priorOutcomeStillTerminal = async (
  resource: AcceptanceResourceRecord,
  acceptanceRoot: string,
  priorOutcome: Record<string, unknown>,
) => {
  const identity = resource.identity as Record<string, unknown>;
  if (resource.expectedTerminalState === "stopped") {
    if (resource.type === "listener") return !(await listenerAlive(String(identity.host), Number(identity.port)));
    if (resource.type === "process_group") return !groupAlive(Number(identity.pgid));
    if (resource.type === "mission_control_server") return !groupAlive(Number(identity.pgid ?? identity.pid));
    if (identity.pid) return !processAlive(Number(identity.pid));
  }
  if (
    resource.expectedTerminalState === "deleted" &&
    (typeof identity.path === "string" || typeof identity.worktreePath === "string")
  ) {
    const path = await boundedAcceptancePath(String(identity.path ?? identity.worktreePath), acceptanceRoot, {
      allowGovernedSupervisorRoot: governedExternalSupervisorResource(resource),
    }).catch(() => resolve(String(identity.path ?? identity.worktreePath)));
    return !(await lstat(path)
      .then(() => true)
      .catch(() => false));
  }
  if (resource.expectedTerminalState === "retained_with_approved_reason" && typeof identity.path === "string") {
    if (identity.path.includes("#")) return true;
    const path = await boundedAcceptancePath(identity.path, acceptanceRoot);
    const retained = await observeRetainedPath(path).catch(() => null);
    const observation = priorOutcome.observation as Record<string, unknown> | undefined;
    return (
      retained !== null &&
      retained.sha256 === observation?.retainedArtifactSha256 &&
      retained.size === observation?.retainedArtifactSize
    );
  }
  return true;
};

export async function runAcceptanceCleanup(
  harnessArg: string,
  outputArg: string,
  dependencies: { assertSafety?: typeof assertDisposableAcceptanceHarnessSafety } = {},
) {
  if (!harnessArg || !outputArg) throw new Error("Usage: cleanup-consensus-acceptance <harness.json> <cleanup.json>");
  const { acceptanceRoot } = (dependencies.assertSafety ?? assertDisposableAcceptanceHarnessSafety)();
  const harness = JSON.parse(await readFile(resolve(harnessArg), "utf8"));
  const inventory = harness.runResourceInventory as Record<string, unknown> | undefined;
  const resources = inventory?.resources as Array<Record<string, unknown>> | undefined;
  if (
    !inventory ||
    inventory.acceptanceRunId !== harness.workspaceId ||
    !Array.isArray(resources) ||
    !resources.length ||
    (Array.isArray(inventory.outcomes) && inventory.outcomes.length)
  )
    throw new Error("Cleanup requires the exact unclosed authoritative run inventory");
  assertAcceptanceCleanupAuthority({
    acceptanceRunId: harness.workspaceId,
    candidateBindings: harness.candidateBindings,
    inventory,
  });
  const cleanupJournalPath = resolve(`${harnessArg}.cleanup-journal.ndjson`);
  let cleanupJournal = readCleanupJournal(cleanupJournalPath, String(harness.workspaceId), String(inventory.sha256));
  const completedOutcomes = latestCompletedCleanupOutcomes(cleanupJournal);
  const cleanupRunId = randomUUID();
  const startedAt = new Date().toISOString();
  const outcomes: Array<Record<string, unknown>> = [];
  for (const resource of orderAcceptanceResourcesForCleanup(resources as unknown as AcceptanceResourceRecord[])) {
    const priorOutcome = completedOutcomes.get(String(resource.resourceId));
    if (
      priorOutcome?.state === resource.expectedTerminalState &&
      (await priorOutcomeStillTerminal(resource, acceptanceRoot, priorOutcome as unknown as Record<string, unknown>))
    ) {
      outcomes.push(priorOutcome as unknown as Record<string, unknown>);
      continue;
    }
    const attempt = nextCleanupAttempt(cleanupJournal, String(resource.resourceId));
    const operationId = randomUUID();
    const attemptStartedAt = new Date().toISOString();
    appendCleanupJournal(cleanupJournalPath, {
      cleanupRunId,
      cleanupOperationId: operationId,
      acceptanceRunId: String(harness.workspaceId),
      inventorySha256: String(inventory.sha256),
      resourceId: String(resource.resourceId),
      expectedPriorState: priorOutcome?.state ?? "registered",
      attemptedAction: String(resource.cleanupPolicy),
      attempt,
      phase: "started",
      startedAt: attemptStartedAt,
    });
    const identity = resource.identity as Record<string, unknown>;
    const observation: Record<string, unknown> = {
      resourceId: resource.resourceId,
      resourceType: resource.type,
      expectedTerminalState: resource.expectedTerminalState,
      observedTerminalState: "cleanup_failed",
      cleanupAction: resource.cleanupPolicy,
      probeIdentity: "probe:not_started",
      cleanupStartedAt: attemptStartedAt,
    };
    let state = "cleanup_failed";
    let retainedReason: string | undefined;
    try {
      if (resource.type === "postgres_data_directory") {
        const candidatePath = String(identity.path ?? identity.intendedPath ?? "");
        const path = await boundedAcceptancePath(candidatePath, acceptanceRoot);
        const serviceId = String(identity.databaseServiceResourceId ?? "");
        const service = resources.find((candidate) => candidate.resourceId === serviceId);
        const serviceIdentity = service?.identity as Record<string, unknown> | undefined;
        const serviceOutcome = outcomes.find((candidate) => candidate.resourceId === serviceId);
        if (
          identity.acceptanceRunId !== harness.workspaceId ||
          identity.candidateArtifactSha256 !== harness.candidateBindings.artifactSha256 ||
          typeof identity.ownershipToken !== "string" ||
          !identity.ownershipToken
        )
          throw new Error("PostgreSQL data-directory authority binding is invalid");
        if (service) {
          const serviceDataPath = await boundedAcceptancePath(
            String(serviceIdentity?.dataDirectory ?? ""),
            acceptanceRoot,
          );
          if (
            service.type !== "database_process" ||
            !(service.dependsOn as string[] | undefined)?.includes(String(resource.resourceId)) ||
            serviceDataPath !== path
          )
            throw new Error("PostgreSQL data-directory service binding is invalid");
          if (!serviceOutcome || !["stopped", "creation_failed"].includes(String(serviceOutcome.state)))
            throw new Error("PostgreSQL data-directory dependency is not terminal");
          const servicePid = Number(serviceIdentity?.pid);
          if (Number.isSafeInteger(servicePid) && servicePid > 1 && processAlive(servicePid))
            throw new Error("PostgreSQL data-directory process is still live");
        } else if (!["creation_reserved", "created"].includes(String(resource.lifecycleState))) {
          throw new Error("PostgreSQL data-directory service is missing outside its creation crash window");
        }
        const host = String(identity.host ?? "");
        const port = Number(identity.port);
        if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65535 || (await listenerAlive(host, port)))
          throw new Error("PostgreSQL data-directory listener is not terminal");
        await removeBoundedPostgresDirectory(path, acceptanceRoot);
        observation.probeIdentity = `probe:postgres_data_directory_absent:${hashText(path)}`;
        observation.canonicalPath = path;
        observation.databaseServiceResourceId = serviceId;
        observation.dependentServiceState = serviceOutcome?.state ?? "not_registered_before_launcher_crash";
        observation.listenerAbsent = true;
        observation.exists = await lstat(path)
          .then(() => true)
          .catch(() => false);
        state = observation.exists
          ? "cleanup_failed"
          : !service && resource.lifecycleState === "creation_reserved"
            ? "creation_failed"
            : "deleted";
      } else if (resource.lifecycleState === "creation_failed") {
        observation.probeIdentity = `probe:creation_failure:${resource.reservationIdentity}`;
        observation.creationFailure = resource.creationFailure;
        state = "creation_failed";
      } else if (
        resource.lifecycleState === "creation_reserved" &&
        ["database_process", "mission_control_server", "other_run_scoped_resource"].includes(resource.type)
      ) {
        const ownedPids = processesWithOwnershipToken(String(identity.ownershipToken ?? ""));
        observation.probeIdentity = `probe:reservation_ownership_token:${resource.reservationIdentity}`;
        observation.reservationOwnedPids = ownedPids;
        for (const pid of ownedPids) process.kill(pid, "SIGTERM");
        await delay(500);
        for (const pid of ownedPids) if (processAlive(pid)) process.kill(pid, "SIGKILL");
        state = ownedPids.some(processAlive) ? "cleanup_failed" : ownedPids.length ? "stopped" : "creation_failed";
      } else if (resource.lifecycleState === "creation_reserved" && resource.type === "disposable_database") {
        const databaseService = resources.find((candidate) => candidate.resourceId === resource.dependsOn?.[0]);
        const serviceIdentity = databaseService?.identity as Record<string, unknown> | undefined;
        const dataDirectory = String(serviceIdentity?.dataDirectory ?? "");
        const directoryResource = resources.find(
          (candidate) =>
            candidate.type === "postgres_data_directory" &&
            (candidate.identity as Record<string, unknown> | undefined)?.path === dataDirectory,
        );
        const directoryIdentity = directoryResource?.identity as Record<string, unknown> | undefined;
        const host = String(directoryIdentity?.host ?? "");
        const port = Number(directoryIdentity?.port);
        if (!host || !Number.isSafeInteger(port) || port <= 0 || (await listenerAlive(host, port)))
          throw new Error("Reserved disposable database creation state is unresolved while its server is reachable");
        observation.probeIdentity = `probe:reserved_database_listener_absent:${host}:${port}`;
        observation.listenerAbsent = true;
        state = "creation_failed";
      } else if (resource.lifecycleState === "creation_reserved" && typeof identity.intendedPath === "string") {
        const reservedCleanup = await cleanupReservedPath({
          intendedPath: identity.intendedPath,
          acceptanceRoot,
          remove: (path) => rm(path, { recursive: true, force: true }),
          exists: (path) =>
            lstat(path)
              .then(() => true)
              .catch(() => false),
        });
        const path = reservedCleanup.path;
        observation.probeIdentity = `probe:reserved_lstat_absent:${hashText(path)}`;
        observation.exists = !reservedCleanup.deleted;
        state = observation.exists ? "cleanup_failed" : "deleted";
      } else if (resource.expectedTerminalState === "never_created") {
        observation.probeIdentity = "probe:inventory_creation_record/1";
        state = "never_created";
      } else if (resource.expectedTerminalState === "spawn_failed") {
        observation.probeIdentity = "probe:spawn_failure_record/1";
        state = "spawn_failed";
      } else if (resource.cleanupPolicy === "retain_evidence_only") {
        observation.probeIdentity = `probe:retention_policy:${resource.retentionPolicyIdentity}`;
        if (typeof identity.path === "string" && !String(identity.path).includes("#")) {
          const retainedPath = resolve(String(identity.path));
          const retainedStat = await lstat(retainedPath).catch(() => null);
          observation.retainedPathExistsAtCleanup = Boolean(retainedStat);
          if (!retainedStat) throw new Error("retained evidence resource does not exist");
          const retained = await observeRetainedPath(retainedPath);
          observation.retainedArtifactSha256 = retained.sha256;
          observation.retainedArtifactSize = retained.size;
          observation.retainedArtifactCreatedAt = retainedStat.birthtime.toISOString();
          observation.retainedArtifactSealedAt = new Date().toISOString();
        }
        state = "retained_with_approved_reason";
        retainedReason = "bounded disposable acceptance evidence retained for local review";
      } else if (resource.type === "listener") {
        const host = String(identity.host);
        const port = Number(identity.port);
        observation.probeIdentity = `probe:tcp_connect:${host}:${port}`;
        observation.surviving = await listenerAlive(host, port);
        state = observation.surviving ? "cleanup_failed" : "stopped";
      } else if (resource.type === "process_group") {
        const pgid = Number(identity.pgid);
        if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("invalid process group");
        const plan = planProcessGroupCleanup({
          groupAlive: groupAlive(pgid),
          leaderPid: pgid,
          expectedLeaderIdentity: String(identity.processIdentitySha256 ?? ""),
          observedLeaderIdentity: processIdentity(pgid),
          persistedDescendants: (() => {
            const persisted =
              typeof identity.persistedDescendantsJson === "string"
                ? (JSON.parse(identity.persistedDescendantsJson) as Array<{ pid: number; identity: string }>)
                : [];
            const observed = processGroupMembers(pgid).filter((member) => member.pid !== pgid);
            if (
              !processIdentity(pgid) &&
              typeof identity.ownershipToken === "string" &&
              observed.length &&
              observed.every((member) => processCarriesOwnershipToken(member.pid, identity.ownershipToken as string))
            )
              return observed;
            return persisted;
          })(),
          observedDescendants: processGroupMembers(pgid).filter((member) => member.pid !== pgid),
        });
        observation.processGroupAuthority = plan.action;
        if (plan.action === "fail_unsafe_identity") {
          state = "cleanup_failed_unsafe_identity";
          throw new Error(`refusing unsafe process-group signal: ${plan.reason}`);
        }
        if (plan.action === "signal_proven_descendants") for (const pid of plan.pids) process.kill(pid, "SIGTERM");
        else if (groupAlive(pgid)) process.kill(-pgid, "SIGTERM");
        await delay(500);
        if (plan.action === "signal_proven_descendants") {
          for (const pid of plan.pids) if (processAlive(pid)) process.kill(pid, "SIGKILL");
        } else if (groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
        await delay(500);
        observation.probeIdentity = `probe:process_group_identity_and_descendant_quiescence:${pgid}`;
        observation.surviving = !(await confirmTerminalQuiescence(
          () => groupAlive(pgid),
          async () => {
            await delay(100);
          },
        ));
        state = observation.surviving ? "cleanup_failed" : "stopped";
      } else if (resource.type === "disposable_database") {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl || hashText(databaseUrl) !== identity.databaseUrlSha256)
          throw new Error("database cleanup identity mismatch");
        const url = new URL(databaseUrl);
        const databaseName = url.pathname.slice(1);
        if (
          databaseName !== identity.databaseName ||
          !/^[A-Za-z0-9_-]{1,63}$/.test(databaseName) ||
          ["postgres", "template0", "template1"].includes(databaseName)
        )
          throw new Error("unsafe disposable database identity");
        url.pathname = "/postgres";
        const pool = new Pool({ connectionString: url.toString(), max: 1 });
        try {
          await pool.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
            [databaseName],
          );
          await pool.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}" WITH (FORCE)`);
          const remains = await pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName]);
          observation.probeIdentity = `probe:pg_database_catalog_absent:${databaseName}`;
          observation.exists = remains.rowCount !== 0;
          state = observation.exists ? "cleanup_failed" : "deleted";
        } finally {
          await pool.end();
        }
      } else if (["mission_control_server", "database_process"].includes(String(resource.type)) && identity.pid) {
        observation.probeIdentity = `probe:server_generation_terminal_quiescence:${identity.generation ?? "initial"}:${identity.pid}`;
        state = (await shutdownOwnedServerGeneration(identity, observation)) ? "stopped" : "cleanup_failed";
      } else if (
        ["mission_agent_process", "provider_subprocess", "other_run_scoped_resource"].includes(String(resource.type)) &&
        identity.pid
      ) {
        const pid = Number(identity.pid);
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("invalid process");
        if (processAlive(pid))
          assertProcessSignalAuthority({
            pid,
            currentPid: process.pid,
            expectedIdentity: String(identity.processIdentitySha256 ?? ""),
            observedIdentity: processIdentity(pid),
            processKind: "process",
          });
        if (processAlive(pid)) process.kill(pid, "SIGTERM");
        await delay(500);
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
        await delay(500);
        observation.probeIdentity = `probe:process_identity_and_terminal_quiescence:${pid}`;
        observation.surviving = !(await confirmTerminalQuiescence(
          () => processAlive(pid),
          async () => {
            await delay(100);
          },
        ));
        state = observation.surviving ? "cleanup_failed" : "stopped";
      } else if (
        typeof identity.path === "string" ||
        (resource.type === "local_implementation_commit" && typeof identity.worktreePath === "string")
      ) {
        const path = await boundedAcceptancePath(String(identity.path ?? identity.worktreePath), acceptanceRoot, {
          allowGovernedSupervisorRoot: governedExternalSupervisorResource(resource),
        });
        if (resource.type === "registry_copy") {
          observation.registryDeactivatedAt = new Date().toISOString();
          await chmod(path, 0o700).catch(() => undefined);
        }
        await rm(path, { recursive: true, force: true });
        observation.probeIdentity = `probe:lstat_absent:${hashText(path)}`;
        observation.exists = await lstat(path)
          .then(() => true)
          .catch(() => false);
        state = observation.exists ? "cleanup_failed" : String(resource.expectedTerminalState);
      } else {
        throw new Error("resource has no bounded cleanup adapter");
      }
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error);
      if (String(observation.error).startsWith("cleanup_failed_unsafe_identity:"))
        state = "cleanup_failed_unsafe_identity";
    }
    observation.observedTerminalState = state;
    if (state === "creation_failed") observation.expectedTerminalState = "creation_failed";
    observation.cleanupCompletedAt = new Date().toISOString();
    const outcome = {
      resourceId: resource.resourceId,
      acceptanceRunId: harness.workspaceId,
      state,
      ...(retainedReason ? { retainedReason, retentionPolicyIdentity: resource.retentionPolicyIdentity } : {}),
      completedAt: observation.cleanupCompletedAt,
      observation,
      cleanupEvidenceIdentity: hash(observation),
    };
    outcomes.push(outcome);
    appendCleanupJournal(cleanupJournalPath, {
      cleanupRunId,
      cleanupOperationId: operationId,
      acceptanceRunId: String(harness.workspaceId),
      inventorySha256: String(inventory.sha256),
      resourceId: String(resource.resourceId),
      expectedPriorState: priorOutcome?.state ?? "registered",
      attemptedAction: String(resource.cleanupPolicy),
      attempt,
      phase: "completed",
      startedAt: attemptStartedAt,
      completedAt: String(observation.cleanupCompletedAt),
      outcome: outcome as never,
      ...(observation.error ? { error: String(observation.error) } : {}),
    });
    cleanupJournal = readCleanupJournal(cleanupJournalPath, String(harness.workspaceId), String(inventory.sha256));
  }
  // Action completion is not terminal proof. Re-probe every resource only after all
  // cleanup actions have finished so a stale journal entry or surviving descendant
  // cannot certify the run as clean.
  for (const resource of resources as unknown as AcceptanceResourceRecord[]) {
    const outcomeIndex = outcomes.findIndex((candidate) => candidate.resourceId === resource.resourceId);
    if (outcomeIndex < 0) continue;
    const priorOutcome = outcomes[outcomeIndex];
    const verification = await freshTerminalVerification(resource, acceptanceRoot, resources);
    const priorObservation = priorOutcome.observation as Record<string, unknown>;
    const verifiedState = verification.verified ? priorOutcome.state : "cleanup_failed";
    const observation = {
      ...priorObservation,
      cleanupActionCompletedAt: priorObservation.cleanupCompletedAt,
      resourceTerminallyVerified: verification.verified,
      resourceTerminallyVerifiedAt: verification.verifiedAt,
      finalTerminalVerification: verification,
      ...(verification.verified
        ? {}
        : {
            error: priorObservation.error ?? "fresh terminal verification found a surviving or unresolved run resource",
          }),
      observedTerminalState: verifiedState,
      surviving: (verification.surviving as boolean | undefined) ?? priorObservation.surviving,
      stillListening: (verification.stillListening as boolean | undefined) ?? priorObservation.stillListening,
      exists: (verification.exists as boolean | undefined) ?? priorObservation.exists,
    };
    const verifiedOutcome = {
      ...priorOutcome,
      state: verifiedState,
      completedAt: verification.verifiedAt,
      observation,
      cleanupEvidenceIdentity: hash(observation),
    };
    outcomes[outcomeIndex] = verifiedOutcome;
    const operationId = randomUUID();
    appendCleanupJournal(cleanupJournalPath, {
      cleanupRunId,
      cleanupOperationId: operationId,
      acceptanceRunId: String(harness.workspaceId),
      inventorySha256: String(inventory.sha256),
      resourceId: String(resource.resourceId),
      expectedPriorState: String(priorOutcome.state),
      attemptedAction: "fresh_terminal_verification",
      attempt: nextCleanupAttempt(cleanupJournal, String(resource.resourceId)),
      phase: "terminally_verified",
      startedAt: String(verification.verifiedAt),
      completedAt: String(verification.verifiedAt),
      outcome: verifiedOutcome as never,
      ...(verification.verified ? {} : { error: String(observation.error) }),
    });
    cleanupJournal = readCleanupJournal(cleanupJournalPath, String(harness.workspaceId), String(inventory.sha256));
  }
  const terminalResources = resources.map((resource) =>
    resource.lifecycleState === "creation_reserved"
      ? {
          ...resource,
          lifecycleState: "creation_failed",
          ...(outcomes.find((outcome) => outcome.resourceId === resource.resourceId)?.state === "creation_failed"
            ? { expectedTerminalState: "creation_failed" }
            : {}),
        }
      : resource,
  );
  const inventoryBase: Record<string, unknown> = { ...inventory, resources: terminalResources };
  delete inventoryBase.sha256;
  const closedInventoryBase = { ...inventoryBase, outcomes };
  const closedInventory = { ...closedInventoryBase, sha256: hash(closedInventoryBase) };
  const report = {
    schemaVersion: "consensus-acceptance-cleanup-evidence/2",
    acceptanceRunId: harness.workspaceId,
    candidateBindings: harness.candidateBindings,
    evidenceIndexSha256: harness.evidenceIndex.sha256,
    startedAt,
    completedAt: new Date().toISOString(),
    cleanupJournalPath,
    cleanupJournalTerminalSha256: cleanupJournal.at(-1)?.entrySha256 ?? null,
    allRunResourcesAccounted: outcomes.length === resources.length,
    cleanupSucceeded: acceptanceCleanupSucceeded(terminalResources, outcomes),
    productionObservation: harness.missionAgent?.packetVerification?.startupTrust,
    resourceInventory: closedInventory,
  };
  await writeFile(resolve(outputArg), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [harnessArg, outputArg] = process.argv.slice(2);
  runAcceptanceCleanup(harnessArg, outputArg).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
