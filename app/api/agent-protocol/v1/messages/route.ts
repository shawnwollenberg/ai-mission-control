import { NextResponse } from "next/server";
import { apiErrorResponse, structuralApplicationErrorResponse } from "@/lib/http-errors";
import { authenticateProtocolRequest } from "@/remote-agent/authenticate";
import { validateEnvelope } from "@/remote-agent/protocol";
import {
  completeProtocolMessage,
  acquireProtocolMessageFence,
  processRemoteMessage,
  releaseProtocolMessage,
  reserveProtocolMessage,
  validateExecutionAuthorityPresentation,
} from "@/application/remote-agent-messages";
import {
  auditProtocolSecurityFailure,
  enforceProtocolRateLimit,
  rateCategory,
  securityReason,
} from "@/remote-agent/security";
import { acquireExecutionLeaseFence } from "@/application/pull-assignments";
import { validateRemoteProjectBrainLease } from "@/application/remote-project-brain-assignments";
import { ConcurrencyConflictError } from "@/lib/application-errors";
import {
  captureActivePresentationState,
  activeProviderAttemptId,
  activePresentationAcceptanceEnabled,
  recordActivePresentationRejection,
} from "@/application/acceptance-authority-presentation-observations";
import type { ProtocolEnvelope } from "@/remote-agent/protocol";

const path = "/api/agent-protocol/v1/messages";
const agentStatusMaxAttempts = 16;

async function processAuthenticatedMessage(
  message: Parameters<typeof processRemoteMessage>[0],
  credential: Parameters<typeof processRemoteMessage>[1],
) {
  if (!["AgentHeartbeat", "AgentCapabilitiesReported"].includes(message.messageType))
    return processRemoteMessage(message, credential);
  for (let attempt = 0; attempt < agentStatusMaxAttempts; attempt += 1) {
    try {
      return await processRemoteMessage(message, credential);
    } catch (error) {
      if (!(error instanceof ConcurrencyConflictError) || attempt + 1 === agentStatusMaxAttempts) throw error;
    }
  }
  throw new ConcurrencyConflictError({ agentId: message.agentId, messageType: message.messageType });
}

export async function POST(request: Request) {
  let releaseExecutionFence: (() => Promise<void>) | undefined;
  let releaseMessageFence: (() => Promise<void>) | undefined;
  let activeScenario:
    | {
        message: ProtocolEnvelope;
        workspaceId: string;
        agentId: string;
        baselineValid: boolean;
        stateBefore: Awaited<ReturnType<typeof captureActivePresentationState>>;
      }
    | undefined;
  try {
    const authenticated = await authenticateProtocolRequest(request, path);
    const message = validateEnvelope(JSON.parse(authenticated.body), {
      agentId: authenticated.headers.agentId,
      workspaceId: authenticated.credential.workspace_id,
      messageId: authenticated.headers.messageId,
      sentAt: authenticated.headers.timestamp,
    });
    releaseMessageFence = await acquireProtocolMessageFence(authenticated.credential, message.messageId);
    if (
      message.executionId &&
      !String(message.messageType).startsWith("RemoteProjectBrain") &&
      authenticated.credential.delivery_mode === "pull"
    )
      releaseExecutionFence = await acquireExecutionLeaseFence({
        credential: authenticated.credential,
        executionId: message.executionId,
        assignmentId: request.headers.get("x-mc-assignment-id") ?? "",
        leaseOwner: request.headers.get("x-mc-lease-owner") ?? "",
        leaseToken: request.headers.get("x-mc-lease-token") ?? "",
        fencingToken: Number(request.headers.get("x-mc-fencing-token") ?? ""),
      });
    const scenario = message.payload.acceptanceAuthorityPresentationScenario as Record<string, unknown> | undefined;
    if (scenario && activePresentationAcceptanceEnabled()) {
      const assignmentId = request.headers.get("x-mc-assignment-id") ?? "";
      const stateBefore = await captureActivePresentationState(authenticated.credential.workspace_id, assignmentId);
      const persistedProviderAttemptId = await activeProviderAttemptId(
        authenticated.credential.workspace_id,
        String(message.executionId),
        assignmentId,
      );
      if (!persistedProviderAttemptId) throw new Error("Active provider-attempt authority is unavailable");
      await validateExecutionAuthorityPresentation(
        { ...message, payload: { ...message.payload, executionAuthorityPresentation: scenario.baselinePresentation } },
        authenticated.credential,
        undefined,
        persistedProviderAttemptId,
      );
      activeScenario = {
        message,
        workspaceId: authenticated.credential.workspace_id,
        agentId: authenticated.credential.agent_id,
        baselineValid: true,
        stateBefore,
      };
      await validateExecutionAuthorityPresentation(
        message,
        authenticated.credential,
        undefined,
        persistedProviderAttemptId,
      );
      throw new Error("Active authority mutation scenario unexpectedly passed presentation validation");
    }
    if (
      String(message.messageType).startsWith("RemoteProjectBrain") &&
      authenticated.credential.delivery_mode === "pull"
    )
      await validateRemoteProjectBrainLease({
        credential: authenticated.credential,
        operationId: String(message.payload.operationId ?? ""),
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
      const result = await processAuthenticatedMessage(message, authenticated.credential);
      const acknowledgement = { protocolVersion: "1.0", messageId: message.messageId, received: true, result };
      await completeProtocolMessage(authenticated.credential, message.messageId, acknowledgement);
      return NextResponse.json(acknowledgement, { status: 202 });
    } catch (error) {
      await releaseProtocolMessage(authenticated.credential, message.messageId);
      throw error;
    }
  } catch (error) {
    let responseError = error;
    let recordedScenarioError:
      | {
          code: Parameters<typeof structuralApplicationErrorResponse>[0]["code"];
          message: string;
          details?: Record<string, unknown>;
        }
      | undefined;
    if (activeScenario) {
      const recordedApplicationError = await recordActivePresentationRejection({ ...activeScenario, error }).catch(
        () => undefined,
      );
      if (recordedApplicationError) {
        recordedScenarioError = {
          code: recordedApplicationError.code,
          message: recordedApplicationError.message,
          details: {
            ...recordedApplicationError.details,
            acceptance_scenario_baseline_valid: true,
            acceptance_scenario_rejection_recorded: true,
          },
        };
        responseError = recordedScenarioError;
      }
    }
    await auditProtocolSecurityFailure(request, securityReason(responseError)).catch(() => undefined);
    if (recordedScenarioError) return structuralApplicationErrorResponse(recordedScenarioError);
    return apiErrorResponse(responseError, "agent_protocol_message_rejected");
  } finally {
    await releaseExecutionFence?.();
    await releaseMessageFence?.();
  }
}
