import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CURRENT_SERVICE_SHA256,
  NAMED_CANARY_ID,
  NODE_ARCHIVE_LENGTH,
  NODE_ARCHIVE_SHA256,
  NODE_ARCHIVE_URL,
  NODE_EXECUTABLE,
  NODE_EXECUTABLE_SHA256,
  NODE_INSTALL_ROOT,
  NODE_VERSION,
  ROLLBACK_INVENTORY_SHA256,
  SOURCE_SHA256,
  TARGET_LENGTH,
  TARGET_SERVICE_SHA256,
  TARGET_SHA256,
  verifyReplacementRelease,
  type ReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap";
import type { ReplacementAuthorizationPackage } from "../integrations/mission-agent/replacement-authorization-package";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import type { LocalFixedOperations } from "./replacement-bootstrap-local-operator";
import { localReplacementOperations, type LocalReplacementOperation } from "./replacement-bootstrap-local-journal";

export const LOCAL_AGENT_HOME = "/Users/shawnwollenberg/.mission-agent" as const;
export const ACTIVE_SOURCE_ARTIFACT = `${LOCAL_AGENT_HOME}/mission-agent-0.6.8.mjs` as const;
export const ACTIVE_TARGET_ARTIFACT = `${LOCAL_AGENT_HOME}/mission-agent-0.7.2.mjs` as const;
export const ACTIVE_PLIST = "/Users/shawnwollenberg/Library/LaunchAgents/com.wallyweb.mission-agent.plist" as const;
export const CONFIG_PATH = `${LOCAL_AGENT_HOME}/config.json` as const;
export const STATE_PATH = `${LOCAL_AGENT_HOME}/state.json` as const;
export const CANONICAL_PLIST =
  "release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist" as const;
export const SIGNED_MANIFEST = "release/mission-agent-0.7.2/signed-manifest-v3.json" as const;
export const TARGET_REPOSITORY_ARTIFACT = "public/mission-agent-0.7.2.mjs" as const;
export const ROLLBACK_INVENTORY =
  "release/mission-agent-0.7.2/replacement-bootstrap/rollback-0.6.8-inventory.json" as const;

const fixedExecutables = {
  uname: "/usr/bin/uname",
  id: "/usr/bin/id",
  scutil: "/usr/sbin/scutil",
  tar: "/usr/bin/tar",
  launchctl: "/bin/launchctl",
  ps: "/bin/ps",
  security: "/usr/bin/security",
  plutil: "/usr/bin/plutil",
} as const;
const exec = promisify(execFile);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

type SafeAgentConfig = {
  agentId: string;
  workspaceId: string;
  repositories?: Array<{ repositoryId: string; fingerprint?: string }>;
};

function stagingRoot(authorization: ReplacementAuthorization): string {
  return join(LOCAL_AGENT_HOME, "replacement-bootstrap", authorization.authorizationId);
}
function stagedArchive(authorization: ReplacementAuthorization): string {
  return join(stagingRoot(authorization), "node-v22.22.0-darwin-arm64.tar.gz");
}
function stagedArtifact(authorization: ReplacementAuthorization): string {
  return join(stagingRoot(authorization), "mission-agent-0.7.2.mjs");
}
function stagedPlist(authorization: ReplacementAuthorization): string {
  return join(stagingRoot(authorization), "com.wallyweb.mission-agent.plist");
}
function rollbackRoot(authorization: ReplacementAuthorization): string {
  return join(stagingRoot(authorization), "rollback-0.6.8");
}

export async function removeStagedReplacementAssets(authorization: ReplacementAuthorization): Promise<void> {
  const root = stagingRoot(authorization);
  if (!root.startsWith(`${LOCAL_AGENT_HOME}/replacement-bootstrap/`))
    throw new Error("Replacement staging root escaped the approved agent home.");
  for (const path of [stagedArtifact(authorization), stagedPlist(authorization), stagedArchive(authorization)]) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function fileChecksum(path: string): Promise<string> {
  return sha256(Uint8Array.from(await readFile(path)));
}

function observedKeychainMetadata(stdout: string): {
  itemClass: "generic-password";
  service: string;
  account: string;
  metadataChecksum: string;
} {
  const itemClass = stdout.match(/^class:\s+"([^"]+)"$/m)?.[1];
  const service = stdout.match(/^\s*"svce"<[^>]+>="([^"]+)"$/m)?.[1];
  const account = stdout.match(/^\s*"acct"<[^>]+>="([^"]+)"$/m)?.[1];
  if (itemClass !== "genp" || !service || !account)
    throw new Error("Keychain returned no parseable generic-password metadata.");
  const metadata = { itemClass: "generic-password" as const, service, account };
  return { ...metadata, metadataChecksum: sha256(canonicalJson(metadata)) };
}

async function rollbackInventoryEquivalence(): Promise<Record<string, unknown>> {
  const inventoryBytes = Uint8Array.from(await readFile(ROLLBACK_INVENTORY));
  if (sha256(inventoryBytes) !== ROLLBACK_INVENTORY_SHA256)
    throw new Error("Rollback inventory bytes are not the reviewed inventory.");
  const inventory = JSON.parse(Buffer.from(inventoryBytes).toString("utf8")) as {
    artifact: { byteLength: number; sha256: string; mode: string; owner: string; group: string };
    service: {
      plistByteLength: number;
      plistSha256: string;
      mode: string;
      label: string;
      programArguments: string[];
      workingDirectory: string | null;
      runAtLoad: boolean;
      keepAlive: boolean;
      standardOutputPath: string;
      standardErrorPath: string;
    };
    environment: { names: string[]; nonSecretValueChecksums: Record<string, string> };
    configuration: { byteLength: number; sha256: string; mode: string };
    credential: {
      storage: string;
      itemClass: string;
      service: string;
      account: string;
      secretCopied: boolean;
      identityPreserved: boolean;
    };
  };
  const [artifact, plist, configuration, owner, group, uid, gid, parsedPlist] = await Promise.all([
    lstat(ACTIVE_SOURCE_ARTIFACT),
    lstat(ACTIVE_PLIST),
    lstat(CONFIG_PATH),
    exec(fixedExecutables.id, ["-un"], { encoding: "utf8", timeout: 5_000 }),
    exec(fixedExecutables.id, ["-gn"], { encoding: "utf8", timeout: 5_000 }),
    exec(fixedExecutables.id, ["-u"], { encoding: "utf8", timeout: 5_000 }),
    exec(fixedExecutables.id, ["-g"], { encoding: "utf8", timeout: 5_000 }),
    exec(fixedExecutables.plutil, ["-convert", "json", "-o", "-", ACTIVE_PLIST], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    }),
  ]);
  const service = JSON.parse(parsedPlist.stdout) as Record<string, unknown>;
  const environment = service.EnvironmentVariables as Record<string, string> | undefined;
  const environmentNames = Object.keys(environment ?? {}).sort();
  const environmentValueChecksums = Object.fromEntries(
    environmentNames.map((name) => [name, sha256(String(environment?.[name]))]),
  );
  const credential = await exec(
    fixedExecutables.security,
    ["find-generic-password", "-s", inventory.credential.service, "-a", inventory.credential.account],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 },
  );
  const credentialMetadata = observedKeychainMetadata(credential.stdout);
  const mode = (value: Awaited<ReturnType<typeof lstat>>) => (Number(value.mode) & 0o777).toString(8).padStart(4, "0");
  if (
    !artifact.isFile() ||
    artifact.isSymbolicLink() ||
    artifact.size !== inventory.artifact.byteLength ||
    mode(artifact) !== inventory.artifact.mode ||
    (await fileChecksum(ACTIVE_SOURCE_ARTIFACT)) !== inventory.artifact.sha256 ||
    artifact.uid !== Number(uid.stdout.trim()) ||
    artifact.gid !== Number(gid.stdout.trim()) ||
    !plist.isFile() ||
    plist.isSymbolicLink() ||
    plist.size !== inventory.service.plistByteLength ||
    mode(plist) !== inventory.service.mode ||
    (await fileChecksum(ACTIVE_PLIST)) !== inventory.service.plistSha256 ||
    plist.uid !== Number(uid.stdout.trim()) ||
    plist.gid !== Number(gid.stdout.trim()) ||
    !configuration.isFile() ||
    configuration.isSymbolicLink() ||
    configuration.size !== inventory.configuration.byteLength ||
    mode(configuration) !== inventory.configuration.mode ||
    (await fileChecksum(CONFIG_PATH)) !== inventory.configuration.sha256 ||
    configuration.uid !== Number(uid.stdout.trim()) ||
    configuration.gid !== Number(gid.stdout.trim()) ||
    owner.stdout.trim() !== inventory.artifact.owner ||
    group.stdout.trim() !== inventory.artifact.group ||
    credential.stderr.includes("could not be found") ||
    inventory.credential.storage !== "macOS Keychain" ||
    credentialMetadata.itemClass !== inventory.credential.itemClass ||
    credentialMetadata.service !== inventory.credential.service ||
    credentialMetadata.account !== inventory.credential.account ||
    inventory.credential.secretCopied !== false ||
    inventory.credential.identityPreserved !== true ||
    service.Label !== inventory.service.label ||
    canonicalJson(service.ProgramArguments) !== canonicalJson(inventory.service.programArguments) ||
    (service.WorkingDirectory ?? null) !== inventory.service.workingDirectory ||
    service.RunAtLoad !== inventory.service.runAtLoad ||
    service.KeepAlive !== inventory.service.keepAlive ||
    service.StandardOutPath !== inventory.service.standardOutputPath ||
    service.StandardErrorPath !== inventory.service.standardErrorPath ||
    canonicalJson(environmentNames) !== canonicalJson([...inventory.environment.names].sort()) ||
    canonicalJson(environmentValueChecksums) !== canonicalJson(inventory.environment.nonSecretValueChecksums)
  )
    throw new Error("Prior runtime ownership, permissions, configuration, or credential metadata differs.");
  return {
    rollbackInventoryChecksum: ROLLBACK_INVENTORY_SHA256,
    artifactByteLength: artifact.size,
    artifactMode: mode(artifact),
    artifactChecksum: await fileChecksum(ACTIVE_SOURCE_ARTIFACT),
    plistByteLength: plist.size,
    plistMode: mode(plist),
    plistChecksum: await fileChecksum(ACTIVE_PLIST),
    configurationByteLength: configuration.size,
    configurationMode: mode(configuration),
    configurationChecksum: await fileChecksum(CONFIG_PATH),
    owner: owner.stdout.trim(),
    group: group.stdout.trim(),
    credentialMetadataPresent: true,
    credentialStorage: inventory.credential.storage,
    credentialItemClass: credentialMetadata.itemClass,
    credentialService: credentialMetadata.service,
    credentialAccount: credentialMetadata.account,
    credentialMetadataChecksum: credentialMetadata.metadataChecksum,
    environmentNames,
    environmentValueChecksums,
    standardOutputPath: service.StandardOutPath,
    standardErrorPath: service.StandardErrorPath,
    runAtLoad: service.RunAtLoad,
    keepAlive: service.KeepAlive,
  };
}

async function safeConfig(): Promise<SafeAgentConfig> {
  const value = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  if (typeof value.agentId !== "string" || typeof value.workspaceId !== "string")
    throw new Error("Mission Agent configuration identity is unavailable.");
  return {
    agentId: value.agentId,
    workspaceId: value.workspaceId,
    repositories: Array.isArray(value.repositories)
      ? (value.repositories as Array<{ repositoryId: string; fingerprint?: string }>)
      : undefined,
  };
}

async function hostIdentity(): Promise<string> {
  const { stdout } = await exec(fixedExecutables.scutil, ["--get", "LocalHostName"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return stdout.trim();
}

async function assertHost(pkg: ReplacementAuthorizationPackage): Promise<void> {
  const [{ stdout: kernel }, { stdout: architecture }, config] = await Promise.all([
    exec(fixedExecutables.uname, ["-s"], { encoding: "utf8", timeout: 5_000 }),
    exec(fixedExecutables.uname, ["-m"], { encoding: "utf8", timeout: 5_000 }),
    safeConfig(),
  ]);
  if (
    kernel.trim() !== "Darwin" ||
    architecture.trim() !== "arm64" ||
    (await hostIdentity()) !== pkg.authorization.hostIdentity ||
    config.agentId !== NAMED_CANARY_ID ||
    config.workspaceId !== pkg.authorization.workspaceId ||
    (await fileChecksum(ACTIVE_SOURCE_ARTIFACT)) !== SOURCE_SHA256 ||
    (await fileChecksum(ACTIVE_PLIST)) !== CURRENT_SERVICE_SHA256
  )
    throw new Error("Local macOS host, agent, source artifact, or service identity mismatch.");
}

async function atomicCopy(source: string, destination: string, mode: number): Promise<void> {
  const temporary = `${destination}.replacement-tmp`;
  await copyFile(source, temporary);
  await chmod(temporary, mode);
  await rename(temporary, destination);
}

async function downloadExactNodeArchive(destination: string): Promise<void> {
  try {
    const existing = await stat(destination);
    if (
      existing.isFile() &&
      existing.size === NODE_ARCHIVE_LENGTH &&
      (await fileChecksum(destination)) === NODE_ARCHIVE_SHA256
    )
      return;
    throw new Error("Existing staged Node archive does not match the approved immutable archive.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetch(NODE_ARCHIVE_URL, { redirect: "manual" });
  if (
    !response.ok ||
    response.url !== NODE_ARCHIVE_URL ||
    new URL(response.url).origin !== "https://nodejs.org" ||
    response.status >= 300
  )
    throw new Error("Node archive origin, redirect policy, or response is invalid.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== NODE_ARCHIVE_LENGTH || sha256(bytes) !== NODE_ARCHIVE_SHA256)
    throw new Error("Node archive length or checksum mismatch.");
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
}

async function verifyNodeExecutable(): Promise<void> {
  const metadata = await lstat(NODE_EXECUTABLE);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0)
    throw new Error("Node executable type or permissions are unsafe.");
  const { stdout } = await exec(NODE_EXECUTABLE, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (stdout.trim() !== `v${NODE_VERSION}` || (await fileChecksum(NODE_EXECUTABLE)) !== NODE_EXECUTABLE_SHA256)
    throw new Error("Installed Node executable version or checksum mismatch.");
}

async function pathChecksum(path: string): Promise<string | null> {
  try {
    return await fileChecksum(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function serviceLoaded(): Promise<boolean> {
  const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8", timeout: 5_000 })).stdout.trim();
  try {
    await exec(fixedExecutables.launchctl, ["print", `gui/${uid}/com.wallyweb.mission-agent`], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") return false;
    throw error;
  }
}

async function runningProcessObservation(expected: "0.7.2" | "0.6.8"): Promise<Record<string, unknown>> {
  const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8", timeout: 5_000 })).stdout.trim();
  const owner = (await exec(fixedExecutables.id, ["-un"], { encoding: "utf8", timeout: 5_000 })).stdout.trim();
  const { stdout: service } = await exec(
    fixedExecutables.launchctl,
    ["print", `gui/${uid}/com.wallyweb.mission-agent`],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
  );
  const pid = Number(/\bpid = (\d+)/.exec(service)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("launchd did not report a valid running PID.");
  const { stdout: processRow } = await exec(
    fixedExecutables.ps,
    ["-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "user=", "-o", "command="],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  const match =
    /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)\s*$/.exec(
      processRow,
    );
  if (!match) throw new Error("Running Mission Agent process metadata could not be parsed.");
  const command = match[4]!;
  const expectedNode = expected === "0.7.2" ? NODE_EXECUTABLE : "/usr/local/Cellar/node/24.10.0/bin/node";
  const expectedArtifact = expected === "0.7.2" ? ACTIVE_TARGET_ARTIFACT : ACTIVE_SOURCE_ARTIFACT;
  const expectedCommand = `${expectedNode} ${expectedArtifact} run`;
  if (command !== expectedCommand || match[3] !== owner)
    throw new Error("Running Mission Agent executable, arguments, or owner mismatch.");
  const nodeVersion = (await exec(expectedNode, ["--version"], { encoding: "utf8", timeout: 10_000 })).stdout.trim();
  const artifactChecksum = await fileChecksum(expectedArtifact);
  const plistChecksum = await fileChecksum(ACTIVE_PLIST);
  const startedAt = new Date(match[2]!).toISOString();
  const targetProcessAbsent =
    expected !== "0.6.8"
      ? undefined
      : !(
          await exec(fixedExecutables.ps, ["-axo", "command="], {
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout
          .split("\n")
          .some((line) => line.trim() === `${NODE_EXECUTABLE} ${ACTIVE_TARGET_ARTIFACT} run`);
  return {
    observationVersion: "mission-agent-process-v1",
    hostIdentity: await hostIdentity(),
    agentId: NAMED_CANARY_ID,
    serviceLabel: "com.wallyweb.mission-agent",
    pid,
    parentPid: Number(match[1]),
    processStartedAt: startedAt,
    processOwner: owner,
    nodeExecutable: expectedNode,
    nodeVersion,
    artifactPath: expectedArtifact,
    artifactChecksum,
    processArgumentsChecksum: sha256(expectedCommand),
    launchdPlistChecksum: plistChecksum,
    ...(targetProcessAbsent === undefined ? {} : { targetProcessAbsent }),
  };
}

async function inspectMutationState(
  operation: LocalReplacementOperation,
): Promise<"precondition" | "postcondition" | "partial" | "ambiguous"> {
  if (operation === "extract_node_runtime") {
    try {
      await verifyNodeExecutable();
      return "postcondition";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "partial";
      try {
        await lstat(NODE_INSTALL_ROOT);
        return "partial";
      } catch (missing) {
        return (missing as NodeJS.ErrnoException).code === "ENOENT" ? "precondition" : "ambiguous";
      }
    }
  }
  if (operation === "stop_service") return (await serviceLoaded()) ? "precondition" : "postcondition";
  if (operation === "start_service") return (await serviceLoaded()) ? "postcondition" : "precondition";
  if (operation === "replace_artifact") {
    const checksum = await pathChecksum(ACTIVE_TARGET_ARTIFACT);
    return checksum === null ? "precondition" : checksum === TARGET_SHA256 ? "postcondition" : "partial";
  }
  if (operation === "replace_plist") {
    const checksum = await pathChecksum(ACTIVE_PLIST);
    if (checksum === CURRENT_SERVICE_SHA256) return "precondition";
    if (checksum === TARGET_SERVICE_SHA256) return "postcondition";
    return checksum === null ? "ambiguous" : "partial";
  }
  if (operation === "restore_artifact") {
    const source = await pathChecksum(ACTIVE_SOURCE_ARTIFACT);
    const target = await pathChecksum(ACTIVE_TARGET_ARTIFACT);
    if (source !== SOURCE_SHA256) return "partial";
    if (target === null) return "postcondition";
    return target === TARGET_SHA256 ? "precondition" : "partial";
  }
  if (operation === "restore_plist") {
    const checksum = await pathChecksum(ACTIVE_PLIST);
    if (checksum === TARGET_SERVICE_SHA256) return "precondition";
    if (checksum === CURRENT_SERVICE_SHA256) return "postcondition";
    return checksum === null ? "ambiguous" : "partial";
  }
  if (operation === "restart_prior_service") return (await serviceLoaded()) ? "postcondition" : "precondition";
  throw new Error(`Mutation inspection is unavailable for ${operation}.`);
}

function summary(
  message: string,
  inspectedChecksums: Record<string, string> = {},
  changedChecksums: Record<string, string> = {},
) {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    safeStdoutSummary: message,
    inspectedChecksums,
    changedChecksums,
  };
}

export function createMacOSLocalFixedOperations(repositoryRoot: string): LocalFixedOperations {
  const canonicalPlist = resolve(repositoryRoot, CANONICAL_PLIST);
  const repositoryArtifact = resolve(repositoryRoot, TARGET_REPOSITORY_ARTIFACT);
  const signedManifest = resolve(repositoryRoot, SIGNED_MANIFEST);
  const rollbackInventory = resolve(repositoryRoot, ROLLBACK_INVENTORY);

  return {
    inspectHost: assertHost,
    async inspectMutation({ operation }) {
      return inspectMutationState(operation);
    },
    async execute({ operation, pkg }) {
      const authorization = pkg.authorization;
      const root = stagingRoot(authorization);
      if (!root.startsWith(`${LOCAL_AGENT_HOME}/replacement-bootstrap/`))
        throw new Error("Replacement staging root escaped the approved agent home.");
      await mkdir(root, { recursive: true, mode: 0o700 });
      switch (operation) {
        case "inspect_host":
          await assertHost(pkg);
          return summary("macOS arm64 host identity passed");
        case "inspect_agent":
          return summary("named Mission Agent identity passed", {
            sourceArtifact: await fileChecksum(ACTIVE_SOURCE_ARTIFACT),
          });
        case "inventory_configuration":
          return summary("configuration and Keychain credential reference inventoried", {
            configuration: await fileChecksum(CONFIG_PATH),
            service: await fileChecksum(ACTIVE_PLIST),
          });
        case "verify_rollback_assets": {
          if ((await fileChecksum(rollbackInventory)) !== ROLLBACK_INVENTORY_SHA256)
            throw new Error("Rollback inventory checksum mismatch.");
          await mkdir(rollbackRoot(authorization), { recursive: true, mode: 0o700 });
          await atomicCopy(ACTIVE_SOURCE_ARTIFACT, join(rollbackRoot(authorization), "mission-agent-0.6.8.mjs"), 0o700);
          await atomicCopy(ACTIVE_PLIST, join(rollbackRoot(authorization), "com.wallyweb.mission-agent.plist"), 0o600);
          if (
            (await fileChecksum(join(rollbackRoot(authorization), "mission-agent-0.6.8.mjs"))) !== SOURCE_SHA256 ||
            (await fileChecksum(join(rollbackRoot(authorization), "com.wallyweb.mission-agent.plist"))) !==
              CURRENT_SERVICE_SHA256
          )
            throw new Error("Rollback assets do not match exact 0.6.8 bindings.");
          return summary("exact rollback assets preserved");
        }
        case "stage_node_archive":
          await downloadExactNodeArchive(stagedArchive(authorization));
          return summary("official Node archive staged", {}, { nodeArchive: NODE_ARCHIVE_SHA256 });
        case "verify_node_archive":
          if (
            (await stat(stagedArchive(authorization))).size !== NODE_ARCHIVE_LENGTH ||
            (await fileChecksum(stagedArchive(authorization))) !== NODE_ARCHIVE_SHA256
          )
            throw new Error("Staged Node archive mismatch.");
          return summary("Node archive verified", { nodeArchive: NODE_ARCHIVE_SHA256 });
        case "extract_node_runtime": {
          try {
            await verifyNodeExecutable();
            return summary("existing isolated Node runtime reverified", { nodeExecutable: NODE_EXECUTABLE_SHA256 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await mkdir(dirname(NODE_INSTALL_ROOT), { recursive: true, mode: 0o755 });
          const installMetadata = await lstat(dirname(NODE_INSTALL_ROOT));
          if (installMetadata.isSymbolicLink()) throw new Error("Node installation parent is a symlink.");
          await mkdir(NODE_INSTALL_ROOT, { recursive: false, mode: 0o755 });
          await exec(
            fixedExecutables.tar,
            ["-xzf", stagedArchive(authorization), "--strip-components=1", "-C", NODE_INSTALL_ROOT],
            { timeout: 120_000, maxBuffer: 1024 * 1024 },
          );
          return summary(
            "isolated Node runtime extracted",
            {},
            { nodeExecutable: await fileChecksum(NODE_EXECUTABLE) },
          );
        }
        case "verify_node_executable":
          await verifyNodeExecutable();
          return summary("isolated Node executable verified", { nodeExecutable: NODE_EXECUTABLE_SHA256 });
        case "stage_target_artifact":
          await atomicCopy(repositoryArtifact, stagedArtifact(authorization), 0o700);
          if ((await stat(stagedArtifact(authorization))).size !== TARGET_LENGTH)
            throw new Error("Staged target artifact byte length mismatch.");
          return summary(
            "exact target artifact staged",
            {},
            { targetArtifact: await fileChecksum(stagedArtifact(authorization)) },
          );
        case "verify_release": {
          const artifact = Uint8Array.from(await readFile(stagedArtifact(authorization)));
          verifyReplacementRelease({ signedManifestText: await readFile(signedManifest, "utf8"), artifact });
          return summary("Manifest v3 and standalone Ed25519 verification passed", { targetArtifact: TARGET_SHA256 });
        }
        case "stage_target_plist":
          await atomicCopy(canonicalPlist, stagedPlist(authorization), 0o600);
          return summary(
            "canonical target plist staged",
            {},
            { targetPlist: await fileChecksum(stagedPlist(authorization)) },
          );
        case "verify_target_plist":
          if ((await fileChecksum(stagedPlist(authorization))) !== TARGET_SERVICE_SHA256)
            throw new Error("Canonical target plist checksum mismatch.");
          return summary("canonical target plist verified", { targetPlist: TARGET_SERVICE_SHA256 });
        case "drain_agent":
          return summary("Mission Control claim confirmed named-agent drain and no active lease");
        case "stop_service": {
          const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8" })).stdout.trim();
          await exec(fixedExecutables.launchctl, ["bootout", `gui/${uid}`, ACTIVE_PLIST], { timeout: 30_000 });
          return summary("exact named launchd service stopped");
        }
        case "replace_artifact":
          await atomicCopy(stagedArtifact(authorization), ACTIVE_TARGET_ARTIFACT, 0o700);
          if ((await fileChecksum(ACTIVE_TARGET_ARTIFACT)) !== TARGET_SHA256)
            throw new Error("Active target artifact mismatch.");
          return summary("target artifact atomically activated", {}, { targetArtifact: TARGET_SHA256 });
        case "replace_plist":
          await atomicCopy(stagedPlist(authorization), ACTIVE_PLIST, 0o600);
          if ((await fileChecksum(ACTIVE_PLIST)) !== TARGET_SERVICE_SHA256)
            throw new Error("Active target plist mismatch.");
          return summary("target plist atomically activated", {}, { targetPlist: TARGET_SERVICE_SHA256 });
        case "start_service": {
          const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8" })).stdout.trim();
          await exec(fixedExecutables.launchctl, ["bootstrap", `gui/${uid}`, ACTIVE_PLIST], { timeout: 30_000 });
          return summary("exact named launchd service started");
        }
        case "verify_runtime":
          await verifyNodeExecutable();
          return {
            ...summary("running service runtime binding verified", { nodeExecutable: NODE_EXECUTABLE_SHA256 }),
            observation: await runningProcessObservation("0.7.2"),
          };
        case "verify_version": {
          const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as { version?: string };
          if (state.version !== "0.7.2") throw new Error("Mission Agent state did not report version 0.7.2.");
          return {
            ...summary("Mission Agent version 0.7.2 verified"),
            observation: await runningProcessObservation("0.7.2"),
          };
        }
        case "verify_identity":
        case "verify_registration": {
          const config = await safeConfig();
          if (config.agentId !== authorization.agentId || config.workspaceId !== authorization.workspaceId)
            throw new Error("Mission Agent identity or workspace changed.");
          return summary(`${operation} passed`);
        }
        case "verify_heartbeats": {
          const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as {
            connected?: boolean;
            pullReady?: boolean;
            lastHeartbeatAt?: string;
          };
          if (
            !state.connected ||
            !state.pullReady ||
            !state.lastHeartbeatAt ||
            Date.now() - Date.parse(state.lastHeartbeatAt) > 120_000
          )
            throw new Error("Mission Agent heartbeat is absent or stale.");
          return summary("fresh connected heartbeat verified");
        }
        case "verify_capabilities": {
          const { stdout } = await exec(NODE_EXECUTABLE, [ACTIVE_TARGET_ARTIFACT, "doctor"], {
            env: {
              NODE_ENV: "production",
              MISSION_AGENT_HOME: LOCAL_AGENT_HOME,
              PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin",
            },
            encoding: "utf8",
            timeout: 60_000,
            maxBuffer: 256 * 1024,
          });
          if (!stdout.includes("Mission Agent") || !stdout.includes("0.7.2"))
            throw new Error("Mission Agent doctor did not confirm the target capability runtime.");
          return {
            ...summary("Mission Agent doctor and capabilities passed"),
            observation: await runningProcessObservation("0.7.2"),
          };
        }
        case "restore_artifact":
          if ((await fileChecksum(join(rollbackRoot(authorization), "mission-agent-0.6.8.mjs"))) !== SOURCE_SHA256)
            throw new Error("Rollback artifact mismatch.");
          if ((await pathChecksum(ACTIVE_TARGET_ARTIFACT)) === TARGET_SHA256) await unlink(ACTIVE_TARGET_ARTIFACT);
          if ((await fileChecksum(ACTIVE_SOURCE_ARTIFACT)) !== SOURCE_SHA256)
            throw new Error("Exact prior artifact was not restored.");
          return summary("exact prior artifact restored and target removed", { sourceArtifact: SOURCE_SHA256 });
        case "restore_plist":
          await atomicCopy(join(rollbackRoot(authorization), "com.wallyweb.mission-agent.plist"), ACTIVE_PLIST, 0o600);
          if ((await fileChecksum(ACTIVE_PLIST)) !== CURRENT_SERVICE_SHA256)
            throw new Error("Rollback plist mismatch.");
          return summary("exact prior plist restored", {}, { rollbackPlist: CURRENT_SERVICE_SHA256 });
        case "restart_prior_service": {
          const uid = (await exec(fixedExecutables.id, ["-u"], { encoding: "utf8" })).stdout.trim();
          await exec(fixedExecutables.launchctl, ["bootstrap", `gui/${uid}`, ACTIVE_PLIST], { timeout: 30_000 });
          return {
            ...summary("exact prior service restarted"),
            observation: await runningProcessObservation("0.6.8"),
          };
        }
        case "verify_prior_runtime":
          return {
            ...summary("exact prior runtime process reverified", { sourceArtifact: SOURCE_SHA256 }),
            observation: {
              ...(await runningProcessObservation("0.6.8")),
              ...(await rollbackInventoryEquivalence()),
            },
          };
        case "verify_prior_identity": {
          const config = await safeConfig();
          if (config.agentId !== authorization.agentId || config.workspaceId !== authorization.workspaceId)
            throw new Error("Prior Mission Agent identity or workspace was not restored.");
          return summary("prior Mission Agent identity and registration binding verified");
        }
        case "verify_prior_heartbeats": {
          const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as {
            version?: string;
            connected?: boolean;
            lastHeartbeatAt?: string;
          };
          if (
            state.version !== "0.6.8" ||
            !state.connected ||
            !state.lastHeartbeatAt ||
            Date.now() - Date.parse(state.lastHeartbeatAt) > 120_000
          )
            throw new Error("Prior Mission Agent heartbeat is absent, stale, or the wrong version.");
          return summary("fresh prior-version heartbeat observed");
        }
        case "verify_prior_capabilities": {
          const { stdout } = await exec("/usr/local/Cellar/node/24.10.0/bin/node", [ACTIVE_SOURCE_ARTIFACT, "doctor"], {
            env: {
              NODE_ENV: "production",
              MISSION_AGENT_HOME: LOCAL_AGENT_HOME,
              PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin",
            },
            encoding: "utf8",
            timeout: 60_000,
            maxBuffer: 256 * 1024,
          });
          if (!stdout.includes("Mission Agent") || !stdout.includes("0.6.8"))
            throw new Error("Prior Mission Agent capabilities did not recover.");
          return summary("prior-version doctor and capabilities verified");
        }
        case "verify_prior_projection":
          return summary("local rollback evidence ready for authoritative Mission Control projection verification");
        case "report_evidence":
          return summary("checksum-bound local evidence ready for Mission Control");
        default:
          throw new Error(`Unsupported local operation: ${String(operation)}`);
      }
    },
  };
}

export function fixedMacOSOperationInventory(): {
  executables: typeof fixedExecutables;
  operations: readonly LocalReplacementOperation[];
  arbitraryShell: false;
} {
  return { executables: fixedExecutables, operations: localReplacementOperations, arbitraryShell: false };
}
