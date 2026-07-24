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
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";
import { validateRemoteProjectBrainLease } from "@/application/remote-project-brain-assignments";
import { ValidationFailedError } from "@/lib/application-errors";

const path = "/api/agent-protocol/v1/project-brain/messages";
const maxBytes = 10 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const authenticated = await authenticateProtocolRequest(request, path, maxBytes);
    const message = validateEnvelope(JSON.parse(authenticated.body), {
      agentId: authenticated.headers.agentId,
      workspaceId: authenticated.credential.workspace_id,
      messageId: authenticated.headers.messageId,
    });
    if (!String(message.messageType).startsWith("RemoteProjectBrain"))
      throw new ValidationFailedError("Only remote Project Brain results are accepted on this endpoint");
    await validateRemoteProjectBrainLease({
      credential: authenticated.credential,
      operationId: String(message.payload.operationId ?? ""),
      assignmentId: request.headers.get("x-mc-assignment-id") ?? "",
      leaseOwner: request.headers.get("x-mc-lease-owner") ?? "",
      leaseToken: request.headers.get("x-mc-lease-token") ?? "",
    });
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
    console.error("Remote Project Brain result rejected", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown remote Project Brain result error",
    });
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "project_brain_result_rejected");
  }
}
