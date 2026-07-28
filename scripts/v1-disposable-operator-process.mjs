import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../application/v1-production-runtime-identity.ts";
import { executeV1OperatorRequest } from "../application/v1-macos-operator.ts";
import { sha256, signProtocolRequest } from "../remote-agent/protocol.ts";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function postStatus(value) {
  const path = "/api/mission-agent/replacement-bootstrap/status";
  const body = canonicalJson(value);
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(24).toString("base64url");
  const messageId = randomUUID();
  const bodyChecksum = sha256(body);
  const signature = signProtocolRequest(input.credentialKey, {
    method: "POST",
    path,
    timestamp,
    nonce,
    messageId,
    protocolVersion: "replacement-bootstrap-v1",
    bodyChecksum,
  });
  const response = await fetch(`${input.origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": input.agentId,
      "x-mc-credential-id": input.credentialId,
      "x-mc-timestamp": timestamp,
      "x-mc-nonce": nonce,
      "x-mc-message-id": messageId,
      "x-mc-protocol-version": "replacement-bootstrap-v1",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`operator confirmation rejected: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function readProviderState() {
  return JSON.parse(await readFile(input.providerStatePath, "utf8"));
}

const provider = {
  async inspect(request) {
    const state = await readProviderState();
    return state.mutations[request.providerMutationId] ? "postcondition" : "precondition";
  },
  async execute(request) {
    const state = await readProviderState();
    if (state.mutations[request.providerMutationId]) throw new Error("duplicate provider mutation");
    state.counts[request.operation] = (state.counts[request.operation] ?? 0) + 1;
    const receipt = {
      providerMutationId: request.providerMutationId,
      operation: request.operation,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      resultChecksum: hash(
        JSON.stringify({
          providerMutationId: request.providerMutationId,
          operation: request.operation,
          observations: [{ mutation: request.operation, count: 1 }],
        }),
      ),
      safeSummary: `${request.operation} completed in the disposable stateful provider`,
      observations: [{ mutation: request.operation, count: 1 }],
    };
    state.mutations[request.providerMutationId] = receipt;
    await writeFile(input.providerStatePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    return receipt;
  },
  async verify(request) {
    const state = await readProviderState();
    const receipt = state.mutations[request.providerMutationId];
    if (!receipt) throw new Error("provider postcondition is absent");
    return receipt;
  },
};

let confirmedJournalChecksum;
const result = await executeV1OperatorRequest({
  request: input.request,
  expectedBinding: input.expectedBinding,
  credentialKey: input.credentialKey,
  boundary: input.boundary,
  provider,
  assertRuntimeBoundary: async () => undefined,
  async confirmWithControlPlane({ request, requestChecksum, journalChecksum }) {
    confirmedJournalChecksum = journalChecksum;
    await postStatus({
      authorizationId: input.authorizationId,
      executionId: input.executionId,
      authorizationFingerprint: input.authorizationFingerprint,
      claimGeneration: 1,
      action: "operator_journal_head",
      expectedState: input.expectedState,
      expectedSequence: input.expectedSequence,
      fencingGeneration: input.fencingGeneration,
      eventId: randomUUID(),
      grantId: input.grantId,
      operatorRequestChecksum: requestChecksum,
      operatorRequestMessageId: request.requestMessageId,
      operatorRequestNonce: request.nonce,
      operatorJournalChecksum: journalChecksum,
    });
    return { accepted: true, currentJournalChecksum: journalChecksum };
  },
  afterProviderExecuted:
    input.crashBoundary === "after-provider"
      ? async () => {
          process.exit(71);
        }
      : undefined,
  afterReceiptPersisted:
    input.crashBoundary === "after-receipt"
      ? async () => {
          process.exit(72);
        }
      : undefined,
});

process.stdout.write(`${JSON.stringify({ ...result, confirmedJournalChecksum })}\n`);
