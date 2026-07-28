import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import {
  NODE_EXECUTABLE,
  NODE_EXECUTABLE_SHA256,
  NODE_VERSION,
  ROLLBACK_INVENTORY_SHA256,
  SOURCE_SHA256,
  TARGET_SERVICE_SHA256,
  TARGET_SHA256,
  type ReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap";
import { localReplacementOperations, type LocalReplacementOperation } from "./replacement-bootstrap-local-journal";
import type { LocalFixedOperations } from "./replacement-bootstrap-local-operator";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

type DisposableState = {
  version: "1";
  authorizationId: string;
  operationCounts: Record<LocalReplacementOperation, number>;
  nodeInstalled: boolean;
  stopped: boolean;
  targetArtifactActive: boolean;
  targetPlistActive: boolean;
  targetRunning: boolean;
  priorRunning: boolean;
  targetProcessStartedAt: string | null;
  priorProcessStartedAt: string | null;
  priorInventoryChecksum: string;
  currentInventoryChecksum: string;
};

const priorArtifactBytes = "disposable exact Mission Agent 0.6.8 artifact bytes\n";
const targetArtifactBytes = "disposable exact Mission Agent 0.7.2 artifact bytes\n";
const priorPlistBytes = "disposable exact 0.6.8 launchd service definition\n";
const targetPlistBytes = "disposable exact 0.7.2 launchd service definition\n";
const configurationBytes = "disposable preserved Mission Agent configuration\n";

type FixturePaths = ReturnType<typeof fixturePaths>;

function fixturePaths(statePath: string) {
  const root = `${statePath}.host`;
  return {
    root,
    artifact: join(root, "mission-agent.mjs"),
    plist: join(root, "com.wallyweb.mission-agent.plist"),
    configuration: join(root, "config.json"),
    credentialMetadata: join(root, "credential-metadata.json"),
    serviceMetadata: join(root, "service-metadata.json"),
  };
}

const mode = (value: number) => (value & 0o777).toString(8).padStart(4, "0");

async function inventory(paths: FixturePaths): Promise<Record<string, unknown>> {
  const [artifact, plist, configuration, credentialMetadata, serviceMetadata] = await Promise.all([
    readFile(paths.artifact),
    readFile(paths.plist),
    readFile(paths.configuration),
    readFile(paths.credentialMetadata),
    readFile(paths.serviceMetadata),
  ]);
  const [artifactStat, plistStat, configurationStat, credentialStat, serviceStat] = await Promise.all([
    stat(paths.artifact),
    stat(paths.plist),
    stat(paths.configuration),
    stat(paths.credentialMetadata),
    stat(paths.serviceMetadata),
  ]);
  return {
    artifact: { sha256: sha256(Uint8Array.from(artifact)), bytes: artifact.byteLength, mode: mode(artifactStat.mode) },
    plist: { sha256: sha256(Uint8Array.from(plist)), bytes: plist.byteLength, mode: mode(plistStat.mode) },
    configuration: {
      sha256: sha256(Uint8Array.from(configuration)),
      bytes: configuration.byteLength,
      mode: mode(configurationStat.mode),
    },
    credentialMetadata: {
      sha256: sha256(Uint8Array.from(credentialMetadata)),
      bytes: credentialMetadata.byteLength,
      mode: mode(credentialStat.mode),
    },
    serviceMetadata: {
      sha256: sha256(Uint8Array.from(serviceMetadata)),
      bytes: serviceMetadata.byteLength,
      mode: mode(serviceStat.mode),
    },
  };
}

async function ensureFixture(paths: FixturePaths, authorization: ReplacementAuthorization): Promise<string> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const files = [
    [paths.artifact, priorArtifactBytes, 0o700],
    [paths.plist, priorPlistBytes, 0o600],
    [paths.configuration, configurationBytes, 0o600],
    [
      paths.credentialMetadata,
      `${canonicalJson({
        storage: "macOS Keychain",
        itemClass: "generic-password",
        service: "Mission Agent",
        account: authorization.agentId,
      })}\n`,
      0o600,
    ],
    [
      paths.serviceMetadata,
      `${canonicalJson({
        label: "com.wallyweb.mission-agent",
        node: "/usr/local/Cellar/node/24.10.0/bin/node",
        version: "0.6.8",
        running: true,
      })}\n`,
      0o600,
    ],
  ] as const;
  for (const [path, bytes, permissions] of files) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, bytes, { mode: permissions, flag: "wx" });
    }
  }
  return sha256(canonicalJson(await inventory(paths)));
}

const initialState = (authorization: ReplacementAuthorization, priorInventoryChecksum: string): DisposableState => ({
  version: "1",
  authorizationId: authorization.authorizationId,
  operationCounts: Object.fromEntries(localReplacementOperations.map((operation) => [operation, 0])) as Record<
    LocalReplacementOperation,
    number
  >,
  nodeInstalled: false,
  stopped: false,
  targetArtifactActive: false,
  targetPlistActive: false,
  targetRunning: false,
  priorRunning: true,
  targetProcessStartedAt: null,
  priorProcessStartedAt: null,
  priorInventoryChecksum,
  currentInventoryChecksum: priorInventoryChecksum,
});

async function readState(path: string, authorization: ReplacementAuthorization): Promise<DisposableState> {
  const paths = fixturePaths(path);
  const priorInventoryChecksum = await ensureFixture(paths, authorization);
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as DisposableState;
    if (state.version !== "1" || state.authorizationId !== authorization.authorizationId)
      throw new Error("Disposable provider state is bound to another authorization.");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = initialState(authorization, priorInventoryChecksum);
    await writeState(path, state);
    return state;
  }
}

async function writeState(path: string, state: DisposableState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${canonicalJson(state)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

const processObservation = (
  authorization: ReplacementAuthorization,
  state: DisposableState,
  rollback: boolean,
): Record<string, unknown> => {
  const nodeExecutable = rollback ? "/usr/local/Cellar/node/24.10.0/bin/node" : NODE_EXECUTABLE;
  const artifactPath = rollback
    ? "/Users/shawnwollenberg/.mission-agent/mission-agent-0.6.8.mjs"
    : "/Users/shawnwollenberg/.mission-agent/mission-agent-0.7.2.mjs";
  return {
    observationVersion: "mission-agent-process-v1",
    hostIdentity: authorization.hostIdentity,
    agentId: authorization.agentId,
    serviceLabel: "com.wallyweb.mission-agent",
    pid: rollback ? 6068 : 7072,
    parentPid: 1,
    processStartedAt: rollback ? state.priorProcessStartedAt : state.targetProcessStartedAt,
    processOwner: "shawnwollenberg",
    nodeExecutable,
    nodeVersion: rollback ? "v24.10.0" : `v${NODE_VERSION}`,
    artifactPath,
    artifactChecksum: rollback ? SOURCE_SHA256 : TARGET_SHA256,
    processArgumentsChecksum: sha256(`${nodeExecutable} ${artifactPath} run`),
    launchdPlistChecksum: rollback
      ? "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898"
      : TARGET_SERVICE_SHA256,
    targetProcessAbsent: rollback,
  };
};

function mutationCondition(state: DisposableState, operation: LocalReplacementOperation) {
  const conditions: Partial<Record<LocalReplacementOperation, boolean>> = {
    extract_node_runtime: state.nodeInstalled,
    stop_service: state.stopped,
    replace_artifact: state.targetArtifactActive,
    replace_plist: state.targetPlistActive,
    start_service: state.targetRunning,
    restore_artifact: !state.targetArtifactActive,
    restore_plist: !state.targetPlistActive,
    restart_prior_service: state.priorRunning && !state.targetRunning,
  };
  const post = conditions[operation];
  return post ? "postcondition" : "precondition";
}

export function createStatefulDisposableLocalProvider(input: {
  statePath: string;
  failAt?: LocalReplacementOperation;
  afterOperation?: (operation: LocalReplacementOperation, authorization: ReplacementAuthorization) => Promise<void>;
}): LocalFixedOperations {
  const statePath = resolve(input.statePath);
  if (!statePath.includes("/replacement-bootstrap-disposable-"))
    throw new Error("Disposable provider state path lacks the required isolated marker.");
  return {
    async inspectHost(pkg) {
      await readState(statePath, pkg.authorization);
    },
    async inspectMutation({ operation, pkg }) {
      return mutationCondition(await readState(statePath, pkg.authorization), operation);
    },
    async execute({ operation, pkg }) {
      if (input.failAt === operation) throw new Error(`Injected disposable provider failure at ${operation}.`);
      const state = await readState(statePath, pkg.authorization);
      state.operationCounts[operation] += 1;
      if (
        state.operationCounts[operation] > 1 &&
        [
          "stop_service",
          "replace_artifact",
          "replace_plist",
          "start_service",
          "restore_artifact",
          "restore_plist",
          "restart_prior_service",
        ].includes(operation)
      )
        throw new Error(`Disposable provider observed duplicate mutation: ${operation}.`);
      if (operation === "extract_node_runtime") state.nodeInstalled = true;
      if (operation === "stop_service") {
        state.stopped = true;
        state.priorRunning = false;
        await writeFile(
          fixturePaths(statePath).serviceMetadata,
          `${canonicalJson({ label: "com.wallyweb.mission-agent", version: "0.6.8", running: false })}\n`,
        );
      }
      if (operation === "replace_artifact") {
        state.targetArtifactActive = true;
        await writeFile(fixturePaths(statePath).artifact, targetArtifactBytes);
        await chmod(fixturePaths(statePath).artifact, 0o700);
      }
      if (operation === "replace_plist") {
        state.targetPlistActive = true;
        await writeFile(fixturePaths(statePath).plist, targetPlistBytes);
        await chmod(fixturePaths(statePath).plist, 0o600);
      }
      if (operation === "start_service") {
        state.targetRunning = true;
        state.stopped = false;
        state.targetProcessStartedAt = new Date().toISOString();
        await writeFile(
          fixturePaths(statePath).serviceMetadata,
          `${canonicalJson({ label: "com.wallyweb.mission-agent", node: NODE_EXECUTABLE, version: "0.7.2", running: true })}\n`,
        );
      }
      if (operation === "restore_artifact") {
        state.targetArtifactActive = false;
        state.targetRunning = false;
        await writeFile(fixturePaths(statePath).artifact, priorArtifactBytes);
        await chmod(fixturePaths(statePath).artifact, 0o700);
      }
      if (operation === "restore_plist") {
        state.targetPlistActive = false;
        await writeFile(fixturePaths(statePath).plist, priorPlistBytes);
        await chmod(fixturePaths(statePath).plist, 0o600);
      }
      if (operation === "restart_prior_service") {
        state.priorRunning = true;
        state.stopped = false;
        state.priorProcessStartedAt = new Date().toISOString();
        await writeFile(
          fixturePaths(statePath).serviceMetadata,
          `${canonicalJson({
            label: "com.wallyweb.mission-agent",
            node: "/usr/local/Cellar/node/24.10.0/bin/node",
            version: "0.6.8",
            running: true,
          })}\n`,
        );
      }
      state.currentInventoryChecksum = sha256(canonicalJson(await inventory(fixturePaths(statePath))));
      await writeState(statePath, state);
      await input.afterOperation?.(operation, pkg.authorization);
      const rollback = operation.startsWith("verify_prior") || operation === "restart_prior_service";
      const observation = ["start_service", "verify_runtime", "verify_version", "verify_capabilities"].includes(
        operation,
      )
        ? processObservation(pkg.authorization, state, false)
        : rollback
          ? processObservation(pkg.authorization, state, true)
          : undefined;
      if (operation === "verify_prior_runtime" && observation)
        Object.assign(observation, {
          rollbackInventoryChecksum: ROLLBACK_INVENTORY_SHA256,
          artifactByteLength: 117277,
          artifactMode: "0700",
          artifactChecksum: SOURCE_SHA256,
          plistByteLength: 2308,
          plistMode: "0600",
          plistChecksum: "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898",
          configurationByteLength: 2034,
          configurationMode: "0600",
          configurationChecksum: "8db02e81b4b09945e164d7789e690ea7c3ad97ffb5e892ab7de559de38517742",
          owner: "shawnwollenberg",
          group: "staff",
          credentialMetadataPresent: true,
          credentialStorage: "macOS Keychain",
          credentialItemClass: "generic-password",
          credentialService: "Mission Agent",
          credentialAccount: pkg.authorization.agentId,
          credentialMetadataChecksum: sha256(
            canonicalJson({
              itemClass: "generic-password",
              service: "Mission Agent",
              account: pkg.authorization.agentId,
            }),
          ),
          environmentNames: ["MISSION_AGENT_HOME", "PATH"],
          environmentValueChecksums: {
            MISSION_AGENT_HOME: "0974bb09ab4b18256c3a16bb4c6997a1ce50d68d8317a0c1d1634ed5f68f526d",
            PATH: "34e696b0c29cbb879f48eb2d4e321f21f0e3eb053d495e010e8d867ae0ed926f",
          },
          standardOutputPath: "/Users/shawnwollenberg/.mission-agent/mission-agent.log",
          standardErrorPath: "/Users/shawnwollenberg/.mission-agent/mission-agent-error.log",
          runAtLoad: true,
          keepAlive: true,
        });
      return {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        safeStdoutSummary: `${operation} passed in isolated stateful provider`,
        inspectedChecksums: {
          providerState: sha256(canonicalJson(state)),
          ...(operation.includes("node") ? { nodeExecutable: NODE_EXECUTABLE_SHA256 } : {}),
        },
        changedChecksums: {},
        observation,
      };
    },
  };
}

export async function readDisposableProviderEvidence(path: string): Promise<DisposableState> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as DisposableState;
}
