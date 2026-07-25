import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fixtures from "../integrations/mission-agent/release-authority-v2-fixtures.json" with { type: "json" };
import repositoryFixtures from "../integrations/mission-agent/repository-identity-v2-fixtures.json" with { type: "json" };
import { canonicalJson as missionControlCanonicalJson } from "../integrations/mission-agent/release-authority.ts";

const artifactUrl = new URL("../public/mission-agent-0.7.0.mjs", import.meta.url);
const artifactBytes = await readFile(artifactUrl);
const artifactSource = artifactBytes.toString();
const agent = await import(artifactUrl.href);
const manifest = fixtures.unsignedManifest;
const oldKey = {
  keyId: "mission-agent-release-2026-01",
  algorithm: "Ed25519",
  publicKeySpkiBase64: "MCowBQYDK2VwAyEAkJJvbXaL3hnwifCZ/nyTD9z3oNWyJRCjxxfjXMWhVwo=",
  publicKeyFingerprint: "ed25519-spki-sha256:ad7dcb56c9eea2493af236b1d4c9e393d2d4df4e9a6347c3fe3fd627d788140a",
  status: "pending",
  purpose: "mission-agent-release",
  activatedAt: null,
  retiresAt: null,
  revokedAt: null,
};

test("0.6.8 and 0.6.9 historical artifacts remain immutable while 0.7.0 is new", async () => {
  const [v068, v069] = await Promise.all([
    readFile(new URL("../public/mission-agent-0.6.8.mjs", import.meta.url)),
    readFile(new URL("../public/mission-agent-0.6.9.mjs", import.meta.url)),
  ]);
  assert.equal(
    createHash("sha256").update(v068).digest("hex"),
    "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
  );
  assert.equal(
    createHash("sha256").update(v069).digest("hex"),
    "a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af",
  );
  assert.equal(
    createHash("sha256").update(artifactBytes).digest("hex"),
    "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e",
  );
});

test("0.7.0 immutable artifact metadata binds v2 authority, key ID, and build source", async () => {
  assert.deepEqual(await agent.artifactIdentity(), {
    sha256: "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e",
    manifestVersion: "2",
    signingKeyId: "mission-agent-release-2026-01",
    releaseAuthorityVersion: "2",
    sourceCommit: "a6d867f217c6e28ce811fbb5b8bf8778fad193c4",
  });
});

test("manifest v2 parser is strict and canonical text rejects duplicate and unknown fields", () => {
  assert.deepEqual(agent.parseReleaseManifestV2(manifest), manifest);
  assert.equal(agent.canonicalJson(manifest), missionControlCanonicalJson(manifest));
  for (const changed of [
    { ...manifest, signingKeyId: undefined },
    { ...manifest, signingKeyId: "unknown" },
    { ...manifest, artifactSha256: "A".repeat(64) },
    { ...manifest, sourceCommit: "a".repeat(39) },
    { ...manifest, identityProtocolVersion: "1" },
    { ...manifest, activationProtocolVersion: "2" },
    { ...manifest, extra: true },
  ])
    assert.throws(() => agent.parseReleaseManifestV2(changed));
  assert.throws(
    () => agent.verifyReleaseManifestText('{"manifestVersion":"2","manifestVersion":"2"}'),
    /fields|canonical/,
  );
  assert.throws(
    () => agent.verifyReleaseManifestText(JSON.stringify({ ...manifest, signature: "AA==" }, null, 2)),
    /canonical/,
  );
});

test("all non-active trust states, unknown keys, and malformed signatures fail closed", () => {
  for (const status of ["pending", "retiring", "retired", "revoked"]) {
    const key = {
      ...oldKey,
      status,
      activatedAt: ["retiring", "retired"].includes(status) ? "2026-07-25T18:01:20.000Z" : null,
      retiresAt: status === "retired" ? "2026-07-25T23:00:00.000Z" : null,
      revokedAt: status === "revoked" ? "2026-07-25T18:01:20.000Z" : null,
    };
    assert.throws(
      () =>
        agent.verifyReleaseManifestV2(
          { ...manifest, signature: "A".repeat(88) },
          { now: new Date("2026-07-26T00:00:00.000Z"), trustStore: { [key.keyId]: key } },
        ),
      /not active/,
    );
  }
  assert.throws(
    () =>
      agent.verifyReleaseManifestV2(
        { ...manifest, signature: "AA==" },
        { now: new Date("2026-07-26T00:00:00.000Z"), trustStore: {} },
      ),
    /not active/,
  );
  const active = { ...oldKey, status: "active", activatedAt: "2026-07-25T18:01:20.000Z" };
  assert.throws(
    () =>
      agent.verifyReleaseManifestV2(
        { ...manifest, signature: "AA==" },
        { now: new Date("2026-07-26T00:00:00.000Z"), trustStore: { [active.keyId]: active } },
      ),
    /canonical Ed25519/,
  );
});

test("legacy v1 is accepted only for explicit governed rollback to exact signed 0.6.8", async () => {
  const published = await readFile(new URL("../public/mission-agent-latest.json", import.meta.url), "utf8");
  assert.equal(agent.verifyReleaseManifestText(published, { allowRollbackVersion: "0.6.8" }).version, "0.6.8");
  assert.throws(() => agent.verifyReleaseManifestText(published), /rollback/);
  assert.throws(
    () =>
      agent.verifyReleaseManifestText(
        JSON.stringify({
          version: "0.6.9",
          path: "/mission-agent-0.6.9.mjs",
          sha256: "a7ecca3bd6f81effa5d17843183cd45d15e1b3c5543e445879c84d503950f8af",
          manifestVersion: "1",
          signature: "",
        }),
        { allowRollbackVersion: "0.6.9" },
      ),
    /rollback/,
  );
});

test("stable-v2 repository fixtures agree with the Mission Agent", () => {
  for (const fixture of repositoryFixtures) {
    const actual = agent.deriveStableRepositoryIdentity(fixture.remotes, fixture.repositoryName);
    assert.equal(actual.canonicalRemoteUrl, fixture.canonicalRemoteUrl);
    assert.equal(actual.fingerprint, fixture.fingerprint);
  }
});

test("capability and execution sources bind release metadata and identity transition barriers", () => {
  for (const required of [
    "authorityVersion: RELEASE_AUTHORITY_VERSION",
    "manifestVersion: RELEASE_MANIFEST_VERSION",
    "signingKeyId: artifact.signingKeyId",
    "sourceCommit: BUILD_SOURCE_COMMIT",
    'stableProtocolVersion: "2"',
    'activationAcknowledgementVersion: "1"',
    "Repository identity transition dispatch barrier is active.",
    "RepositoryIdentityRollbackAcknowledged",
    "rollbackRepositoryIdentity",
    "requiredProjectBrainVersion",
    "requiredContractVersion",
  ])
    assert.match(artifactSource, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    artifactSource,
    /await registerRepository\(config, repository\.path\);\s+await heartbeat\(config\);\s+delete repository\.identityTransition;/,
  );
  assert.match(artifactSource, /\.\.\.\(existingRegistration \?\? \{\}\),\s+path: repository\.path,/);
});

test("shared acknowledgement fixtures have identical canonical bytes in agent and Mission Control tooling", () => {
  for (const payload of [fixtures.activationAcknowledgement, fixtures.rollbackAcknowledgement])
    assert.equal(agent.canonicalJson(payload), missionControlCanonicalJson(payload));
});

test("interrupted rollback acknowledgement resumes from durable transition state", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "mission-agent-070-rollback-"));
  const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = resolve(home, "config.json");
  const secret = "local-test-credential";
  const repositoryId = randomUUID();
  const stableFingerprint = "b".repeat(64);
  const legacyFingerprint = "a".repeat(64);
  await writeFile(
    configPath,
    JSON.stringify({
      missionControlUrl: "https://mission-control.test",
      workspaceId: randomUUID(),
      agentId: randomUUID(),
      credentialId: randomUUID(),
      agentName: "rollback-test",
      adapter: "codex",
      secret,
      repositories: {
        [repositoryId]: {
          path: repositoryPath,
          name: "mission-control-agent-068-identity",
          identityVersion: "stable-v2",
          fingerprint: stableFingerprint,
          identityHistory: [{ identityVersion: "legacy-v1", fingerprint: legacyFingerprint }],
        },
      },
    }),
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  const previousHome = process.env.MISSION_AGENT_HOME;
  const previousFetch = globalThis.fetch;
  process.env.MISSION_AGENT_HOME = home;
  let acknowledgementAttempts = 0;
  try {
    const isolated = await import(`${artifactUrl.href}?rollback-recovery=${randomUUID()}`);
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/rollback/prepare")) {
        const unsigned = {
          protocolVersion: "1",
          requestId: randomUUID(),
          migrationId: randomUUID(),
          repositoryId,
          agentVersion: "0.7.0",
          requiredArtifactChecksum: "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e",
          stableFingerprint,
          rollbackFingerprint: legacyFingerprint,
          identityProtocolVersion: "2",
          activationProtocolVersion: "1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        const requestChecksum = createHash("sha256").update(isolated.canonicalJson(unsigned)).digest("hex");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rollbackRequest: {
              ...unsigned,
              requestChecksum,
              missionControlSignature: createHmac("sha256", createHash("sha256").update(secret).digest("hex"))
                .update(requestChecksum)
                .digest("hex"),
            },
          }),
        };
      }
      if (path.endsWith("/rollback/acknowledge")) {
        acknowledgementAttempts += 1;
        if (acknowledgementAttempts === 1) throw new Error("simulated acknowledgement interruption");
        return { ok: true, status: 200, json: async () => ({ status: "accepted" }) };
      }
      if (path.endsWith("/messages")) return { ok: true, status: 204, json: async () => ({}) };
      throw new Error(`Unexpected test request: ${path}`);
    };
    await assert.rejects(() => isolated.rollbackRepositoryIdentity(repositoryId), /interruption/);
    const interrupted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(interrupted.repositories[repositoryId].identityTransition.status, "rolling_back");
    assert.equal(interrupted.repositories[repositoryId].identityVersion, "legacy-v1");
    await isolated.rollbackRepositoryIdentity(repositoryId);
    const recovered = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(recovered.repositories[repositoryId].identityVersion, "legacy-v1");
    assert.equal(recovered.repositories[repositoryId].identityTransition, undefined);
    assert.equal(acknowledgementAttempts, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.MISSION_AGENT_HOME;
    else process.env.MISSION_AGENT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("unsigned 0.7.0 manifest and unsigned 0.6.9 metadata are not trusted signatures", () => {
  assert.throws(() => agent.verifyReleaseManifest(manifest), /signature|not active/);
  assert.doesNotMatch(artifactSource, /BEGIN (?:ED25519 )?PRIVATE KEY/);
});
