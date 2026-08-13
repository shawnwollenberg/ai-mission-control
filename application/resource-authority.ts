import { canonicalHash } from "@/lib/canonical-json";
import { ValidationFailedError } from "@/lib/application-errors";
import { disposableArtifactApproval, runtimeTrustEvidence } from "@/lib/runtime-trust";

export const RESOURCE_AUTHORITY_POLICY_VERSION = "resource-authority-policy/1" as const;

export type ResourceAuthorityRequest = Readonly<{
  commandId: string;
  acceptanceRunId: string;
  candidateIdentitySha256: string;
  workspaceId: string;
  missionId: string | null;
  actorId: string;
  resourceType: "database" | "provider" | "network" | "artifact_store";
  resourceClassification: "disposable" | "local" | "production";
  operation: "connect" | "invoke" | "read" | "write";
  resourceIdentity: string;
  requestedAt: string;
}>;

export type ResourceAuthorityContactCounters = Readonly<{
  dnsResolutionAttempts: number;
  socketConnectionAttempts: number;
  databaseConnectionAttempts: number;
  providerInvocationCount: number;
  remoteHttpAttempts: number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;

export function evaluateResourceAuthority(request: ResourceAuthorityRequest) {
  if (
    !UUID.test(request.commandId) ||
    !UUID.test(request.acceptanceRunId) ||
    request.workspaceId !== request.acceptanceRunId ||
    (request.missionId !== null && !UUID.test(request.missionId)) ||
    !request.actorId ||
    !SHA.test(request.candidateIdentitySha256) ||
    !request.resourceIdentity ||
    request.resourceIdentity.length > 160 ||
    !Number.isFinite(Date.parse(request.requestedAt))
  )
    throw new ValidationFailedError("Resource authority request binding is invalid");

  const trust = runtimeTrustEvidence();
  const approvedCandidate = disposableArtifactApproval("0.8.0").artifact.sha256;
  if (request.candidateIdentitySha256 !== approvedCandidate)
    throw new ValidationFailedError("Resource authority candidate binding is invalid");
  const base = {
    schemaVersion: "resource-authority-evaluation/1",
    policyVersion: RESOURCE_AUTHORITY_POLICY_VERSION,
    commandId: request.commandId,
    acceptanceRunId: request.acceptanceRunId,
    candidateIdentitySha256: request.candidateIdentitySha256,
    workspaceId: request.workspaceId,
    missionId: request.missionId,
    actorId: request.actorId,
    resourceType: request.resourceType,
    resourceClassification: request.resourceClassification,
    operation: request.operation,
    resourceIdentity: request.resourceIdentity,
    runtimeMode: trust.runtimeMode,
    productionAuthority: trust.productionResourcesAllowed,
    evaluatedAt: new Date().toISOString(),
  } as const;
  const evaluationIdentity = canonicalHash(base);
  if (
    trust.runtimeMode === "disposable_acceptance" &&
    trust.productionResourcesAllowed === false &&
    request.resourceClassification === "production"
  )
    throw new ValidationFailedError("Production-classified resources are forbidden in disposable acceptance", {
      reason_code: "PRODUCTION_RESOURCE_FORBIDDEN",
      evaluation_identity: evaluationIdentity,
      policy_version: RESOURCE_AUTHORITY_POLICY_VERSION,
      command_id: request.commandId,
    });
  return { ...base, decision: "allowed" as const, evaluationIdentity };
}

export function observeProductionResourceRejection(input: {
  request: ResourceAuthorityRequest;
  counters: () => ResourceAuthorityContactCounters;
  durableStateIdentity: () => string;
}) {
  const before = input.counters();
  const durableStateBeforeSha256 = input.durableStateIdentity();
  try {
    evaluateResourceAuthority(input.request);
    throw new Error("Production resource authority evaluation unexpectedly allowed the request");
  } catch (error) {
    if (!(error instanceof ValidationFailedError)) throw error;
    const after = input.counters();
    return {
      requestedClassification: input.request.resourceClassification,
      localTargetRepresentation: input.request.resourceIdentity,
      preflightOperationIdentity: input.request.commandId,
      policyDecision: "rejected",
      actualTopLevelErrorCode: error.code,
      actualRejectionCode: error.details?.reason_code,
      authorityPolicyVersion: error.details?.policy_version,
      evaluationIdentity: error.details?.evaluation_identity,
      runtimeMode: "disposable_acceptance",
      productionAuthority: false,
      resourceType: input.request.resourceType,
      requestedOperation: input.request.operation,
      dnsResolutionAttemptsBefore: before.dnsResolutionAttempts,
      dnsResolutionAttemptsAfter: after.dnsResolutionAttempts,
      socketConnectionAttemptsBefore: before.socketConnectionAttempts,
      socketConnectionAttemptsAfter: after.socketConnectionAttempts,
      databaseConnectionAttemptsBefore: before.databaseConnectionAttempts,
      databaseConnectionAttemptsAfter: after.databaseConnectionAttempts,
      providerInvocationCountBefore: before.providerInvocationCount,
      providerInvocationCountAfter: after.providerInvocationCount,
      remoteHttpAttemptsBefore: before.remoteHttpAttempts,
      remoteHttpAttemptsAfter: after.remoteHttpAttempts,
      durableStateBeforeSha256,
      durableStateAfterSha256: input.durableStateIdentity(),
      productionEndpointContacted: false,
      terminalState: "rejected_before_access",
    } as const;
  }
}
