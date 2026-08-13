import { getDatabasePool } from "@/lib/database";
import { canonicalHash } from "@/lib/canonical-json";
import { evaluateAgentEligibility } from "@/application/agent-eligibility";
import { parseCompleteRepositoryState, repositorySnapshotBytes } from "@/domain/repository-snapshot";
import { assertDisposableRepositoryAuthorityProjection } from "@/domain/repository-authority";
import {
  disposableApprovedAssignment,
  disposableArtifactApproval,
  runtimeTrustEvidence,
  type RuntimeTrustEvidence,
} from "@/lib/runtime-trust";
import type { AgentOperation, ModelCapabilityRole } from "@/domain/agent-provider";

export const ACCEPTANCE_SETUP_FAILURE = "ACCEPTANCE SETUP FAILURE" as const;
export class AcceptanceSetupFailure extends Error {
  readonly classification = ACCEPTANCE_SETUP_FAILURE;
  constructor(
    message: string,
    readonly evidence: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AcceptanceSetupFailure";
  }
}
type AssignmentExpectation = {
  role: "planner_a" | "planner_b" | "synthesizer" | "executor";
  agentId: string;
  provider: "codex" | "claude_code";
  model: string;
  missionRole: "planner" | "executor";
  modelRole: ModelCapabilityRole;
  operations: AgentOperation[];
  requiredCapabilities: string[];
  repositoryPermission: "read" | "isolated_worktree_write";
  requireProjectBrainContext?: boolean;
  requireRepositoryMutation?: boolean;
};
function fail(prerequisite: string, detail: string, evidence: Record<string, unknown>): never {
  throw new AcceptanceSetupFailure(`${ACCEPTANCE_SETUP_FAILURE}: ${prerequisite}`, {
    schemaVersion: "consensus-acceptance-preflight/1",
    classification: ACCEPTANCE_SETUP_FAILURE,
    failedPrerequisite: prerequisite,
    detail: detail.slice(0, 500),
    ...evidence,
  });
}
function readinessTrust(value: unknown): RuntimeTrustEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const trust = (value as Record<string, unknown>).runtimeTrust;
  return trust && typeof trust === "object" && !Array.isArray(trust) ? (trust as RuntimeTrustEvidence) : undefined;
}
export async function runDisposableAcceptancePreflight(input: {
  workspaceId: string;
  repositoryId: string;
  expectedArtifactSha256: string;
  readiness: unknown;
  localRepositoryState: unknown;
  packetVerification: unknown;
  assignments: AssignmentExpectation[];
  implementationReviewerDisabled: boolean;
}) {
  const observed: Record<string, unknown> = {
    schemaVersion: "consensus-acceptance-preflight/1",
    classification: "READY",
    checkedAt: new Date().toISOString(),
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
  };
  const expectedTrust = runtimeTrustEvidence();
  const packetApproval = disposableArtifactApproval("0.8.0");
  const readiness =
    input.readiness && typeof input.readiness === "object" && !Array.isArray(input.readiness)
      ? (input.readiness as Record<string, unknown>)
      : {};
  const reportedTrust = readinessTrust(readiness);
  observed.expectedRuntimeTrustSha256 = canonicalHash(expectedTrust);
  observed.reportedRuntimeTrustSha256 = reportedTrust ? canonicalHash(reportedTrust) : null;
  observed.readinessStatus = readiness.status ?? null;
  observed.readinessEnvironment = readiness.environment ?? null;
  observed.readinessLabel = readiness.label ?? null;
  observed.readinessFailed = readiness.failed ?? null;
  if (
    readiness.status !== "ready" ||
    readiness.environment !== "disposable_acceptance" ||
    readiness.label !== "DISPOSABLE ACCEPTANCE — NON-PRODUCTION" ||
    canonicalHash(reportedTrust) !== canonicalHash(expectedTrust)
  )
    fail("server_runtime_trust", "Readiness did not expose the exact disposable runtime/registry binding", observed);
  if (
    expectedTrust.runtimeMode !== "disposable_acceptance" ||
    !expectedTrust.disposable ||
    expectedTrust.productionResourcesAllowed ||
    !expectedTrust.registryPath ||
    !expectedTrust.registryContentHash ||
    !expectedTrust.databaseIdentity
  )
    fail(
      "server_production_isolation",
      "Disposable runtime trust is incomplete or permits production resources",
      observed,
    );
  const packetVerification =
    input.packetVerification && typeof input.packetVerification === "object" && !Array.isArray(input.packetVerification)
      ? (input.packetVerification as Record<string, unknown>)
      : {};
  const observedPacket =
    packetVerification.observed &&
    typeof packetVerification.observed === "object" &&
    !Array.isArray(packetVerification.observed)
      ? (packetVerification.observed as Record<string, unknown>)
      : {};
  const approvedPacket = packetApproval.artifact as unknown as Record<string, unknown>;
  const packetFields = [
    "sha256",
    "artifactMetadataSha256",
    "capabilityManifestSha256",
    "sourceCommit",
    "sourceTemplateSha256",
    "buildScriptSha256",
    "providerRequirementsFileSha256",
    "providerRequirementsCanonicalSha256",
    "providerProfilesFileSha256",
    "providerProfilesCanonicalSha256",
    "discoveryHarnessSha256",
    "realAcceptanceHarnessSha256",
    "artifactFixtureSha256",
    "migrationSha256",
    "rollbackSha256",
    "repositoryAuthorityMigrationSha256",
    "repositoryAuthorityRollbackSha256",
    "runtimeModeDefinitionFileSha256",
    "disposableRegistrySchemaSha256",
    "repositorySnapshotSchemaSha256",
    "repositoryAuthoritySchemaSha256",
    "acceptanceSourceManifestSha256",
    "acceptanceSourceManifestCanonicalSha256",
    "acceptanceSourceManifestSchemaSha256",
    "acceptanceContractFileSha256",
    "acceptanceContractCanonicalSha256",
    "acceptanceContractSchemaSha256",
    "acceptanceExecutableRegistryFileSha256",
    "acceptanceExecutableRegistryCanonicalSha256",
  ] as const;
  if (
    packetVerification.schemaVersion !== "disposable-acceptance-packet-verification/1" ||
    packetVerification.artifactVersion !== "0.8.0" ||
    packetVerification.registryContentHash !== packetApproval.evidence.registryContentHash ||
    canonicalHash(packetVerification.startupTrust) !== canonicalHash(expectedTrust) ||
    canonicalHash(packetVerification.approvedPacket) !== canonicalHash(packetApproval.artifact) ||
    packetFields.some((field) => observedPacket[field] !== approvedPacket[field]) ||
    canonicalHash(observedPacket.runtimeBindings) !== canonicalHash(packetApproval.artifact.runtimeBindings)
  )
    fail(
      "packet_and_runtime_approval",
      "Observed packet files, canonical catalogs, or named runtime bindings differ from the sole disposable registry entry",
      observed,
    );
  observed.server = {
    runtimeMode: expectedTrust.runtimeMode,
    registryPath: expectedTrust.registryPath,
    registryPathHash: expectedTrust.registryPathHash,
    registryContentHash: expectedTrust.registryContentHash,
    databaseIdentity: expectedTrust.databaseIdentity,
    productionResourcesAllowed: expectedTrust.productionResourcesAllowed,
    migrationsCurrent: true,
    readinessHealthy: true,
    packetAndRuntimeApproval: {
      artifactVersion: "0.8.0",
      packetMatched: true,
      runtimeBindingsMatched: true,
      observed: observedPacket,
    },
  };

  const localRepositoryState = parseCompleteRepositoryState(input.localRepositoryState);
  if (localRepositoryState.schemaVersion !== "complete_repository_state/3")
    fail("local_repository_state", "Acceptance requires complete_repository_state/3", observed);
  const repository = (
    await getDatabasePool().query<{
      repository_id: string;
      default_branch: string;
      observed_commit: string | null;
      repository_fingerprint: string | null;
      identity_version: string;
      identity_migration_status: string;
      read_allowed: boolean;
      write_allowed: boolean;
      commit_allowed: boolean;
      push_allowed: boolean;
      pull_request_allowed: boolean;
      merge_allowed: boolean;
      deployment_allowed: boolean;
      isolated_worktree_write_allowed: boolean;
      mission_agent_local_commit_allowed: boolean;
      provider_direct_commit_allowed: boolean;
      publication_allowed: boolean;
      infrastructure_mutation_allowed: boolean;
      repository_authority_hash: string | null;
      repository_authority: unknown;
      authority_receipts: number;
      authority_command_id: string | null;
      repository_state: unknown;
      repository_snapshot_hash: string | null;
      repository_snapshot_artifact_id: string | null;
      snapshot_checksum: string | null;
      snapshot_size: number | null;
      snapshot_manifest: unknown;
      authenticated_registrations: number;
    }>(
      `SELECT r.repository_id,r.default_branch,r.observed_commit,r.repository_fingerprint,r.identity_version,
        r.identity_migration_status,r.read_allowed,r.write_allowed,r.commit_allowed,r.push_allowed,r.pull_request_allowed,
        r.deployment_allowed,r.isolated_worktree_write_allowed,r.mission_agent_local_commit_allowed,
        r.provider_direct_commit_allowed,r.merge_allowed,r.publication_allowed,r.infrastructure_mutation_allowed,
        r.repository_authority_hash,r.repository_authority,
        (SELECT count(*)::int FROM repository_authority_receipts authority_receipt
          WHERE authority_receipt.workspace_id=r.workspace_id AND authority_receipt.repository_id=r.repository_id
            AND authority_receipt.authority_hash=r.repository_authority_hash) authority_receipts,
        (SELECT authority_receipt.command_id::text FROM repository_authority_receipts authority_receipt
          WHERE authority_receipt.workspace_id=r.workspace_id AND authority_receipt.repository_id=r.repository_id
            AND authority_receipt.authority_hash=r.repository_authority_hash
          ORDER BY authority_receipt.created_at DESC LIMIT 1) authority_command_id,
        r.repository_state,r.repository_snapshot_hash,r.repository_snapshot_artifact_id,
        snapshot.checksum_sha256 snapshot_checksum,snapshot.byte_size snapshot_size,
        snapshot.manifest snapshot_manifest,
        (SELECT count(*)::int FROM events e
          JOIN agent_protocol_receipts receipt
            ON receipt.workspace_id=e.workspace_id
           AND receipt.agent_id=(e.payload->>'agentId')::uuid
           AND receipt.message_id=(e.payload->'registrationAuthority'->>'messageId')::uuid
           AND receipt.body_checksum=e.payload->'registrationAuthority'->>'bodyChecksum'
          JOIN agent_credentials credential
            ON credential.workspace_id=e.workspace_id
           AND credential.agent_id=receipt.agent_id
           AND credential.credential_id=(e.payload->'registrationAuthority'->>'credentialId')::uuid
          WHERE e.workspace_id=r.workspace_id AND e.aggregate_type='repository' AND e.aggregate_id=r.repository_id
            AND e.event_type IN('repository.registered','repository.registration_refreshed')
            AND e.payload->'registrationAuthority'->>'schemaVersion'='authenticated-repository-registration/1'
            AND COALESCE(e.payload->'registrationAuthority'->>'authorizationHash','') ~ '^[a-f0-9]{64}$'
            AND receipt.acknowledgement->>'status'='completed'
            AND receipt.acknowledgement->>'messageId'=receipt.message_id::text
            AND credential.status IN('active','expiring')
        ) authenticated_registrations
       FROM repositories r
       LEFT JOIN repository_snapshot_artifacts snapshot
         ON snapshot.workspace_id=r.workspace_id AND snapshot.snapshot_artifact_id=r.repository_snapshot_artifact_id
       WHERE r.workspace_id=$1 AND r.repository_id=$2 AND r.disabled_at IS NULL`,
      [input.workspaceId, input.repositoryId],
    )
  ).rows[0];
  if (!repository) fail("repository_registration", "Registered repository is absent", observed);
  let durableState;
  try {
    durableState = parseCompleteRepositoryState(repository.repository_state, {
      commit: repository.observed_commit ?? undefined,
      branch: repository.default_branch,
    });
  } catch (error) {
    fail("repository_state", error instanceof Error ? error.message : "Repository state is invalid", observed);
  }
  if (
    durableState.schemaVersion !== "complete_repository_state/3" ||
    !repository.repository_snapshot_hash ||
    !repository.repository_snapshot_artifact_id ||
    repository.repository_snapshot_hash !== durableState.snapshotHash ||
    repository.snapshot_checksum !== durableState.snapshotHash ||
    Number(repository.snapshot_size) !== repositorySnapshotBytes(durableState).byteLength ||
    canonicalHash(repository.snapshot_manifest) !== canonicalHash(durableState) ||
    canonicalHash(localRepositoryState) !== canonicalHash(durableState) ||
    durableState.cleanWorktree !== true ||
    durableState.trackedStatusEmpty !== true ||
    durableState.trackedContentMatchesIndex !== true ||
    durableState.untrackedCount !== 0 ||
    durableState.relevantIgnoredCount !== 0 ||
    repository.authenticated_registrations < 2 ||
    repository.identity_version !== "stable-v2" ||
    !["not_required", "completed"].includes(repository.identity_migration_status)
  )
    fail(
      "repository_snapshot_binding",
      "Durable repository state, snapshot artifact, or authority is incomplete",
      observed,
    );
  const trackedPaths = new Set(durableState.trackedManifest.map((entry) => entry.path));
  const projectBrainFiles = [
    ".project-brain/README.md",
    ".project-brain/current-state.md",
    ".project-brain/known-issues.md",
    ".project-brain/project-profile.yaml",
  ];
  if (projectBrainFiles.some((path) => !trackedPaths.has(path)))
    fail("project_brain_context", "Project Brain context files are not bound into the registered snapshot", observed);
  try {
    assertDisposableRepositoryAuthorityProjection({
      authority: repository.repository_authority,
      authorityHash: repository.repository_authority_hash,
      authorityCommandId: repository.authority_command_id,
      authorityReceiptCount: repository.authority_receipts,
      readAllowed: repository.read_allowed,
      writeAllowed: repository.write_allowed,
      commitAllowed: repository.commit_allowed,
      isolatedWorktreeWriteAllowed: repository.isolated_worktree_write_allowed,
      missionAgentLocalCommitAllowed: repository.mission_agent_local_commit_allowed,
      providerDirectCommitAllowed: repository.provider_direct_commit_allowed,
      pushAllowed: repository.push_allowed,
      pullRequestAllowed: repository.pull_request_allowed,
      mergeAllowed: repository.merge_allowed,
      publicationAllowed: repository.publication_allowed,
      deploymentAllowed: repository.deployment_allowed,
      infrastructureMutationAllowed: repository.infrastructure_mutation_allowed,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Repository authority is invalid";
    fail(
      detail.startsWith("Direct commit, push") ? "repository_prohibited_authority" : "repository_authorization",
      detail,
      observed,
    );
  }
  observed.repository = {
    identityVersion: repository.identity_version,
    fingerprint: repository.repository_fingerprint,
    branch: repository.default_branch,
    baseCommit: repository.observed_commit,
    stateSchemaVersion: durableState.schemaVersion,
    stateHash: durableState.snapshotHash,
    snapshotArtifactId: repository.repository_snapshot_artifact_id,
    snapshotHash: repository.snapshot_checksum,
    authenticatedRegistrations: repository.authenticated_registrations,
    projectBrainContextBound: true,
    repositoryAuthorityHash: repository.repository_authority_hash,
    genericWriteAllowed: false,
    genericCommitAllowed: false,
    isolatedWorktreeWriteAllowed: true,
    missionAgentLocalCommitAllowed: true,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    authenticatedAuthorityReceipts: repository.authority_receipts,
  };

  if (!input.implementationReviewerDisabled)
    fail("implementation_reviewer", "Implementation reviewer must be disabled for this acceptance", observed);
  const agentRows = (
    await getDatabasePool().query<{
      agent_id: string;
      provider_id: string;
      agent_version: string | null;
      status: string;
      mission_agent_checksum_status: string;
      mission_agent_artifact_checksum: string | null;
      capability_attestation_id: string | null;
      capability_attestation_hash: string | null;
      capability_attestation_expires_at: Date | null;
      provider_runtime_requirements_satisfied: boolean;
      mission_agent_runtime_mode: string | null;
      mission_agent_acceptance_registry_hash: string | null;
      authenticated_credential_events: number;
      authenticated_heartbeat_current: boolean;
    }>(
      `SELECT agent_id,provider_id,agent_version,status,mission_agent_checksum_status,
        mission_agent_artifact_checksum,capability_attestation_id,capability_attestation_hash,
        capability_attestation_expires_at,provider_runtime_requirements_satisfied,
        mission_agent_runtime_mode,mission_agent_acceptance_registry_hash,
        (SELECT count(*)::int FROM events e WHERE e.workspace_id=agents.workspace_id
          AND e.aggregate_type='agent' AND e.aggregate_id=agents.agent_id
          AND e.event_type='agent.credential_verified' AND e.actor_type='agent'
          AND e.actor_id=agents.agent_id::text) authenticated_credential_events,
        EXISTS(SELECT 1 FROM agent_heartbeats heartbeat JOIN agent_credentials credential
          ON credential.workspace_id=heartbeat.workspace_id AND credential.agent_id=heartbeat.agent_id
         AND credential.credential_id=heartbeat.credential_id AND credential.status IN('active','expiring')
          WHERE heartbeat.workspace_id=agents.workspace_id AND heartbeat.agent_id=agents.agent_id
            AND heartbeat.received_at > now()-interval '90 seconds') authenticated_heartbeat_current
       FROM agents WHERE workspace_id=$1 AND agent_id=ANY($2::uuid[]) ORDER BY provider_id`,
      [input.workspaceId, input.assignments.map((assignment) => assignment.agentId)],
    )
  ).rows;
  observed.agentRuntimeEligibilityRows = agentRows.map((agent) => ({
    ...agent,
    capability_attestation_expires_at: agent.capability_attestation_expires_at?.toISOString() ?? null,
  }));
  const distinctAgentIds = new Set(input.assignments.map((assignment) => assignment.agentId));
  if (agentRows.length !== distinctAgentIds.size || distinctAgentIds.size !== 2)
    fail("distinct_authenticated_agents", "Exactly two distinct registered agents are required", observed);
  for (const agent of agentRows)
    if (
      agent.status !== "active" ||
      agent.agent_version !== "0.8.0" ||
      agent.mission_agent_checksum_status !== "verified" ||
      agent.mission_agent_artifact_checksum !== input.expectedArtifactSha256 ||
      !agent.capability_attestation_id ||
      !agent.capability_attestation_hash ||
      !agent.capability_attestation_expires_at ||
      agent.capability_attestation_expires_at.getTime() <= Date.now() ||
      !agent.provider_runtime_requirements_satisfied ||
      agent.mission_agent_runtime_mode !== "disposable_acceptance" ||
      agent.mission_agent_acceptance_registry_hash !== expectedTrust.registryContentHash ||
      agent.authenticated_credential_events < 1 ||
      !agent.authenticated_heartbeat_current
    )
      fail("agent_artifact_and_runtime_eligibility", `Agent ${agent.agent_id} is not exactly approved`, observed);

  const assignmentEvidence = [];
  for (const assignment of input.assignments) {
    const approved = disposableApprovedAssignment(assignment.role);
    if (!approved || approved.provider !== assignment.provider || approved.model !== assignment.model)
      fail("assignment_allowlist", `${assignment.role} does not match the exact registry assignment`, observed);
    const agent = agentRows.find((row) => row.agent_id === assignment.agentId);
    if (agent?.provider_id !== assignment.provider)
      fail("assignment_provider", `${assignment.role} provider does not match the registered agent`, observed);
    const eligibility = await evaluateAgentEligibility({
      workspaceId: input.workspaceId,
      agentId: assignment.agentId,
      domain: "software_delivery",
      requiredCapabilities: assignment.requiredCapabilities,
      requiredResources: [
        {
          resourceType: "repository",
          resourceId: input.repositoryId,
          permission: assignment.repositoryPermission,
        },
      ],
      protocolVersion: "1.0",
      requiredMissionRole: assignment.missionRole,
      requiredOperations: assignment.operations,
      requiredModel: assignment.model,
      requiredModelRole: assignment.modelRole,
      requireStructuredOutput: true,
      requireProjectBrainContext: assignment.requireProjectBrainContext,
      requireRepositoryMutation: assignment.requireRepositoryMutation,
      requireVerifiedMissionAgentArtifact: true,
    });
    if (!eligibility.eligible || eligibility.providerId !== assignment.provider || !eligibility.providerRuntimeProfile)
      fail(
        "assignment_eligibility",
        `${assignment.role} failed exact eligibility: ${eligibility.reasons.join("; ")}`,
        observed,
      );
    assignmentEvidence.push({
      role: assignment.role,
      agentId: assignment.agentId,
      provider: assignment.provider,
      model: assignment.model,
      eligibility: "approved/eligible",
      capabilityAttestationId: eligibility.capabilityAttestationId,
      capabilityAttestationHash: eligibility.capabilityAttestationHash,
      runtimeProfileId: eligibility.providerRuntimeProfile.profileId,
      runtimeBindingHash: eligibility.providerRuntimeProfile.runtimeBindingHash,
      repositoryPermission: assignment.repositoryPermission,
      pushAllowed: false,
      fallback: "disabled",
    });
  }
  observed.agents = agentRows.map((agent) => ({
    agentId: agent.agent_id,
    provider: agent.provider_id,
    agentVersion: agent.agent_version,
    artifactStatus: agent.mission_agent_checksum_status,
    artifactSha256: agent.mission_agent_artifact_checksum,
    capabilityAttestationId: agent.capability_attestation_id,
    capabilityAttestationHash: agent.capability_attestation_hash,
    runtimeMode: agent.mission_agent_runtime_mode,
    registryHash: agent.mission_agent_acceptance_registry_hash,
    authenticatedCredentialEvents: agent.authenticated_credential_events,
    authenticatedHeartbeatCurrent: agent.authenticated_heartbeat_current,
  }));
  observed.assignments = assignmentEvidence;
  observed.implementationReviewer = "disabled";
  observed.noFallback = true;
  return observed;
}
