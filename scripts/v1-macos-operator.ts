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
  REPLACEMENT_RECEIPT_PATH,
  REPLACEMENT_STATUS_PATH,
  verifyReplacementAuthorizationPackage,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import { TARGET_SHA256 } from "../integrations/mission-agent/replacement-bootstrap";
import { deriveSigningKey, signProtocolRequest } from "../remote-agent/protocol";
import { canonicalJson } from "../application/v1-production-runtime-identity";
import { signV1HostBoundPayload, V1_HOST_PRIVATE_KEY_PATH } from "../application/v1-operator-host-identity";

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
  verifyV1OperatorGrant(grant, credentialKey, new Date(), { allowExpiredReceiptRecovery: true });
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
    grant.allowedOperation !== request.operation ||
    grant.providerMutationId !== request.providerMutationId ||
    grant.sequence !== request.sequence ||
    grant.currentControllerFencingGeneration !== request.currentControllerFencingGeneration ||
    grant.currentControllerDeploymentId !== request.currentControllerDeploymentId ||
    request.grantId !== grant.grantId ||
    request.grantChecksum !== createHash("sha256").update(canonicalJson(grant)).digest("hex")
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
  const protocolPost = async (path: string, bodyValue: Record<string, unknown>) => {
    if (
      (bodyValue.action === "acknowledge_grant" && path === REPLACEMENT_STATUS_PATH) ||
      (bodyValue.action === "accept_provider_receipt" && path === REPLACEMENT_RECEIPT_PATH)
    )
      bodyValue.hostSignature = await signV1HostBoundPayload(bodyValue, V1_HOST_PRIVATE_KEY_PATH);
    const body = canonicalJson(bodyValue);
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const messageId = randomUUID();
    const bodyChecksum = createHash("sha256").update(body).digest("hex");
    const signature = signProtocolRequest(credentialKey, {
      method: "POST",
      path,
      timestamp,
      nonce,
      messageId,
      protocolVersion: REPLACEMENT_CREDENTIAL_PROTOCOL,
      bodyChecksum,
    });
    const response = await fetch(new URL(path, grant.missionControlUrl), {
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
    if (!response.ok) throw new Error(`Mission Control rejected ${path} (${response.status}).`);
    return (await response.json()) as Record<string, unknown>;
  };
  await protocolPost(REPLACEMENT_STATUS_PATH, {
    authorizationId: expectedBinding.authorizationId,
    executionId: expectedBinding.executionId,
    authorizationFingerprint: expectedBinding.authorizationFingerprint,
    claimGeneration: 1,
    action: "acknowledge_grant",
    expectedState: grant.grantKind === "forward" ? "grant_delivered" : "rollback_grant_delivered",
    expectedSequence: grant.lifecycleSequence + 2,
    fencingGeneration: request.fencingGeneration,
    eventId: randomUUID(),
    grantId: grant.grantId,
    grantChecksum: request.grantChecksum,
    acknowledgementChecksum: createHash("sha256").update(canonicalJson(grant)).digest("hex"),
    operatorJournalChecksum: request.expectedJournalChecksum,
  });
  let confirmedJournalChecksum = request.expectedJournalChecksum;
  const result = await executeV1OperatorRequest({
    request,
    expectedBinding,
    credentialKey,
    boundary,
    provider: createV1MacOSOperatorProvider(resolve(parsed.values["repository-root"]!), authorizationPackage),
    async confirmWithControlPlane({ request: pending, requestChecksum, journalChecksum }) {
      confirmedJournalChecksum = journalChecksum;
      const confirmation = await protocolPost(REPLACEMENT_STATUS_PATH, {
        authorizationId: expectedBinding.authorizationId,
        executionId: expectedBinding.executionId,
        authorizationFingerprint: expectedBinding.authorizationFingerprint,
        claimGeneration: 1,
        action: "operator_journal_head",
        expectedState: grant.grantKind === "forward" ? "mutation_intent_committed" : "rollback_intent_committed",
        expectedSequence: grant.lifecycleSequence + 3,
        fencingGeneration: pending.fencingGeneration,
        eventId: randomUUID(),
        grantId: grant.grantId,
        operatorRequestChecksum: requestChecksum,
        operatorRequestMessageId: pending.requestMessageId,
        operatorRequestNonce: pending.nonce,
        operatorJournalChecksum: journalChecksum,
      });
      if (
        confirmation.state !==
        (grant.grantKind === "forward" ? "awaiting_provider_receipt" : "awaiting_rollback_receipt")
      )
        throw new Error("Mission Control did not persist the exact operator journal intent.");
      return {
        accepted: true as const,
        currentJournalChecksum: journalChecksum,
      };
    },
  });
  const provider = result.providerReceipt.receipt;
  await protocolPost(REPLACEMENT_RECEIPT_PATH, {
    authorizationId: expectedBinding.authorizationId,
    executionId: expectedBinding.executionId,
    authorizationFingerprint: expectedBinding.authorizationFingerprint,
    claimGeneration: 1,
    action: "accept_provider_receipt",
    expectedState: grant.grantKind === "forward" ? "awaiting_provider_receipt" : "awaiting_rollback_receipt",
    expectedSequence: grant.lifecycleSequence + 4,
    fencingGeneration: request.fencingGeneration,
    eventId: randomUUID(),
    grantId: grant.grantId,
    providerMutationId: request.providerMutationId,
    operation: request.operation,
    priorStateChecksum: request.expectedJournalChecksum,
    resultingStateChecksum: provider.resultChecksum,
    localJournalEntryId: result.localJournalEntryId,
    executedAt: provider.completedAt,
    operatorRequestMessageId: request.requestMessageId,
    operatorRequestNonce: request.nonce,
    priorOperatorJournalChecksum: confirmedJournalChecksum,
    operatorJournalChecksum: result.operatorJournalChecksum,
    receiptBytes: result.receiptBytes,
    receiptChecksum: result.receiptChecksum,
    authenticatedReceiptTag: result.providerReceipt.authenticationTag,
    verificationEvidenceChecksum: provider.resultChecksum,
    outcome: "succeeded",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
