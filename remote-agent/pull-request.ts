import { authenticateProtocolRequest } from "@/remote-agent/authenticate";
import { validateEnvelope, type InboundMessageType } from "@/remote-agent/protocol";
import { enforceProtocolRateLimit } from "@/remote-agent/security";
import { reserveProtocolMessage } from "@/application/remote-agent-messages";
import { ValidationFailedError } from "@/lib/application-errors";

export async function authenticatePullRequest(
  request: Request,
  expectedPath: string,
  expectedType: InboundMessageType,
  category: "pull" | "lease" | "repository",
) {
  const authenticated = await authenticateProtocolRequest(request, expectedPath);
  const message = validateEnvelope(JSON.parse(authenticated.body), {
    agentId: authenticated.headers.agentId,
    workspaceId: authenticated.credential.workspace_id,
    messageId: authenticated.headers.messageId,
  });
  if (message.messageType !== expectedType) throw new ValidationFailedError(`Expected ${expectedType}`);
  await enforceProtocolRateLimit(authenticated.credential.workspace_id, message.agentId, category);
  const receipt = await reserveProtocolMessage({
    credential: authenticated.credential,
    message,
    nonce: authenticated.headers.nonce,
    checksum: authenticated.headers.bodyChecksum,
  });
  return { ...authenticated, message, receipt };
}
