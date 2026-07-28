import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createStatefulDisposableLocalProvider } from "../application/replacement-bootstrap-disposable-local";
import { createLocalReplacementControlPlane } from "../application/replacement-bootstrap-local-client";
import { executeLocalReplacement } from "../application/replacement-bootstrap-local-operator";
import { assertDisposableLocalOperatorEnvironment } from "../application/replacement-bootstrap-safety-gate";
import {
  verifyReplacementAuthorizationPackage,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { deriveSigningKey, sha256, signProtocolRequest } from "../remote-agent/protocol";

type AgentFixture = {
  missionControlUrl: string;
  workspaceId: string;
  agentId: string;
  credentialId: string;
  credentialSecret: string;
};

async function main() {
  const parsed = parseArgs({
    options: {
      package: { type: "string" },
      "replacement-secret": { type: "string" },
      "agent-fixture": { type: "string" },
      journal: { type: "string" },
      state: { type: "string" },
      evidence: { type: "string" },
      "fail-at": { type: "string" },
      "drop-receipt-after": { type: "string" },
    },
    strict: true,
  });
  for (const required of ["package", "replacement-secret", "agent-fixture", "journal", "state", "evidence"] as const)
    if (!parsed.values[required]) throw new Error(`--${required} is required.`);
  const pkg = JSON.parse(await readFile(resolve(parsed.values.package!), "utf8")) as ReplacementAuthorizationPackage;
  const replacementSecret = (await readFile(resolve(parsed.values["replacement-secret"]!), "utf8")).trim();
  const replacementKey = deriveSigningKey(replacementSecret);
  const verified = verifyReplacementAuthorizationPackage({
    value: pkg,
    credentialSigningKey: replacementKey,
  });
  const fixture = JSON.parse(await readFile(resolve(parsed.values["agent-fixture"]!), "utf8")) as AgentFixture;
  assertDisposableLocalOperatorEnvironment({
    environment: process.env,
    missionControlUrl: fixture.missionControlUrl,
    packageInstanceIdentity: verified.missionControlInstanceIdentity,
  });
  if (fixture.agentId !== verified.authorization.agentId || fixture.workspaceId !== verified.authorization.workspaceId)
    throw new Error("Disposable agent fixture does not match the replacement authorization.");

  const agentKey = deriveSigningKey(fixture.credentialSecret);
  const protocolRequest = async (
    path: string,
    message: Record<string, unknown>,
    lease?: { assignmentId: string; leaseOwner: string; leaseToken: string },
  ) => {
    const text = canonicalJson(message);
    const timestamp = String(message.sentAt);
    const messageId = String(message.messageId);
    const nonce = randomBytes(24).toString("base64url");
    const bodyChecksum = sha256(text);
    const signature = signProtocolRequest(agentKey, {
      method: "POST",
      path,
      timestamp,
      nonce,
      messageId,
      protocolVersion: "1.0",
      bodyChecksum,
    });
    const response = await fetch(new URL(path, fixture.missionControlUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mc-agent-id": fixture.agentId,
        "x-mc-credential-id": fixture.credentialId,
        "x-mc-timestamp": timestamp,
        "x-mc-nonce": nonce,
        "x-mc-message-id": messageId,
        "x-mc-protocol-version": "1.0",
        "x-mc-body-sha256": bodyChecksum,
        "x-mc-signature": signature,
        ...(lease
          ? {
              "x-mc-assignment-id": lease.assignmentId,
              "x-mc-lease-owner": lease.leaseOwner,
              "x-mc-lease-token": lease.leaseToken,
            }
          : {}),
      },
      body: text,
    });
    if (!response.ok && response.status !== 204)
      throw new Error(`Disposable agent protocol request failed at ${path}: ${response.status}.`);
    return response.status === 204 ? null : ((await response.json()) as Record<string, unknown>);
  };
  const envelope = (
    messageType: string,
    payload: Record<string, unknown>,
    correlation: Record<string, unknown> = {},
  ) => ({
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId: fixture.agentId,
    workspaceId: fixture.workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: String(correlation.executionId ?? fixture.agentId),
    ...correlation,
    payload,
  });
  const heartbeat = async (rollback: boolean) => {
    await protocolRequest(
      "/api/agent-protocol/v1/messages",
      envelope("AgentHeartbeat", {
        assignmentPull: true,
        missionAgentVersion: rollback ? "0.6.8" : "0.7.2",
        adapter: "codex",
        artifact: {
          sha256: rollback
            ? "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d"
            : "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
          manifestVersion: rollback ? "1" : "3",
          ...(rollback
            ? {}
            : {
                releaseAuthorityVersion: "v2",
                canonicalizationVersion: "release-manifest-json-v3",
              }),
        },
        ...(rollback
          ? {}
          : {
              release: {
                authorityVersion: "v2",
                manifestVersion: "3",
                canonicalizationVersion: "release-manifest-json-v3",
                signingKeyId: "mission-agent-release-2026-01",
                sourceCommit: "31b45c98f2ffba613b56cd23819ba8b0c9c09a43",
              },
            }),
        repositoryIdentity: {
          stableProtocolVersion: "2",
          activationAcknowledgementVersion: "1",
          repositories: [
            {
              repositoryId: verified.authorization.repositoryId,
              fingerprint: verified.authorization.repositoryFingerprint,
            },
          ],
        },
        projectBrain: {
          installed: true,
          runtimeReady: true,
          coreVersion: "0.4.0",
          contractVersions: ["1.0"],
          schemaVersions: ["2.5.0"],
          operations: ["detect_repository"],
          readOperations: ["detect_repository"],
          writeOperations: [],
          diagnosticsStatus: "ready",
          maxRequestBytes: 1024,
          maxResultBytes: 1024,
          artifactTransferModes: ["inline_base64"],
        },
      }),
    );
  };
  let smokeWorker: Promise<void> | undefined;
  const runSmokeWorker = async () => {
    const leaseOwner = `disposable-${randomUUID()}`;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const pull = await protocolRequest(
        "/api/agent-protocol/v1/assignments/pull",
        envelope("AgentAssignmentPullRequested", { leaseOwner, waitSeconds: 0 }),
      );
      const assignment = pull?.assignment as Record<string, unknown> | null | undefined;
      if (!assignment) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        continue;
      }
      const lease = {
        assignmentId: String(assignment.assignmentId),
        leaseOwner,
        leaseToken: String(assignment.leaseToken),
      };
      const correlation = {
        missionId: String(assignment.missionId),
        taskId: String(assignment.taskId),
        executionId: String(assignment.executionId),
        attempt: Number(assignment.attempt),
      };
      await protocolRequest(
        `/api/agent-protocol/v1/assignments/${lease.assignmentId}/acknowledge`,
        envelope("AgentAssignmentAcknowledged", { leaseOwner, leaseToken: lease.leaseToken }, correlation),
      );
      await protocolRequest(
        "/api/agent-protocol/v1/messages",
        envelope(
          "ExecutionHeartbeat",
          {
            workerId: leaseOwner,
            stage: "read_only_verification",
            summary: "Disposable governed replacement smoke is verifying repository identity.",
            progressPercent: 50,
          },
          correlation,
        ),
        lease,
      );
      const artifact = Buffer.from(
        `${canonicalJson({
          evidenceVersion: "replacement-disposable-smoke-v1",
          repositoryId: assignment.repositoryId,
          repositoryFingerprint: assignment.repositoryFingerprint,
          readOnly: true,
          sideEffects: [],
        })}\n`,
      );
      await protocolRequest(
        "/api/agent-protocol/v1/messages",
        envelope(
          "ExecutionArtifactSubmitted",
          {
            name: "replacement-disposable-smoke",
            description: "Checksum-bound disposable read-only acceptance evidence",
            artifactType: "replacement_read_only_smoke",
            mediaType: "application/json",
            byteSize: artifact.byteLength,
            checksum: createHash("sha256").update(Uint8Array.from(artifact)).digest("hex"),
            contentBase64: artifact.toString("base64"),
          },
          correlation,
        ),
        lease,
      );
      await protocolRequest(
        "/api/agent-protocol/v1/messages",
        envelope("ExecutionSucceeded", { summary: "Disposable governed smoke completed." }, correlation),
        lease,
      );
      return;
    }
    throw new Error("Disposable smoke worker found no governed assignment.");
  };

  const provider = createStatefulDisposableLocalProvider({
    statePath: resolve(parsed.values.state!),
    failAt: parsed.values["fail-at"] as never,
    afterOperation: async (operation) => {
      if (operation === "start_service") await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      if (operation === "verify_heartbeats") for (let count = 0; count < 3; count += 1) await heartbeat(false);
      if (operation === "verify_capabilities") smokeWorker ??= runSmokeWorker();
      if (operation === "verify_prior_heartbeats") for (let count = 0; count < 3; count += 1) await heartbeat(true);
    },
  });
  let receiptDropped = false;
  let authenticatedCredentialSubstitutionRejected = false;
  const fetchWithReceiptLoss: typeof fetch = async (url, init) => {
    const requestUrl = new URL(String(url));
    if (
      !authenticatedCredentialSubstitutionRejected &&
      requestUrl.pathname === "/api/mission-agent/replacement-bootstrap/intent"
    ) {
      const substituted = {
        ...(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>),
        credentialId: randomUUID(),
      };
      const text = canonicalJson(substituted);
      const timestamp = new Date().toISOString();
      const nonce = randomBytes(24).toString("base64url");
      const messageId = randomUUID();
      const bodyChecksum = sha256(text);
      const signature = signProtocolRequest(replacementKey, {
        method: "POST",
        path: requestUrl.pathname,
        timestamp,
        nonce,
        messageId,
        protocolVersion: "mission-agent-replacement-bootstrap-v1",
        bodyChecksum,
      });
      const probe = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
          "x-mc-agent-id": verified.authorization.agentId,
          "x-mc-credential-id": verified.credentialId,
          "x-mc-timestamp": timestamp,
          "x-mc-nonce": nonce,
          "x-mc-message-id": messageId,
          "x-mc-protocol-version": "mission-agent-replacement-bootstrap-v1",
          "x-mc-body-sha256": bodyChecksum,
          "x-mc-signature": signature,
        },
        body: text,
      });
      if (probe.status !== 403) throw new Error("Authenticated credential-substitution probe did not fail closed.");
      authenticatedCredentialSubstitutionRejected = true;
    }
    const response = await fetch(url, init);
    if (
      !receiptDropped &&
      parsed.values["drop-receipt-after"] &&
      new URL(String(url)).pathname === "/api/mission-agent/replacement-bootstrap/receipt" &&
      JSON.parse(String(init?.body ?? "{}")).operation === parsed.values["drop-receipt-after"] &&
      response.ok
    ) {
      receiptDropped = true;
      throw new Error("Injected disposable response loss after durable receipt acceptance.");
    }
    return response;
  };
  const result = await executeLocalReplacement({
    packagePath: resolve(parsed.values.package!),
    journalPath: resolve(parsed.values.journal!),
    credentialSigningKey: replacementKey,
    operations: provider,
    controlPlane: createLocalReplacementControlPlane({
      missionControlUrl: fixture.missionControlUrl,
      credentialSigningKey: replacementKey,
      pkg: verified,
      fetchImplementation: fetchWithReceiptLoss,
    }),
  });
  await smokeWorker;
  if (!authenticatedCredentialSubstitutionRejected)
    throw new Error("Authenticated credential-substitution probe was not exercised.");
  const recordedResult = { ...result, authenticatedCredentialSubstitutionRejected };
  await writeFile(resolve(parsed.values.evidence!), `${canonicalJson(recordedResult)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(
    `${canonicalJson({ disposition: result.disposition, evidenceChecksum: result.evidenceChecksum })}\n`,
  );
}

void main();
