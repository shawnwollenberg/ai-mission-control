import { ValidationFailedError } from "@/lib/application-errors";
import { getRemoteAgentAuth } from "@/application/remote-agent-registry";
import { parseProtocolHeaders, safeSignatureEqual, sha256, signProtocolRequest } from "@/remote-agent/protocol";

export const MAX_CALLBACK_BYTES = 256 * 1024;
export async function authenticateProtocolRequest(request: Request, path: string) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_CALLBACK_BYTES) throw new ValidationFailedError("Protocol body exceeds limit");
  const headers = parseProtocolHeaders(request);
  if (headers.protocolVersion !== "1.0") throw new ValidationFailedError("Unsupported protocol version");
  const timestamp = Date.parse(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000)
    throw new ValidationFailedError("Protocol timestamp is outside the allowed clock skew");
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_CALLBACK_BYTES || sha256(body) !== headers.bodyChecksum)
    throw new ValidationFailedError("Protocol body checksum is invalid");
  const credential = await getRemoteAgentAuth(headers.agentId, headers.credentialId);
  if (!credential.allowed_protocol_versions.includes(headers.protocolVersion))
    throw new ValidationFailedError("Credential does not allow this protocol version");
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
    throw new ValidationFailedError("Protocol signature is invalid");
  return { headers, credential, body };
}
