import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { verifyV1OperatorGrant, type V1OperatorGrant } from "../application/v1-macos-operator-grant";
import { createV1MacOSOperatorProvider } from "../application/v1-macos-operator-provider";
import {
  executeV1OperatorRequest,
  V1_OPERATOR_INSTALL_PATH,
  V1_OPERATOR_JOURNAL_ROOT,
  type V1OperatorRuntimeBoundary,
} from "../application/v1-macos-operator";
import type { V1OperatorBinding, V1OperatorRequest } from "../application/v1-macos-operator-journal";
import {
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  REPLACEMENT_CREDENTIAL_SERVICE,
  REPLACEMENT_STATUS_PATH,
  verifyReplacementAuthorizationPackage,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import { TARGET_SHA256 } from "../integrations/mission-agent/replacement-bootstrap";
import { deriveSigningKey, signProtocolRequest } from "../remote-agent/protocol";

const exec = promisify(execFile);

async function main() {
  const parsed = parseArgs({
    options: {
      request: { type: "string" },
      grant: { type: "string" },
      "authorization-package": { type: "string" },
      "owner-uid": { type: "string" },
      "repository-root": { type: "string" },
    },
    strict: true,
  });
  const requiredKeys = ["request", "grant", "authorization-package", "owner-uid", "repository-root"] as const;
  for (const key of requiredKeys) if (!parsed.values[key]) throw new Error(`--${key} is required.`);
  const request = JSON.parse(await readFile(resolve(parsed.values.request!), "utf8")) as V1OperatorRequest;
  const grant = JSON.parse(await readFile(resolve(parsed.values.grant!), "utf8")) as V1OperatorGrant;
  const rawPackage = JSON.parse(
    await readFile(resolve(parsed.values["authorization-package"]!), "utf8"),
  ) as ReplacementAuthorizationPackage;
  const keychain = await exec(
    "/usr/bin/security",
    ["find-generic-password", "-s", REPLACEMENT_CREDENTIAL_SERVICE, "-a", rawPackage.credentialId, "-w"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 },
  );
  const credentialKey = deriveSigningKey(keychain.stdout.trim());
  verifyV1OperatorGrant(grant, credentialKey);
  const authorizationPackage = verifyReplacementAuthorizationPackage({
    value: rawPackage,
    credentialSigningKey: credentialKey,
  });
  const expectedBinding: V1OperatorBinding = grant.binding;
  if (
    expectedBinding.agentId !== authorizationPackage.authorization.agentId ||
    expectedBinding.targetArtifactSha256 !== TARGET_SHA256 ||
    expectedBinding.authorizationFingerprint !== authorizationPackage.authorizationFingerprint ||
    grant.credentialId !== rawPackage.credentialId ||
    !grant.allowedOperations.includes(request.operation)
  )
    throw new Error("Operator grant contradicts the governed authorization package or request.");
  const journalPath = `${V1_OPERATOR_JOURNAL_ROOT}/${expectedBinding.authorizationId}/${expectedBinding.executionId}.json`;
  const boundary: V1OperatorRuntimeBoundary = {
    executablePath: V1_OPERATOR_INSTALL_PATH,
    executableChecksum: grant.approvedExecutableChecksum,
    expectedUid: Number(parsed.values["owner-uid"]),
    actualUid: process.getuid?.() ?? -1,
    platform: process.platform,
    journalPath,
  };
  const result = await executeV1OperatorRequest({
    request,
    expectedBinding,
    credentialKey,
    boundary,
    provider: createV1MacOSOperatorProvider(resolve(parsed.values["repository-root"]!), authorizationPackage),
    async confirmWithControlPlane({ request: pending, requestChecksum, journalChecksum }) {
      const body = JSON.stringify({
        authorizationId: expectedBinding.authorizationId,
        executionId: expectedBinding.executionId,
        authorizationFingerprint: expectedBinding.authorizationFingerprint,
        claimGeneration: 1,
        v1OperatorConfirmation: {
          providerMutationId: pending.providerMutationId,
          sequence: pending.sequence,
          operation: pending.operation,
          fencingGeneration: pending.fencingGeneration,
          requestChecksum,
          journalChecksum,
        },
      });
      const timestamp = new Date().toISOString();
      const nonce = randomUUID();
      const messageId = randomUUID();
      const bodyChecksum = createHash("sha256").update(body).digest("hex");
      const signature = signProtocolRequest(credentialKey, {
        method: "POST",
        path: REPLACEMENT_STATUS_PATH,
        timestamp,
        nonce,
        messageId,
        protocolVersion: REPLACEMENT_CREDENTIAL_PROTOCOL,
        bodyChecksum,
      });
      const response = await fetch(new URL(REPLACEMENT_STATUS_PATH, grant.missionControlUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mc-agent-id": expectedBinding.agentId,
          "x-mc-credential-id": grant.credentialId,
          "x-mc-timestamp": timestamp,
          "x-mc-nonce": nonce,
          "x-mc-message-id": messageId,
          "x-mc-protocol-version": REPLACEMENT_CREDENTIAL_PROTOCOL,
          "x-mc-body-sha256": bodyChecksum,
          "x-mc-signature": signature,
        },
        body,
      });
      if (!response.ok) throw new Error(`Mission Control rejected operator confirmation (${response.status}).`);
      const confirmation = (await response.json()) as {
        v1OperatorConfirmation?: { accepted?: boolean; currentJournalChecksum?: string };
      };
      if (confirmation.v1OperatorConfirmation?.accepted !== true)
        throw new Error("Mission Control did not authorize the v1 operator request.");
      return {
        accepted: true as const,
        currentJournalChecksum: confirmation.v1OperatorConfirmation.currentJournalChecksum ?? "",
      };
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
