import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { canonicalizeRemoteUrl, deriveStableRepositoryIdentity, repositoryIdentityRequestFingerprint } =
  await import("../application/repository-identity.ts");
const agent = await import("../public/repository-identity-migrator-1.mjs");

test("SSH, SCP, and HTTPS forms canonicalize to one repository identity", () => {
  const expected = "github.com/acme/widget";
  for (const remote of [
    "https://github.com/acme/widget.git",
    "ssh://git@github.com/acme/widget.git/",
    "git@GitHub.COM:acme/widget.git",
  ]) {
    assert.equal(canonicalizeRemoteUrl(remote), expected);
    assert.equal(agent.canonicalizeRepositoryRemote(remote), expected);
  }
});

test("stable identity is deterministic and independently identical on both sides", () => {
  const input = {
    remotes: [
      { name: "upstream", url: "git@github.com:other/widget.git" },
      { name: "origin", url: "https://GitHub.com/acme/widget.git/" },
    ],
    repositoryName: "widget",
  };
  const central = deriveStableRepositoryIdentity(input);
  const remote = agent.deriveStableRepositoryIdentity(input.remotes, input.repositoryName);
  assert.deepEqual(remote, central);
  assert.match(central.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(central.selectedRemote, "origin");
});

test("ambiguous, missing, renamed, and local-only identities fail closed", () => {
  assert.throws(
    () =>
      deriveStableRepositoryIdentity({
        remotes: [
          { name: "one", url: "https://github.com/acme/widget.git" },
          { name: "two", url: "https://github.com/acme/widget.git" },
        ],
        repositoryName: "widget",
      }),
    /ambiguous/,
  );
  assert.throws(() => deriveStableRepositoryIdentity({ remotes: [], repositoryName: "widget" }), /Local-only/);
  assert.throws(
    () =>
      deriveStableRepositoryIdentity({
        remotes: [{ name: "origin", url: "https://github.com/acme/renamed.git" }],
        repositoryName: "widget",
      }),
    /does not exactly match/,
  );
});

test("same directory name on different remotes produces different identities", () => {
  const first = deriveStableRepositoryIdentity({
    remotes: [{ name: "origin", url: "https://github.com/acme/widget.git" }],
    repositoryName: "widget",
  });
  const fork = deriveStableRepositoryIdentity({
    remotes: [{ name: "origin", url: "https://github.com/other/widget.git" }],
    repositoryName: "widget",
  });
  assert.notEqual(first.fingerprint, fork.fingerprint);
});

test("canonical identity normalizes default ports and preserves non-default ports", () => {
  assert.equal(canonicalizeRemoteUrl("https://git.example.test:443/acme/widget.git"), "git.example.test/acme/widget");
  assert.equal(canonicalizeRemoteUrl("ssh://git@git.example.test:22/acme/widget.git"), "git.example.test/acme/widget");
  assert.equal(
    canonicalizeRemoteUrl("https://git.example.test:8443/acme/widget.git"),
    "git.example.test:8443/acme/widget",
  );
  assert.notEqual(
    deriveStableRepositoryIdentity({
      remotes: [{ name: "origin", url: "https://git.example.test/acme/widget.git" }],
      repositoryName: "widget",
    }).fingerprint,
    deriveStableRepositoryIdentity({
      remotes: [{ name: "origin", url: "https://git.example.test:8443/acme/widget.git" }],
      repositoryName: "widget",
    }).fingerprint,
  );
});

test("approval fingerprint binds every authority-bearing field", () => {
  const base = {
    repositoryId: "repository",
    agentId: "agent",
    legacyFingerprint: "a".repeat(64),
    stableFingerprint: "b".repeat(64),
    canonicalRemoteUrl: "github.com/acme/widget",
    repositoryName: "widget",
    registeredPath: "/registered/widget",
    currentHead: "c".repeat(40),
    selectedRemote: "origin",
    permissions: {
      readAllowed: true,
      writeAllowed: false,
      commitAllowed: false,
      pushAllowed: false,
      pullRequestAllowed: false,
      mergeAllowed: false,
      deploymentAllowed: false,
    },
    projectBrainEnabled: false,
  };
  const original = repositoryIdentityRequestFingerprint(base);
  for (const mutation of [
    { repositoryId: "substitution" },
    { agentId: "other-agent" },
    { stableFingerprint: "d".repeat(64) },
    { registeredPath: "/other/widget" },
    { currentHead: "e".repeat(40) },
    { projectBrainEnabled: true },
    { permissions: { ...base.permissions, writeAllowed: true } },
  ])
    assert.notEqual(repositoryIdentityRequestFingerprint({ ...base, ...mutation }), original);
});

test("migration schema preserves history and forbids ID replacement semantics", async () => {
  const sql = await readFile(
    new URL("../db/migrations/0028_repository_identity_migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /repository_identities/);
  assert.match(sql, /legacy-v1/);
  assert.match(sql, /stable-v2/);
  assert.doesNotMatch(sql, /DELETE FROM repositories/i);
  assert.doesNotMatch(sql, /UPDATE repositories SET repository_id/i);
  assert.doesNotMatch(sql, /SET identity_version='stable-v2'/i);
});

test("owner approval and rollback routes return mutation-origin rejection", async () => {
  for (const path of [
    "../app/api/repository-identity-migrations/[migrationId]/approve/route.ts",
    "../app/api/repository-identity-migrations/[migrationId]/rollback/route.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /const originError = requireMutationOrigin\(request\);/);
    assert.match(source, /if \(originError\) return originError;/);
  }
});

test("one-shot agent migrator exposes explicit preview and complete without a compatibility bypass", async () => {
  const source = await readFile(new URL("../public/repository-identity-migrator-1.mjs", import.meta.url), "utf8");
  assert.match(source, /command === "preview"/);
  assert.match(source, /command === "complete"/);
  assert.match(source, /current\.stable\.fingerprint !== pending\.stableFingerprint/);
  assert.doesNotMatch(source, /ignoreFingerprint|allowFingerprintMismatch|compatibilityBypass/);
});

test("approved Mission Agent 0.6.8 artifact remains byte-for-byte unchanged", async () => {
  const source = await readFile(new URL("../public/mission-agent-0.6.8.mjs", import.meta.url));
  assert.equal(
    (await import("node:crypto")).createHash("sha256").update(source).digest("hex"),
    "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
  );
});

test("one-shot migrator bytes match detached metadata", async () => {
  const source = await readFile(new URL("../public/repository-identity-migrator-1.mjs", import.meta.url));
  const metadata = JSON.parse(
    await readFile(new URL("../public/repository-identity-migrator-1.mjs.artifact.json", import.meta.url), "utf8"),
  );
  assert.equal((await import("node:crypto")).createHash("sha256").update(source).digest("hex"), metadata.sha256);
  assert.equal(metadata.version, "1");
});

test("Mission Agent 0.6.9 bytes match unsigned metadata but are not trusted by the approved registry", async () => {
  const source = await readFile(new URL("../public/mission-agent-0.6.9.mjs", import.meta.url));
  const metadata = JSON.parse(
    await readFile(new URL("../public/mission-agent-0.6.9.mjs.artifact.json", import.meta.url), "utf8"),
  );
  const checksum = (await import("node:crypto")).createHash("sha256").update(source).digest("hex");
  const { approvedMissionAgentArtifacts } = await import("../integrations/mission-agent/artifact-manifest.ts");
  assert.equal(checksum, metadata.sha256);
  assert.equal(metadata.version, "0.6.9");
  assert.equal(approvedMissionAgentArtifacts["0.6.9"], undefined);
  assert.match(source.toString("utf8"), /identity-activate/);
  assert.match(source.toString("utf8"), /repositoryIdentity/);
});

test("shared canonicalization fixtures agree across central and Mission Agent 0.6.9", async () => {
  const fixtures = JSON.parse(
    await readFile(new URL("../integrations/mission-agent/repository-identity-v2-fixtures.json", import.meta.url)),
  );
  const source = await readFile(new URL("../public/mission-agent-0.6.9.mjs", import.meta.url), "utf8");
  const moduleSource = source
    .slice(0, source.lastIndexOf("\nif (process.argv[1]"))
    .replace("const sourceArtifactPath = fileURLToPath(import.meta.url);", 'const sourceArtifactPath = "/tmp/test.mjs";');
  const missionAgent = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
  for (const fixture of fixtures) {
    const central = deriveStableRepositoryIdentity({
      remotes: fixture.remotes,
      repositoryName: fixture.repositoryName,
    });
    const remote = missionAgent.deriveStableRepositoryIdentity(fixture.remotes, fixture.repositoryName);
    assert.equal(
      central.canonicalRemoteUrl,
      fixture.canonicalRemoteUrl,
    );
    assert.deepEqual(remote, central);
  }
  assert.match(source, /parsed\.port !== defaults\[parsed\.protocol\]/);
  assert.match(source, /origin\.length === 1/);
});

test("every dispatch layer contains the repository identity transition barrier", async () => {
  for (const path of [
    "../application/registry.ts",
    "../application/execution-commands.ts",
    "../application/project-brain-commands.ts",
    "../application/pull-assignments.ts",
    "../application/publication-assignments.ts",
    "../integrations/project-brain/remote-dispatch.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /identity_migration_status/);
    assert.match(source, /not_required/);
    assert.match(source, /completed/);
  }
});
