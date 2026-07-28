import { getRemoteAgentAuth } from "../application/remote-agent-registry";
import { NAMED_CANARY_ID } from "../integrations/mission-agent/replacement-bootstrap";
import {
  REPLACEMENT_CLAIM_PATH,
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  REPLACEMENT_DECISION_PATH,
  REPLACEMENT_INTENT_PATH,
  REPLACEMENT_STATUS_PATH,
  REPLACEMENT_FAILURE_PATH,
  REPLACEMENT_RECEIPT_PATH,
} from "../integrations/mission-agent/replacement-authorization-package";
import { ValidationFailedError } from "../lib/application-errors";
import { parseProtocolHeaders, safeSignatureEqual, sha256, signProtocolRequest } from "./protocol";

export const MAX_REPLACEMENT_CALLBACK_BYTES = 512 * 1024;

export async function authenticateReplacementBootstrapRequest(
  request: Request,
  path: string,
  options: { allowExpiredRecovery?: boolean } = {},
) {
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
    throw new ValidationFailedError("Unsupported replacement-bootstrap path");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REPLACEMENT_CALLBACK_BYTES)
    throw new ValidationFailedError("Replacement-bootstrap body exceeds limit");
  const headers = parseProtocolHeaders(request);
  if (headers.agentId !== NAMED_CANARY_ID || headers.protocolVersion !== REPLACEMENT_CREDENTIAL_PROTOCOL)
    throw new ValidationFailedError("Replacement-bootstrap credential scope is invalid");
  const timestamp = Date.parse(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000)
    throw new ValidationFailedError("Replacement-bootstrap timestamp is outside allowed skew");
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_REPLACEMENT_CALLBACK_BYTES || sha256(body) !== headers.bodyChecksum)
    throw new ValidationFailedError("Replacement-bootstrap body checksum is invalid");
  const recoveryPath = [
    REPLACEMENT_INTENT_PATH,
    REPLACEMENT_RECEIPT_PATH,
    REPLACEMENT_STATUS_PATH,
    REPLACEMENT_FAILURE_PATH,
  ].includes(path as never);
  const credential = await getRemoteAgentAuth(headers.agentId, headers.credentialId, {
    allowExpiredReplacementRecovery: options.allowExpiredRecovery === true && recoveryPath,
  });
  if (
    credential.agent_id !== NAMED_CANARY_ID ||
    credential.allowed_protocol_versions.length !== 1 ||
    credential.allowed_protocol_versions[0] !== REPLACEMENT_CREDENTIAL_PROTOCOL
  )
    throw new ValidationFailedError("Credential is not dedicated to replacement bootstrap");
  const expected = signProtocolRequest(credential.secret_verifier, {
    method: request.method,
    path,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    messageId: headers.messageId,
    protocolVersion: headers.protocolVersion,
    bodyChecksum: headers.bodyChecksum,
  });
  if (!safeSignatureEqual(expected, headers.signature))
    throw new ValidationFailedError("Replacement-bootstrap signature is invalid");
  return { headers, credential, body };
}
