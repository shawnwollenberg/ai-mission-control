import { randomBytes, randomUUID } from "node:crypto";
import {
  REPLACEMENT_CLAIM_PATH,
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  REPLACEMENT_DECISION_PATH,
  REPLACEMENT_INTENT_PATH,
  REPLACEMENT_RECEIPT_PATH,
  REPLACEMENT_STATUS_PATH,
  REPLACEMENT_FAILURE_PATH,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { sha256, signProtocolRequest } from "../remote-agent/protocol";
import type { LocalOperationReceipt, ReplacementControlPlane } from "./replacement-bootstrap-local-operator";

export function createLocalReplacementControlPlane(input: {
  missionControlUrl: string;
  credentialSigningKey: string;
  pkg: ReplacementAuthorizationPackage;
  fetchImplementation?: typeof fetch;
}): ReplacementControlPlane {
  const base = new URL(input.missionControlUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/")
    throw new Error("Mission Control replacement endpoint must be an HTTPS origin.");
  if (!/^[a-f0-9]{64}$/.test(input.credentialSigningKey))
    throw new Error("Replacement credential signing key is invalid.");
  const request = async (path: string, body: object, suppliedNonce?: string) => {
    if (
      ![
        REPLACEMENT_CLAIM_PATH,
        REPLACEMENT_INTENT_PATH,
        REPLACEMENT_RECEIPT_PATH,
        REPLACEMENT_DECISION_PATH,
        REPLACEMENT_STATUS_PATH,
        REPLACEMENT_FAILURE_PATH,
      ].includes(path as never)
    )
      throw new Error("Unapproved replacement control-plane path.");
    const text = canonicalJson(body);
    const timestamp = new Date().toISOString();
    const nonce = suppliedNonce ?? randomBytes(24).toString("base64url");
    const messageId = randomUUID();
    const bodyChecksum = sha256(text);
    const signature = signProtocolRequest(input.credentialSigningKey, {
      method: "POST",
      path,
      timestamp,
      nonce,
      messageId,
      protocolVersion: REPLACEMENT_CREDENTIAL_PROTOCOL,
      bodyChecksum,
    });
    const response = await (input.fetchImplementation ?? fetch)(new URL(path, base), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
        "x-mc-agent-id": input.pkg.authorization.agentId,
        "x-mc-credential-id": input.pkg.credentialId,
        "x-mc-timestamp": timestamp,
        "x-mc-nonce": nonce,
        "x-mc-message-id": messageId,
        "x-mc-protocol-version": REPLACEMENT_CREDENTIAL_PROTOCOL,
        "x-mc-body-sha256": bodyChecksum,
        "x-mc-signature": signature,
      },
      body: text,
    });
    if (response.status === 409 && path === REPLACEMENT_DECISION_PATH) return { status: "pending" };
    if (!response.ok) throw new Error(`Mission Control replacement request failed with status ${response.status}.`);
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    async claim({ packageChecksum }) {
      const value = await request(REPLACEMENT_CLAIM_PATH, {
        authorizationId: input.pkg.authorization.authorizationId,
        executionId: input.pkg.executionId,
        packageChecksum,
        nonce: input.pkg.nonce,
      });
      if (value.claimed !== true || value.nextSequence !== 1 || value.claimGeneration !== 1)
        throw new Error("Mission Control replacement claim response is invalid.");
      return { claimed: true, nextSequence: 1, claimGeneration: 1 };
    },
    async createMutationIntent(intent) {
      const value = await request(REPLACEMENT_INTENT_PATH, intent);
      if (
        typeof value.intentChecksum !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.intentChecksum) ||
        !["inspect-then-once", "never"].includes(String(value.retryPolicy))
      )
        throw new Error("Mission Control mutation-intent response is invalid.");
      return {
        intentChecksum: value.intentChecksum,
        retryPolicy: value.retryPolicy as "inspect-then-once" | "never",
      };
    },
    async recoveryState(value) {
      const state = await request(REPLACEMENT_STATUS_PATH, value);
      if (
        typeof state.state !== "string" ||
        !Number.isSafeInteger(state.lastAcceptedSequence) ||
        (state.lastAcceptedOperation !== null && typeof state.lastAcceptedOperation !== "string")
      )
        throw new Error("Mission Control recovery state is invalid.");
      return state as Awaited<ReturnType<ReplacementControlPlane["recoveryState"]>>;
    },
    async beginRollback(value) {
      const result = await request(REPLACEMENT_FAILURE_PATH, value);
      if (result.rollbackRequired !== true || result.nextOperation !== "restore_artifact")
        throw new Error("Mission Control rollback boundary response is invalid.");
      return { rollbackRequired: true, nextOperation: "restore_artifact" };
    },
    async submitReceipt(receipt: LocalOperationReceipt) {
      const value = await request(REPLACEMENT_RECEIPT_PATH, receipt, receipt.requestNonce);
      if (value.accepted !== true || !Number.isSafeInteger(value.nextSequence))
        throw new Error("Mission Control replacement receipt response is invalid.");
      return { accepted: true, nextSequence: Number(value.nextSequence) };
    },
    async awaitSmokeDecision({ authorizationId, executionId }) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const value = await request(REPLACEMENT_DECISION_PATH, {
          authorizationId,
          executionId,
          authorizationFingerprint: input.pkg.authorizationFingerprint,
          claimGeneration: 1,
          request: "smoke-decision",
        });
        if (
          ["continue", "rollback"].includes(String(value.decision)) &&
          typeof value.smokeEvidenceChecksum === "string"
        )
          return {
            decision: value.decision as "continue" | "rollback",
            smokeEvidenceChecksum: value.smokeEvidenceChecksum,
          };
        if (value.status !== "pending") throw new Error("Mission Control smoke decision response is invalid.");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      throw new Error("Mission Control smoke decision timed out after five minutes.");
    },
  };
}
