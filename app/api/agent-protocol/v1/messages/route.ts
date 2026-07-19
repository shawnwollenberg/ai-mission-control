import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticateProtocolRequest } from "@/remote-agent/authenticate";
import { validateEnvelope } from "@/remote-agent/protocol";
import {
  completeProtocolMessage,
  processRemoteMessage,
  releaseProtocolMessage,
  reserveProtocolMessage,
} from "@/application/remote-agent-messages";
import {
  auditProtocolSecurityFailure,
  enforceProtocolRateLimit,
  rateCategory,
  securityReason,
} from "@/remote-agent/security";
import { validateExecutionLease } from "@/application/pull-assignments";

const path = "/api/agent-protocol/v1/messages";
export async function POST(request: Request) {
  try {
    const authenticated = await authenticateProtocolRequest(request, path);
    const message = validateEnvelope(JSON.parse(authenticated.body), {
      agentId: authenticated.headers.agentId,
      workspaceId: authenticated.credential.workspace_id,
      messageId: authenticated.headers.messageId,
    });
    if (message.executionId && authenticated.credential.delivery_mode === "pull")
      await validateExecutionLease({
        credential: authenticated.credential,
        executionId: message.executionId,
        assignmentId: request.headers.get("x-mc-assignment-id") ?? "",
        leaseOwner: request.headers.get("x-mc-lease-owner") ?? "",
        leaseToken: request.headers.get("x-mc-lease-token") ?? "",
      });
    await enforceProtocolRateLimit(authenticated.credential.workspace_id, message.agentId, rateCategory(message));
    const receipt = await reserveProtocolMessage({
      credential: authenticated.credential,
      message,
      nonce: authenticated.headers.nonce,
      checksum: authenticated.headers.bodyChecksum,
    });
    if (receipt.duplicate)
      return NextResponse.json({
        protocolVersion: "1.0",
        messageId: message.messageId,
        duplicate: true,
        result: receipt.acknowledgement,
      });
    try {
      const result = await processRemoteMessage(message, authenticated.credential);
      const acknowledgement = { protocolVersion: "1.0", messageId: message.messageId, received: true, result };
      await completeProtocolMessage(authenticated.credential, message.messageId, acknowledgement);
      return NextResponse.json(acknowledgement, { status: 202 });
    } catch (error) {
      await releaseProtocolMessage(authenticated.credential, message.messageId);
      throw error;
    }
  } catch (error) {
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "agent_protocol_message_rejected");
  }
}
