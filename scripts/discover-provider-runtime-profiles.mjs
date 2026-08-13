#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveFrozenProviderExecutable } from "../lib/frozen-provider-executable-resolution.mjs";

const EXPECTED = Object.freeze({
  codex: {
    version: "codex-cli 0.146.0",
    launcherSha256: "134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477",
    invokedExecutableSha256: "ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02",
    credentialIdentitySha256: "2f1d4f26e54b03dbcb4f6d70751d826a885ab860c640f9227786e9a87ce09120",
    planningModel: "gpt-5.6-sol",
    implementationModel: "gpt-5.6-luna",
  },
  claude_code: {
    version: "2.1.224 (Claude Code)",
    launcherSha256: "391df9d2ab04e4cf32199335720ac7715a582e91eaecfd4d2198a16f57ea59b3",
    invokedExecutableSha256: "391df9d2ab04e4cf32199335720ac7715a582e91eaecfd4d2198a16f57ea59b3",
    planningModel: "claude-fable-5",
    implementationModel: "claude-fable-5",
  },
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const redact = (value) =>
  String(value)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-private-material]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi, "Bearer [redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/("(?:orgId|orgName|email)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|private[_-]?key|secret|token)["']?\s*[:=]\s*["']?)[^\s"',}\]]{12,}/gi,
      "$1[redacted]",
    );
const excerpt = (value) => redact(value).slice(-1000);
const q = (value) => String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${excerpt(result.stderr || result.stdout || result.error?.message)}`);
  return result.stdout.trim();
}

async function runProcess(command, args, { cwd, env, timeoutMs = 90_000, cancelAfterMs } = {}) {
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancellationRequested = false;
  let processTreeTerminationAttempted = false;
  let terminationSignal = null;
  let escalationTimer;
  child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-2_000_000)));
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-256_000)));
  const terminate = (signal) => {
    processTreeTerminationAttempted = true;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
    if (signal === "SIGTERM")
      escalationTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5_000);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
  }, timeoutMs);
  const cancellation = cancelAfterMs
    ? setTimeout(() => {
        cancellationRequested = true;
        terminate("SIGTERM");
      }, cancelAfterMs)
    : undefined;
  const exitCode = await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("close", (code, signal) => {
      terminationSignal = signal;
      resolveExit(code);
    });
  });
  clearTimeout(timeout);
  if (cancellation) clearTimeout(cancellation);
  const processGroupAlive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (processTreeTerminationAttempted) {
    const quiescenceDeadline = Date.now() + 6_000;
    while (processGroupAlive() && Date.now() < quiescenceDeadline) await new Promise((done) => setTimeout(done, 50));
  }
  if (escalationTimer) clearTimeout(escalationTimer);
  const processGroupAliveAfterTermination = processGroupAlive();
  return {
    startedAt,
    terminatedAt: new Date().toISOString(),
    exitCode,
    terminationSignal,
    timedOut,
    cancellationRequested,
    processTreeTerminationAttempted,
    processGroupAliveAfterTermination,
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    stdoutExcerpt: excerpt(stdout),
    stderrExcerpt: excerpt(stderr),
  };
}

async function repositoryState(repository) {
  const runGit = (args) => checked("git", args, { cwd: repository });
  const indexRecords = spawnSync("git", ["ls-files", "--stage", "-z"], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (indexRecords.status !== 0) throw new Error("Tracked repository discovery failed");
  const trackedManifest = [];
  for (const record of indexRecords.stdout.split("\0").filter(Boolean)) {
    const match = record.match(/^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/);
    if (!match || match[3] !== "0") throw new Error("Unsupported tracked index entry");
    const metadata = await lstat(join(repository, match[4]));
    let worktreeMode;
    let worktreeObject;
    if (metadata.isSymbolicLink()) {
      worktreeMode = "120000";
      worktreeObject = checked("git", ["hash-object", "--stdin"], {
        input: await readlink(join(repository, match[4])),
      });
    } else if (metadata.isFile()) {
      worktreeMode = metadata.mode & 0o111 ? "100755" : "100644";
      worktreeObject = runGit(["hash-object", "--no-filters", "--", match[4]]);
    } else throw new Error("Unsupported tracked worktree entry");
    trackedManifest.push({
      path: match[4],
      indexMode: match[1],
      indexObject: match[2],
      worktreeMode,
      worktreeObject,
      matchesIndex: match[1] === worktreeMode && match[2] === worktreeObject,
    });
  }
  const state = {
    head: runGit(["rev-parse", "HEAD"]),
    trackedAndUntrackedStatus: runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
    trackedManifestHash: sha256(canonical(trackedManifest)),
    trackedCount: trackedManifest.length,
    trackedContentMatchesIndex: trackedManifest.every((entry) => entry.matchesIndex),
    untrackedPaths: runGit(["ls-files", "--others", "--exclude-standard"]),
    ignoredPaths: runGit(["ls-files", "--others", "--ignored", "--exclude-standard"]),
    submodules: runGit(["submodule", "status", "--recursive"]),
  };
  return { ...state, snapshotHash: sha256(canonical(state)) };
}

async function providerDetails(provider) {
  const name = provider === "codex" ? "codex" : "claude";
  const lexicalCandidates = checked("/usr/bin/which", ["-a", name]).split(/\r?\n/).filter(Boolean);
  const { lexical, executable, installationRoot, invokedExecutable, launcherSha256, invokedExecutableSha256 } =
    await resolveFrozenProviderExecutable({ provider, lexicalCandidates, expected: EXPECTED[provider] });
  const runtimeRoot = provider === "codex" ? resolve(dirname(lexical), "..") : null;
  const credentialIdentitySha256 =
    provider === "codex" ? sha256(await realpath(join(homedir(), ".codex", "auth.json"))) : null;
  if (
    launcherSha256 !== EXPECTED[provider].launcherSha256 ||
    invokedExecutableSha256 !== EXPECTED[provider].invokedExecutableSha256 ||
    credentialIdentitySha256 !== (EXPECTED[provider].credentialIdentitySha256 ?? null)
  )
    throw new Error(`${provider} executable bytes changed before provider execution`);
  const version = checked(invokedExecutable, ["--version"]);
  if (version !== EXPECTED[provider].version) throw new Error(`${provider} version changed: ${version}`);
  return {
    provider,
    lexical,
    executable,
    invokedExecutable,
    version,
    installationRoot,
    runtimeRoot,
    launcherSha256,
    invokedExecutableSha256,
    credentialIdentitySha256,
  };
}

async function claudeKeychainReference() {
  const selected = spawnSync("/usr/bin/security", ["default-keychain", "-d", "user"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (selected.status !== 0) throw new Error("Claude default keychain is unavailable");
  const keychainPath = await realpath(selected.stdout.trim().replace(/^"|"$/g, ""));
  const metadata = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "Claude Code-credentials", keychainPath],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000 },
  );
  const account = `${metadata.stdout ?? ""}\n${metadata.stderr ?? ""}`.match(/"acct"<blob>="([^"]+)"/)?.[1];
  if (metadata.status !== 0 || !account) throw new Error("Claude keychain account binding is unavailable");
  return {
    service: "Claude Code-credentials",
    account,
    keychainPath,
    keychainIdentitySha256: sha256(keychainPath),
    keychainAccountIdentitySha256: sha256(account),
  };
}

function sandboxProfile({ provider, details, fixture, stateRoot, phase }) {
  const userHome = homedir();
  const credentialRules = phase.isolatedProviderState
    ? provider === "codex"
      ? [
          `(literal "${q(join(stateRoot, "home", ".codex", "auth.json"))}")`,
          `(literal "${q(join(homedir(), ".codex", "auth.json"))}")`,
        ]
      : []
    : provider === "codex"
      ? [`(subpath "${q(join(userHome, ".codex"))}")`]
      : [`(subpath "${q(join(userHome, ".claude"))}")`];
  const installationRules = phase.installationTreeRead
    ? [`(subpath "${q(details.installationRoot)}")`]
    : [`(subpath "${q(dirname(details.invokedExecutable))}")`];
  if (phase.runtimeTreeRead && details.runtimeRoot) installationRules.push(`(subpath "${q(details.runtimeRoot)}")`);
  if (phase.homeLibraryRead) installationRules.push(`(subpath "${q(join(userHome, "Library"))}")`);
  for (const relativePath of phase.homeLibraryPaths ?? [])
    installationRules.push(`(subpath "${q(join(userHome, "Library", relativePath))}")`);
  if (phase.hostTemporaryRead) {
    installationRules.push('(subpath "/private/var/folders")');
    installationRules.push('(subpath "/private/tmp")');
    installationRules.push('(subpath "/tmp")');
  }
  for (const path of phase.hostTemporaryPaths ?? []) installationRules.push(`(subpath "${q(path)}")`);
  const network =
    phase.networkMode === "external_ip_only"
      ? `(allow network-outbound
  (remote tcp) (remote udp)
  (literal "/private/var/run/mDNSResponder"))
(deny network-outbound
  (remote ip "localhost:*"))`
      : phase.externalNetwork
        ? `(allow network-outbound)\n(allow network-bind (local ip))\n(allow network-inbound (local ip))`
        : "";
  const conflictingReadPolicy = phase.conflictingUserDeny
    ? `(allow file-read*)
(deny file-read*
  (subpath "${q(userHome)}") (subpath "/Volumes")
  (subpath "/private/tmp") (subpath "/tmp") (subpath "/private/var/folders"))`
    : "";
  const nonSensitiveReadPolicy = phase.allFileRead
    ? "(allow file-read*)"
    : phase.conflictingUserDeny
      ? ""
      : `(allow file-read*
  (require-all
    (require-not (subpath "${q(userHome)}"))
    (require-not (subpath "/Volumes"))
    (require-not (subpath "/private/tmp"))
    (require-not (subpath "/tmp"))
    (require-not (subpath "/private/var/folders"))))`;
  return `(version 1)
(deny default)
(allow process*)
${phase.signalAccess ? "(allow signal)" : ""}
${phase.fileIoctl ? "(allow file-ioctl)" : ""}
${phase.posixIpc ? "(allow ipc-posix-shm*)\n(allow ipc-posix-sem*)" : ""}
${network}
${phase.sysctlAll ? "(allow sysctl*)" : "(allow sysctl-read)"}
${phase.machAll ? "(allow mach*)" : "(allow mach-lookup)"}
(allow file-read-metadata)
${conflictingReadPolicy}
${nonSensitiveReadPolicy}
(allow file-read*
  (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
  (subpath "/private/etc") (subpath "/dev")
  ${installationRules.join("\n  ")}
  (subpath "${q(fixture.repository)}")
  (subpath "${q(stateRoot)}")
  ${credentialRules.join("\n  ")})
(allow file-write*
  (subpath "${q(stateRoot)}")
  ${(phase.hostTemporaryWritePaths ?? []).map((path) => `(subpath "${q(path)}")`).join("\n  ")}
  ${phase.repositoryWrite ? `(subpath "${q(fixture.repository)}")` : ""})
${phase.allFileWrite ? "(allow file-write*)" : ""}
${phase.allFileWriteCreate ? "(allow file-write-create)" : ""}
${phase.allFileWriteData ? "(allow file-write-data)" : ""}
${phase.socketCreate ? "(allow file-write-create (vnode-type SOCKET))" : ""}
${(phase.hostTemporaryCreatePaths ?? []).length ? `(allow file-write-create\n  ${phase.hostTemporaryCreatePaths.map((path) => `(subpath "${q(path)}")`).join("\n  ")})` : ""}
`;
}

async function prepareProviderState(provider, stateRoot) {
  const isolatedHome = join(stateRoot, "home");
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  if (provider === "codex") {
    const codexHome = join(isolatedHome, ".codex");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await symlink(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
  }
  return isolatedHome;
}

function operationClassFor(kind, phase = {}) {
  if (kind === "implementation") return "implementation";
  if (["cancellation", "timeout"].includes(kind)) {
    if (!phase.operationClass) throw new Error(`Lifecycle probe ${kind} requires an explicit profile operation class`);
    return phase.operationClass;
  }
  return "planning";
}

function providerCommand(provider, details, fixture, stateRoot, kind, phase = {}) {
  const operationClass = operationClassFor(kind, phase);
  const model =
    operationClass === "implementation" ? EXPECTED[provider].implementationModel : EXPECTED[provider].planningModel;
  if (kind === "auth")
    return provider === "codex"
      ? [details.invokedExecutable, ["login", "status"]]
      : [details.invokedExecutable, ["auth", "status"]];
  const implementation = operationClass === "implementation";
  const prompt = implementation
    ? "Edit README.md in the current repository and append exactly one line containing: runtime profile implementation probe. Do not run shell commands, commit, push, publish, deploy, or access any other repository."
    : "Read README.md and return a JSON object with exactly one string property named answer. The answer must be the first Markdown heading. Do not modify files.";
  const codexFeatureArguments = phase.disableCodexAuxiliaryFeatures
    ? [
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin",
        "--disable",
        "hooks",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--disable",
        "image_generation",
        "--disable",
        "code_mode_host",
        "--disable",
        "multi_agent",
        "--disable",
        "goals",
        "--disable",
        "memories",
      ]
    : [];
  if (provider === "codex")
    return [
      details.invokedExecutable,
      [
        "--disable",
        "shell_tool",
        "exec",
        "--json",
        ...(phase.bypassCodexInternalSandbox
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--sandbox", implementation ? "workspace-write" : "read-only"]),
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        ...codexFeatureArguments,
        "--model",
        model,
        "--skip-git-repo-check",
        ...(implementation ? [] : ["--output-schema", join(stateRoot, "schema.json")]),
        "-o",
        join(stateRoot, `${randomUUID()}.json`),
        prompt,
      ],
    ];
  return [
    details.invokedExecutable,
    [
      "--print",
      "--output-format",
      "json",
      ...(implementation ? ["--permission-mode", "acceptEdits"] : ["--safe-mode"]),
      "--tools",
      implementation ? "Read,Edit,Write,Grep,Glob" : "Read,Grep,Glob",
      "--disallowedTools",
      implementation ? "Bash,NotebookEdit,WebFetch,WebSearch" : "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      ...(implementation
        ? []
        : [
            "--json-schema",
            '{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string"}}}',
          ]),
      "--model",
      model,
      prompt,
    ],
  ];
}

async function providerProbe(provider, details, fixture, discoveryRoot, phase, kind) {
  if (phase.provider && phase.provider !== provider)
    throw new Error(`Runtime profile ${phase.id} is bound to ${phase.provider}, not ${provider}`);
  const operationClass = operationClassFor(kind, phase);
  const stateRoot = join(discoveryRoot, provider, phase.id, kind);
  const baselineReadme = await readFile(join(fixture.repository, "README.md"));
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  try {
    const isolatedHome = phase.isolatedProviderState
      ? await prepareProviderState(provider, stateRoot)
      : join(stateRoot, "home");
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await cp(fixture.schema, join(stateRoot, "schema.json"));
    const profile = sandboxProfile({ provider, details, fixture, stateRoot, phase });
    const profilePath = join(stateRoot, "profile.sb");
    await writeFile(profilePath, profile, { mode: 0o600 });
    const [command, args] = providerCommand(provider, details, fixture, stateRoot, kind, phase);
    const env = Object.fromEntries(
      ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    );
    env.HOME = provider === "claude_code" && !phase.isolatedProviderState ? homedir() : isolatedHome;
    env.TMPDIR = join(stateRoot, "tmp");
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
    if (provider === "codex")
      env.CODEX_HOME = phase.isolatedProviderState ? join(isolatedHome, ".codex") : join(homedir(), ".codex");
    if (provider === "claude_code" && phase.brokeredClaudeOAuth) {
      env.CLAUDE_CODE_TMPDIR = stateRoot;
      const keychain = await claudeKeychainReference();
      const credential = spawnSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", keychain.service, "-a", keychain.account, "-w", keychain.keychainPath],
        { encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      if (credential.status !== 0 || !credential.stdout.trim())
        throw new Error("Claude credential broker could not obtain the approved provider credential");
      let accessToken;
      try {
        accessToken = JSON.parse(credential.stdout).claudeAiOauth?.accessToken;
      } catch {}
      if (typeof accessToken !== "string" || !accessToken)
        throw new Error("Claude credential broker returned an unsupported credential record");
      env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
    }
    const repositoryStateBefore = await repositoryState(fixture.repository);
    const result = await runProcess("/usr/bin/sandbox-exec", ["-f", profilePath, command, ...args], {
      cwd: fixture.repository,
      env,
      ...(kind === "cancellation" ? { cancelAfterMs: 250 } : {}),
      ...(kind === "timeout" ? { timeoutMs: 250 } : {}),
    });
    const repositoryStateAfter = await repositoryState(fixture.repository);
    const changedPaths = checked("git", ["diff", "--name-only"], { cwd: fixture.repository })
      .split(/\r?\n/)
      .filter(Boolean);
    const implementationPostcondition =
      operationClass !== "implementation" ||
      (changedPaths.length === 1 &&
        changedPaths[0] === "README.md" &&
        repositoryStateAfter.head === repositoryStateBefore.head &&
        (await readFile(join(fixture.repository, "README.md"), "utf8")).split("runtime profile implementation probe")
          .length === 2);
    const readOnlyPostcondition =
      operationClass === "implementation" || repositoryStateAfter.snapshotHash === repositoryStateBefore.snapshotHash;
    return {
      provider,
      profileId: phase.id,
      profileHash: sha256(profile),
      credentialMode:
        provider === "codex" && phase.isolatedProviderState
          ? "isolated_read_only_auth_reference"
          : phase.brokeredClaudeOAuth
            ? "brokered_exact_keychain_item"
            : "provider_native_session",
      probe: kind,
      operationClass,
      requestedModel:
        kind === "auth"
          ? null
          : operationClass === "implementation"
            ? EXPECTED[provider].implementationModel
            : EXPECTED[provider].planningModel,
      environmentVariableNames: Object.keys(env).sort(),
      success:
        kind === "cancellation" || kind === "timeout"
          ? result.processTreeTerminationAttempted && !result.processGroupAliveAfterTermination && readOnlyPostcondition
          : result.exitCode === 0 && implementationPostcondition && readOnlyPostcondition,
      implementationPostcondition,
      readOnlyPostcondition,
      repositoryStateBefore,
      repositoryStateAfter,
      changedPaths,
      ...result,
    };
  } finally {
    await writeFile(join(fixture.repository, "README.md"), baselineReadme, { mode: 0o600 });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function directProbe(provider, details, fixture, kind) {
  const stateRoot = fixture.output;
  await cp(fixture.schema, join(stateRoot, "schema.json"));
  const [command, args] = providerCommand(provider, details, fixture, stateRoot, kind);
  const result = await runProcess(command, args, {
    cwd: fixture.repository,
    env: process.env,
  });
  return {
    provider,
    profileId: "direct-reference-unsandboxed",
    profileHash: null,
    probe: kind,
    requestedModel: kind === "structured" ? EXPECTED[provider].planningModel : null,
    success: result.exitCode === 0,
    ...result,
  };
}

const discoveryRoot = await realpath(await mkdtemp(join(tmpdir(), "mc-provider-profile-discovery.")));
const cleanupDiscoveryRoot = () => rmSync(discoveryRoot, { recursive: true, force: true });
process.once("exit", cleanupDiscoveryRoot);
for (const [signalName, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signalName, () => {
    cleanupDiscoveryRoot();
    process.exit(exitCode);
  });
const fixture = {
  repository: join(discoveryRoot, "fixture-repository"),
  output: join(discoveryRoot, "provider-output"),
  schema: join(discoveryRoot, "schema.json"),
};
await mkdir(fixture.repository, { recursive: true, mode: 0o700 });
fixture.repository = await realpath(fixture.repository);
await mkdir(fixture.output, { recursive: true, mode: 0o700 });
await writeFile(join(fixture.repository, "README.md"), "# Runtime Profile Fixture\n", { mode: 0o600 });
await writeFile(
  fixture.schema,
  '{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string"}}}',
  { mode: 0o600 },
);
checked("git", ["init", "-b", "main"], { cwd: fixture.repository });
checked("git", ["add", "README.md"], { cwd: fixture.repository });
checked("git", ["-c", "user.name=Discovery", "-c", "user.email=discovery@localhost", "commit", "-m", "fixture"], {
  cwd: fixture.repository,
});

const userTemporaryRoot = await realpath(tmpdir());
const userCacheRoot = join(dirname(userTemporaryRoot), "C");
const phases = [
  {
    id: "mission-agent-080-current",
    conflictingUserDeny: true,
    installationTreeRead: false,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "scoped-reads-no-conflicting-deny",
    conflictingUserDeny: false,
    installationTreeRead: false,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "installation-tree-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "provider-runtime-tree-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "user-temporary-t-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "user-cache-c-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userCacheRoot],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "user-temporary-and-cache-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "user-temporary-and-home-library-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    homeLibraryRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "user-cache-and-home-library-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userCacheRoot],
    homeLibraryRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "user-temporary-cache-and-home-library-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    homeLibraryRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-library-preferences-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    homeLibraryPaths: ["Preferences"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-keychains-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    homeLibraryPaths: ["Keychains"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-keychains-and-assignment-state",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    homeLibraryPaths: ["Keychains"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-preferences-and-keychains-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    homeLibraryPaths: ["Preferences", "Keychains"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-library-cache-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    homeLibraryPaths: ["Caches/claude-cli-nodejs"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-library-application-support-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    homeLibraryPaths: ["Application Support/Claude"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "claude-combined-library-roots-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    homeLibraryPaths: [
      "Preferences",
      "Caches/claude-cli-nodejs",
      "Application Support/Claude",
      "Application Support/Claude-3p",
      "Logs/Claude",
    ],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "host-temporary-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "home-library-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    homeLibraryRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "host-temporary-and-home-library-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryRead: true,
    homeLibraryRead: true,
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "assignment-isolated-provider-state",
    conflictingUserDeny: false,
    installationTreeRead: true,
    isolatedProviderState: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "assignment-isolated-provider-state-and-user-temporary-read",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-posix-ipc",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    posixIpc: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-signal-access",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    signalAccess: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-file-ioctl",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    fileIoctl: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-ipc-signal-ioctl",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-mach-all",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    machAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-sysctl-all",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-runtime-facilities-all",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-app-server-socket",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    hostTemporaryWritePaths: [join(userTemporaryRoot, "codex-ipc")],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-auxiliary-features-disabled",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    disableCodexAuxiliaryFeatures: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-user-temporary-write",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    hostTemporaryWritePaths: [userTemporaryRoot],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-user-cache-write",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot, userCacheRoot],
    hostTemporaryWritePaths: [userCacheRoot],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-device-write",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    hostTemporaryWritePaths: ["/dev"],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "all-host-file-read",
    allFileRead: true,
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "all-host-file-read-write",
    allFileRead: true,
    allFileWrite: true,
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "all-host-file-read-write-create",
    allFileRead: true,
    allFileWriteCreate: true,
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-anonymous-socket-create",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    isolatedProviderState: true,
    socketCreate: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-user-temporary-create",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    hostTemporaryCreatePaths: [userTemporaryRoot],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
  {
    id: "codex-implementation-candidate",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    hostTemporaryCreatePaths: [userTemporaryRoot],
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: true,
  },
  {
    id: "codex-implementation-outer-sandbox-authority",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    hostTemporaryPaths: [userTemporaryRoot],
    hostTemporaryCreatePaths: [userTemporaryRoot],
    isolatedProviderState: true,
    bypassCodexInternalSandbox: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: true,
  },
  {
    id: "codex-planning-macos-v2",
    provider: "codex",
    operationClass: "planning",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: true,
    networkMode: "external_ip_only",
    repositoryWrite: false,
  },
  {
    id: "codex-implementation-macos-v2",
    provider: "codex",
    operationClass: "implementation",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: true,
    bypassCodexInternalSandbox: true,
    networkMode: "external_ip_only",
    repositoryWrite: true,
  },
  {
    id: "claude-implementation-candidate",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    homeLibraryPaths: ["Keychains"],
    isolatedProviderState: false,
    externalNetwork: true,
    repositoryWrite: true,
  },
  {
    id: "claude-planning-external-ip-only",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    homeLibraryPaths: ["Keychains"],
    isolatedProviderState: false,
    networkMode: "external_ip_only",
    repositoryWrite: false,
  },
  {
    id: "claude-planning-macos-v2",
    provider: "claude_code",
    operationClass: "planning",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    brokeredClaudeOAuth: true,
    isolatedProviderState: true,
    networkMode: "external_ip_only",
    repositoryWrite: false,
  },
  {
    id: "claude-implementation-external-ip-only",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    homeLibraryPaths: ["Keychains"],
    isolatedProviderState: false,
    networkMode: "external_ip_only",
    repositoryWrite: true,
  },
  {
    id: "claude-implementation-macos-v2",
    provider: "claude_code",
    operationClass: "implementation",
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    brokeredClaudeOAuth: true,
    isolatedProviderState: true,
    networkMode: "external_ip_only",
    repositoryWrite: true,
  },
  {
    id: "all-host-file-read-write-data",
    allFileRead: true,
    allFileWriteData: true,
    conflictingUserDeny: false,
    installationTreeRead: true,
    runtimeTreeRead: true,
    isolatedProviderState: true,
    posixIpc: true,
    signalAccess: true,
    fileIoctl: true,
    machAll: true,
    sysctlAll: true,
    externalNetwork: true,
    repositoryWrite: false,
  },
];
const requestedProviderArgument = process.argv.find((argument) => argument.startsWith("--providers="));
const providers = requestedProviderArgument
  ? requestedProviderArgument.slice("--providers=".length).split(",")
  : ["codex", "claude_code"];
if (providers.some((provider) => !Object.hasOwn(EXPECTED, provider))) throw new Error("Unsupported discovery provider");
const details = Object.fromEntries(
  await Promise.all(providers.map(async (provider) => [provider, await providerDetails(provider)])),
);
const results = [];
const probeKinds = process.argv.includes("--auth-only")
  ? ["auth"]
  : process.argv.includes("--implementation-only")
    ? ["implementation"]
    : process.argv.includes("--lifecycle-only")
      ? ["cancellation", "timeout"]
      : process.argv.includes("--structured-only")
        ? ["structured"]
        : ["auth", "structured"];
const requestedProfileArgument = process.argv.find((argument) => argument.startsWith("--profiles="));
const requestedProfiles = requestedProfileArgument
  ? new Set(requestedProfileArgument.slice("--profiles=".length).split(","))
  : null;
if (process.argv.includes("--lifecycle-only") && (!requestedProfiles || !process.argv.includes("--skip-direct")))
  throw new Error("Lifecycle discovery requires explicit --profiles and --skip-direct bindings");
if (requestedProfiles) {
  const known = new Map(phases.map((phase) => [phase.id, phase]));
  for (const profileId of requestedProfiles) {
    const phase = known.get(profileId);
    if (!phase) throw new Error(`Unknown requested runtime profile ${profileId}`);
    if (phase.provider && !providers.includes(phase.provider))
      throw new Error(`Requested runtime profile ${profileId} requires provider ${phase.provider}`);
  }
}
for (const provider of providers) {
  if (!process.argv.includes("--skip-direct"))
    for (const kind of probeKinds) results.push(await directProbe(provider, details[provider], fixture, kind));
  for (const phase of phases.filter(
    (candidate) =>
      (!requestedProfiles || requestedProfiles.has(candidate.id)) &&
      (!candidate.provider || candidate.provider === provider),
  ))
    for (const kind of probeKinds)
      results.push(await providerProbe(provider, details[provider], fixture, discoveryRoot, phase, kind));
}
const providerEvidence = Object.fromEntries(
  await Promise.all(
    providers.map(async (provider) => [
      provider,
      {
        version: details[provider].version,
        executableHash: details[provider].launcherSha256,
        invokedExecutableHash: details[provider].invokedExecutableSha256,
        invokedExecutableIdentity: sha256(details[provider].invokedExecutable),
        providerCredentialIdentity: details[provider].credentialIdentitySha256,
        installationRootIdentity: sha256(details[provider].installationRoot),
        ...(provider === "claude_code"
          ? (({ keychainIdentitySha256, keychainAccountIdentitySha256 }) => ({
              keychainIdentitySha256,
              keychainAccountIdentitySha256,
            }))(await claudeKeychainReference())
          : {}),
      },
    ]),
  ),
);

const report = {
  schemaVersion: "provider-runtime-profile-discovery/1",
  createdAt: new Date().toISOString(),
  productionContacted: false,
  missionControlContacted: false,
  platform: { operatingSystem: "macos", architecture: process.arch },
  providers: providerEvidence,
  repositoryState: await repositoryState(fixture.repository),
  phases,
  results,
};
report.reportHash = sha256(canonical(report));
const requestedOutput = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const outputPath = requestedOutput ? resolve(requestedOutput) : join(discoveryRoot, "discovery-report.json");
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    outputPath,
    discoveryRoot,
    reportHash: report.reportHash,
    summary: results.map(({ provider, profileId, probe, success, exitCode, timedOut }) => ({
      provider,
      profileId,
      probe,
      success,
      exitCode,
      timedOut,
    })),
  }),
);

await rm(discoveryRoot, { recursive: true, force: true });
