import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createV1HostIdentityKey,
  signV1HostStartupEvidence,
  verifyV1HostStartupEvidence,
  V1_HOST_IDENTITY_PROTOCOL,
} from "../application/v1-operator-host-identity.ts";

const now = new Date("2026-07-28T12:00:00.000Z");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "v1-host-identity-"));
  const keyPath = join(root, "host.pk8");
  const identity = await createV1HostIdentityKey(keyPath);
  const evidence = await signV1HostStartupEvidence(
    {
      protocolVersion: V1_HOST_IDENTITY_PROTOCOL,
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      challengeNonce: "host-challenge-nonce-with-sufficient-entropy",
      challengeExpiresAt: "2026-07-28T12:05:00.000Z",
      hostPublicKeySpki: identity.publicKeySpki,
      hostFingerprint: identity.fingerprint,
      operatorArtifactSha256: "4".repeat(64),
      operatorProtocolVersion: "1",
      macOSUserId: 501,
      agentId: "0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8",
      installationPath:
        "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs",
      launchAgentLabel: "com.wallyweb.mission-agent.replacement-operator",
      journalGeneration: 1,
      observedAt: now.toISOString(),
    },
    keyPath,
  );
  return { evidence, identity };
}

function verifyFixture(evidence, identity) {
  verifyV1HostStartupEvidence({
    evidence,
    expectedChallengeId: evidence.challengeId,
    expectedChallengeNonce: evidence.challengeNonce,
    expectedHostFingerprint: identity.fingerprint,
    expectedAgentId: evidence.agentId,
    expectedOperatorArtifactSha256: evidence.operatorArtifactSha256,
    expectedOperatorProtocolVersion: evidence.operatorProtocolVersion,
    expectedInstallationPath: evidence.installationPath,
    expectedLaunchAgentLabel: evidence.launchAgentLabel,
    expectedUserId: evidence.macOSUserId,
    minimumJournalGeneration: 1,
    now,
  });
}

test("same-user host identity proves the exact operator startup binding", async () => {
  const { evidence, identity } = await fixture();
  verifyFixture(evidence, identity);
  assert.match(identity.fingerprint, /^ed25519-spki-sha256:[a-f0-9]{64}$/);
});

test("host evidence fails closed for signature, host, artifact, user, and replay drift", async () => {
  const { evidence, identity } = await fixture();
  for (const changed of [
    { operatorArtifactSha256: "5".repeat(64) },
    { macOSUserId: 502 },
    { journalGeneration: 0 },
    { challengeNonce: "different-challenge" },
    { signature: `${evidence.signature.slice(0, -2)}AA` },
  ])
    assert.throws(() => verifyFixture({ ...evidence, ...changed }, identity), /stale|malformed|unauthenticated/i);
  assert.throws(
    () =>
      verifyV1HostStartupEvidence({
        evidence,
        expectedChallengeId: evidence.challengeId,
        expectedChallengeNonce: evidence.challengeNonce,
        expectedHostFingerprint: identity.fingerprint,
        expectedAgentId: evidence.agentId,
        expectedOperatorArtifactSha256: evidence.operatorArtifactSha256,
        expectedOperatorProtocolVersion: evidence.operatorProtocolVersion,
        expectedInstallationPath: evidence.installationPath,
        expectedLaunchAgentLabel: evidence.launchAgentLabel,
        expectedUserId: evidence.macOSUserId,
        minimumJournalGeneration: 1,
        now: new Date("2026-07-28T12:06:00.000Z"),
      }),
    /stale|malformed|unauthenticated/i,
  );
});
