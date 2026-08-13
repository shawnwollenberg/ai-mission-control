import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourcePath = resolve("public/mission-agent-0.6.8.mjs");
const targetPath = resolve("public/mission-agent-0.6.9.mjs");
let source = await readFile(sourcePath, "utf8");

source = source.replace('const VERSION = "0.6.8";', 'const VERSION = "0.6.9";');

const oldInspection = `function inspectRepository(path) {
  if (!path) throw new Error("Provide a repository path, for example: mission-agent repository add .");
  const top = exec("git", ["rev-parse", "--show-toplevel"], path);
  const resolved = exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], path);
  if (top !== resolved) throw new Error("Repository path could not be resolved safely.");
  const commit = exec("git", ["rev-parse", "HEAD"], resolved);
  const branch = exec("git", ["branch", "--show-current"], resolved) || "detached";
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: resolved, encoding: "utf8" });
  const remoteUrl = remote.status === 0 ? remote.stdout.trim().replace(/\\/\\/[^/@]+@/, "//[redacted]@") : undefined;
  return {
    path: resolved,
    name: basename(resolved),
    commit,
    branch,
    remoteUrl,
    fingerprint: sha256(\`\${remoteUrl ?? \`local:\${resolved}\`}\\n\${basename(resolved)}\`),
  };
}`;

const newInspection = String.raw`function canonicalizeRepositoryRemote(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("A Git remote URL is required.");
  let host;
  let pathname;
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error("The Git remote URL is not canonicalizable."); }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol))
      throw new Error("The Git remote protocol is unsupported.");
    const defaults = { "http:": "80", "https:": "443", "ssh:": "22", "git:": "9418" };
    host = parsed.hostname + (parsed.port && parsed.port !== defaults[parsed.protocol] ? ":" + parsed.port : "");
    pathname = parsed.pathname;
  }
  const cleanPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !cleanPath || cleanPath.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("The Git remote identity is ambiguous.");
  return host.toLowerCase() + "/" + cleanPath.normalize("NFC");
}
function deriveStableRepositoryIdentity(remotes, repositoryName) {
  const origin = remotes.filter((remote) => remote.name === "origin");
  const selected = origin.length === 1 ? origin[0] : origin.length === 0 && remotes.length === 1 ? remotes[0] : undefined;
  if (!selected) throw new Error(remotes.length ? "Repository remotes are ambiguous." : "Local-only repositories are not stable-v2 eligible.");
  const canonicalRemoteUrl = canonicalizeRepositoryRemote(selected.url);
  const name = String(repositoryName ?? "").trim().normalize("NFC");
  if (!name || canonicalRemoteUrl.slice(canonicalRemoteUrl.lastIndexOf("/") + 1) !== name)
    throw new Error("Repository name does not exactly match the selected canonical remote.");
  return { identityVersion: "stable-v2", selectedRemote: selected.name, canonicalRemoteUrl, repositoryName: name,
    fingerprint: sha256(canonicalRemoteUrl + "\n" + name) };
}
function inspectRepository(path) {
  if (!path) throw new Error("Provide a repository path, for example: mission-agent repository add .");
  const top = exec("git", ["rev-parse", "--show-toplevel"], path);
  const resolved = exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], path);
  if (top !== resolved) throw new Error("Repository path could not be resolved safely.");
  const commit = exec("git", ["rev-parse", "HEAD"], resolved);
  const branch = exec("git", ["branch", "--show-current"], resolved) || "detached";
  const names = exec("git", ["remote"], resolved).split(/\r?\n/).filter(Boolean);
  const remotes = names.map((name) => ({ name, url: exec("git", ["remote", "get-url", name], resolved) }));
  const stable = deriveStableRepositoryIdentity(remotes, basename(resolved));
  const origin = remotes.find((remote) => remote.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
  return { path: resolved, name: basename(resolved), commit, branch, remotes, remoteUrl: origin?.url,
    legacyFingerprint: sha256((origin?.url ?? "local:" + resolved) + "\n" + basename(resolved)),
    ...stable };
}`;

if (!source.includes(oldInspection)) throw new Error("Mission Agent 0.6.8 inspection source changed");
source = source.replace(oldInspection, newInspection);

source = source.replace(
  `    commit: repository.commit,
  });`,
  `    commit: repository.commit,
    identityVersion: "stable-v2",
    canonicalRemoteUrl: repository.canonicalRemoteUrl,
    selectedRemote: repository.selectedRemote,
    remotes: repository.remotes,
  });`,
);
source = source.replace(
  `      fingerprint: repository.fingerprint,
      name: repository.name,`,
  `      fingerprint: repository.fingerprint,
      identityVersion: "stable-v2",
      canonicalRemoteUrl: repository.canonicalRemoteUrl,
      name: repository.name,`,
);

source = source.replaceAll(
  "currentRepository.fingerprint !== repository.fingerprint",
  `(repository.identityVersion === "stable-v2"
      ? currentRepository.fingerprint !== repository.fingerprint
      : currentRepository.legacyFingerprint !== repository.fingerprint)`,
);

source = source.replace(
  `    artifact,
    ...(projectBrain ? { projectBrain } : {}),`,
  `    artifact,
    repositoryIdentity: {
      supportedVersions: ["legacy-v1", "stable-v2"],
      stableProtocolVersion: "2",
      activationAcknowledgementVersion: "1",
      repositories: Object.entries(config.repositories ?? {}).map(([repositoryId, repository]) => ({
        repositoryId,
        identityVersion: repository.identityVersion ?? "legacy-v1",
        fingerprint: repository.fingerprint,
      })),
    },
    ...(projectBrain ? { projectBrain } : {}),`,
);

const activationCode = `
async function activateRepositoryIdentity(repositoryId) {
  const config = await loadConfig();
  const repository = config.repositories?.[repositoryId];
  const pending = config.repositoryIdentityMigrations?.[repositoryId];
  if (!repository || !pending) throw new Error("A governed migration preview is required before activation.");
  const current = inspectRepository(repository.path);
  const prepared = await signedRequest(config, "/api/agent-protocol/v1/repositories/identity/complete",
    "RepositoryIdentityActivationRequested", {
      migrationId: pending.migrationId, requestFingerprint: pending.requestFingerprint,
      stableFingerprint: current.fingerprint, registeredPath: repository.path, currentHead: current.commit,
    });
  const request = prepared.activationRequest;
  const unsigned = { ...request }; delete unsigned.requestChecksum; delete unsigned.missionControlSignature;
  const checksum = sha256(canonicalJson(unsigned));
  const expectedSignature = createHmac("sha256", sha256(config.secret)).update(checksum).digest("hex");
  const artifact = await artifactIdentity();
  if (request.requestChecksum !== checksum || request.missionControlSignature !== expectedSignature ||
      request.requiredArtifactChecksum !== artifact.sha256 || request.agentVersion !== VERSION ||
      request.repositoryId !== repositoryId || request.stableFingerprint !== current.fingerprint ||
      request.canonicalRemoteUrl !== current.canonicalRemoteUrl || request.repositoryName !== current.name ||
      request.currentHead !== current.commit || request.registeredPath !== repository.path)
    throw new Error("Stable identity activation request verification failed.");
  repository.identityHistory = [...(repository.identityHistory ?? []),
    { identityVersion: repository.identityVersion ?? "legacy-v1", fingerprint: repository.fingerprint }];
  repository.identityVersion = "stable-v2";
  repository.fingerprint = current.fingerprint;
  repository.canonicalRemoteUrl = current.canonicalRemoteUrl;
  repository.localActivation = { requestId: request.requestId, activatedAt: new Date().toISOString(),
    legacyFingerprint: request.legacyFingerprint, stableFingerprint: current.fingerprint };
  await persistConfig(config);
  const acknowledgement = await signedRequest(config, "/api/agent-protocol/v1/repositories/identity/acknowledge",
    "RepositoryIdentityActivationAcknowledged", {
      migrationId: pending.migrationId, requestId: request.requestId, activationProtocolVersion: "1",
      agentVersion: VERSION, artifact, repositoryId, legacyFingerprint: request.legacyFingerprint,
      stableFingerprint: current.fingerprint, canonicalRemoteUrl: current.canonicalRemoteUrl,
      repositoryName: current.name, registeredPath: repository.path, currentHead: current.commit,
      permissionSnapshotHash: request.permissionSnapshotHash, projectBrainEnabled: request.projectBrainEnabled,
      activatedAt: repository.localActivation.activatedAt, nonce: randomBytes(18).toString("base64url"),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  await registerRepository(config, repository.path);
  delete config.repositoryIdentityMigrations[repositoryId];
  await persistConfig(config);
  console.log(\`Repository identity activated.\\n\\nRepository: \${repositoryId}\\nIdentity: stable-v2\\nStatus: \${acknowledgement.status}\`);
}
`;
source = source.replace(
  "\nasync function repositoryAdd(path) {",
  `${activationCode}\nasync function repositoryAdd(path) {`,
);
source = source.replace(
  `  else if (command === "repository" && process.argv[3] === "inspect") await repositoryInspect(process.argv[4]);`,
  `  else if (command === "repository" && process.argv[3] === "inspect") await repositoryInspect(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "identity-activate") await activateRepositoryIdentity(process.argv[4]);`,
);
source = source.replace(
  "repository list|add|remove|inspect, project-brain configure",
  "repository list|add|remove|inspect|identity-activate, project-brain configure",
);
source = source.replace(
  "  artifactIdentity,",
  "  artifactIdentity,\n  canonicalizeRepositoryRemote,\n  deriveStableRepositoryIdentity,",
);

await writeFile(targetPath, source, { mode: 0o700 });
