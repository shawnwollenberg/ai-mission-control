import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("authenticated acceptance invokes the Mission Agent through its canonical executable path", async () => {
  const source = await readFile("scripts/run-consensus-real-acceptance.ts", "utf8");
  assert.match(source, /const artifact = await realpath\(resolve\(process\.env\.CONSENSUS_ACCEPTANCE_ARTIFACT\)\)/);

  const root = await mkdtemp(join(tmpdir(), "mission-agent-repository-persistence-"));
  const home = join(root, "agent");
  const repository = join(root, "fixture-repository");
  const lexicalArtifact = join(root, "mission-agent.mjs");
  const sourceArtifact = resolve("public/mission-agent-0.8.0-runtime-v6.candidate.mjs");
  const repositoryIds = [randomUUID(), randomUUID()];
  let responseIndex = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          protocolVersion: "1.0",
          messageId: message.messageId,
          repository: { repository_id: repositoryIds[responseIndex] },
        }),
      );
    });
  });
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(repository, { mode: 0o700 });
    await run("git", ["init", "-b", "main"], { cwd: repository });
    await run("git", ["config", "user.email", "fixture@example.com"], { cwd: repository });
    await run("git", ["config", "user.name", "Fixture"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "fixture\n");
    await run("git", ["add", "README.md"], { cwd: repository });
    await run("git", ["commit", "-m", "fixture"], { cwd: repository });
    await run("git", ["remote", "add", "origin", "https://github.com/example/fixture-repository.git"], {
      cwd: repository,
    });
    await new Promise((done) => server.listen(33_909, "127.0.0.1", done));
    const operations = ["inspect_repository", "generate_structured_plan"];
    await writeFile(
      join(home, "config.json"),
      `${JSON.stringify(
        {
          missionControlUrl: "http://127.0.0.1:33909",
          workspaceId: randomUUID(),
          workspaceName: "fixture",
          agentId: randomUUID(),
          agentName: "fixture-codex",
          credentialId: randomUUID(),
          secret: "disposable-fixture-secret",
          secretStorage: "file-0600",
          adapter: "codex",
          leaseOwner: "fixture",
          capabilities: {},
          providerProfile: {
            provider: "codex",
            agentVersion: "0.8.0",
            supportedMissionRoles: ["planner", "executor"],
            supportedOperations: operations,
            supportedModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
            modelCapabilities: [
              {
                modelId: "gpt-5.6-sol",
                provider: "codex",
                supportedRoles: ["planner"],
                supportedOperations: operations,
                runtimeModelIdentity: "unverifiable",
              },
              {
                modelId: "gpt-5.6-luna",
                provider: "codex",
                supportedRoles: ["executor"],
                supportedOperations: operations,
                runtimeModelIdentity: "unverifiable",
              },
            ],
            capabilityAttestationVersion: 1,
            capabilitySource: "operator_allowlist",
            structuredOutput: true,
            projectBrainContext: true,
            repositoryMutation: true,
          },
          repositories: {},
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await symlink(sourceArtifact, lexicalArtifact);
    const environment = { ...process.env, MISSION_AGENT_HOME: home };

    const lexicalResult = await run(process.execPath, [lexicalArtifact, "repository", "add", repository], {
      env: environment,
    });
    assert.equal(lexicalResult.stdout, "");
    assert.equal(Object.keys(JSON.parse(await readFile(join(home, "config.json"), "utf8")).repositories).length, 0);

    const canonicalArtifact = await realpath(lexicalArtifact);
    const first = await run(process.execPath, [canonicalArtifact, "repository", "add", repository], {
      env: environment,
    });
    assert.match(first.stdout, /Repository registered/);
    assert.equal(Object.keys(JSON.parse(await readFile(join(home, "config.json"), "utf8")).repositories).length, 1);
    const freshRead = await run(process.execPath, [
      "-e",
      `const fs=require("fs");process.stdout.write(String(Object.keys(JSON.parse(fs.readFileSync(${JSON.stringify(join(home, "config.json"))})).repositories).length))`,
    ]);
    assert.equal(freshRead.stdout, "1");

    await run(process.execPath, [canonicalArtifact, "repository", "add", repository], { env: environment });
    assert.equal(Object.keys(JSON.parse(await readFile(join(home, "config.json"), "utf8")).repositories).length, 1);

    responseIndex = 1;
    await chmod(home, 0o500);
    await assert.rejects(
      run(process.execPath, [canonicalArtifact, "repository", "add", repository], { env: environment }),
    );
    await chmod(home, 0o700);
    assert.equal(Object.keys(JSON.parse(await readFile(join(home, "config.json"), "utf8")).repositories).length, 1);
  } finally {
    await chmod(home, 0o700).catch(() => undefined);
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test("repository-add success remains ordered after durable config persistence", async () => {
  const source = await readFile("scripts/mission-agent-080.template.mjs", "utf8");
  const registration = source.slice(
    source.indexOf("async function registerRepository(config, path)"),
    source.indexOf("async function installLauncher()"),
  );
  assert.ok(
    registration.indexOf("config.repositories =") > registration.indexOf("const registered = response.repository"),
  );
  assert.ok(registration.indexOf("await persistConfig(config)") > registration.indexOf("config.repositories ="));
  assert.ok(registration.indexOf("return registered") > registration.indexOf("await persistConfig(config)"));

  const harness = await readFile("scripts/run-consensus-real-acceptance.ts", "utf8");
  const command = harness.slice(
    harness.indexOf("async function runRepositoryRegistration"),
    harness.indexOf("const lastAgentHeartbeatBudgetUse"),
  );
  assert.ok(
    command.indexOf("await run(process.execPath, [artifact") < command.indexOf("await readFile(join(agent.home"),
  );
  assert.match(command, /if \(registrations\.length !== 1\)/);
});
