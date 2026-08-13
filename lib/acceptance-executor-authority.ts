export type ExecutorAuthorityBinding = Readonly<{
  assignmentId: string;
  executionId: string;
  attempt: number;
  agentId: string;
  leaseOwner: string;
  fencingToken: number;
  validationReceiptId: string;
  validationReceiptSha256: string;
  provenanceMessageId: string;
  providerAttemptId: string;
  diagnosticId: string;
}>;

type Queryable = {
  query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }>;
};

type AuthorityRow = {
  assignment_id: string;
  execution_id: string;
  assignment_attempt: number | string;
  assignment_agent_id: string;
  assignment_lease_owner: string | null;
  assignment_fencing_token: number | string;
  validation_receipt_id: string;
  receipt_attempt: number | string;
  receipt_agent_id: string;
  receipt_lease_owner: string;
  receipt_fencing_token: number | string;
  receipt_provider_id: string;
  receipt_model_id: string;
  receipt_capability_attestation_id: string;
  receipt_capability_attestation_hash: string;
  receipt_hash: string;
  execution_authority_presentation: unknown;
  execution_authority_presentation_sha256: string;
  provenance_message_id: string;
  diagnostic_provenance_message_id: string;
  provider_attempt_id: string;
  diagnostic_provider_id: string;
  diagnostic_requested_model_id: string;
  diagnostic_runtime_profile_id: string;
  diagnostic_runtime_profile_hash: string;
  diagnostic_id: string;
  diagnostic_assignment_id: string;
  diagnostic_attempt: number | string;
  diagnostic_agent_id: string;
  diagnostic_lease_owner: string;
  diagnostic_fencing_token: number | string;
};

const SHA = /^[a-f0-9]{64}$/;

export async function loadPersistedExecutorAuthorityBinding(
  database: Queryable,
  input: { workspaceId: string; executionId: string; assignmentId: string; agentId: string },
): Promise<ExecutorAuthorityBinding> {
  const row = (
    await database.query<AuthorityRow>(
      `SELECT p.assignment_id,p.execution_id,p.attempt assignment_attempt,p.agent_id assignment_agent_id,
         p.lease_owner assignment_lease_owner,p.fencing_token assignment_fencing_token,
         r.validation_receipt_id,r.execution_attempt receipt_attempt,r.agent_id receipt_agent_id,
         r.lease_owner receipt_lease_owner,r.fencing_token receipt_fencing_token,r.receipt_hash,
         r.provider_id receipt_provider_id,r.model_id receipt_model_id,
         r.capability_attestation_id receipt_capability_attestation_id,
         r.capability_attestation_hash receipt_capability_attestation_hash,
         r.execution_authority_presentation,r.execution_authority_presentation_sha256,
         r.provenance_message_id,d.provenance_message_id diagnostic_provenance_message_id,
         d.provider_attempt_id,d.diagnostic_id,d.provider_id diagnostic_provider_id,
         d.requested_model_id diagnostic_requested_model_id,d.runtime_profile_id diagnostic_runtime_profile_id,
         d.runtime_profile_hash diagnostic_runtime_profile_hash,
         d.assignment_id diagnostic_assignment_id,d.execution_attempt diagnostic_attempt,
         d.agent_id diagnostic_agent_id,d.lease_owner diagnostic_lease_owner,
         d.fencing_token diagnostic_fencing_token
       FROM pull_assignments p
       JOIN consensus_execution_validation_receipts r
         ON r.workspace_id=p.workspace_id AND r.execution_id=p.execution_id AND r.execution_attempt=p.attempt
       JOIN provider_runtime_diagnostics d
         ON d.workspace_id=r.workspace_id AND d.execution_id=r.execution_id
        AND d.execution_attempt=r.execution_attempt AND d.agent_id=r.agent_id
       WHERE p.workspace_id=$1 AND p.execution_id=$2 AND p.assignment_id=$3 AND p.agent_id=$4
       ORDER BY d.created_at DESC LIMIT 1`,
      [input.workspaceId, input.executionId, input.assignmentId, input.agentId],
    )
  ).rows[0];
  if (!row) throw new Error("Persisted executor authority binding is unavailable");
  const attempt = Number(row.assignment_attempt);
  const fencingToken = Number(row.assignment_fencing_token);
  const exactIdentity =
    row.assignment_id === input.assignmentId &&
    row.execution_id === input.executionId &&
    row.assignment_agent_id === input.agentId &&
    row.diagnostic_assignment_id === input.assignmentId &&
    row.receipt_agent_id === input.agentId &&
    row.diagnostic_agent_id === input.agentId;
  const exactAttempt =
    attempt > 0 && attempt === Number(row.receipt_attempt) && attempt === Number(row.diagnostic_attempt);
  const exactLease =
    Boolean(row.assignment_lease_owner) &&
    row.assignment_lease_owner === row.receipt_lease_owner &&
    row.assignment_lease_owner === row.diagnostic_lease_owner;
  const exactFence =
    Number.isSafeInteger(fencingToken) &&
    fencingToken > 0 &&
    fencingToken === Number(row.receipt_fencing_token) &&
    fencingToken === Number(row.diagnostic_fencing_token);
  const exactProvenance =
    Boolean(row.provenance_message_id) && row.provenance_message_id === row.diagnostic_provenance_message_id;
  const presentation = parseExecutionAuthorityPresentation(row.execution_authority_presentation);
  const exactPresentation =
    executionAuthorityPresentationIdentity(presentation) === row.execution_authority_presentation_sha256 &&
    presentation.assignmentId === row.assignment_id &&
    presentation.assignmentAttempt === attempt &&
    presentation.agentId === row.assignment_agent_id &&
    presentation.providerAttemptId === row.provider_attempt_id &&
    presentation.providerId === row.receipt_provider_id &&
    presentation.providerId === row.diagnostic_provider_id &&
    presentation.requestedModelId === row.receipt_model_id &&
    presentation.requestedModelId === row.diagnostic_requested_model_id &&
    presentation.runtimeProfileId === row.diagnostic_runtime_profile_id &&
    presentation.runtimeProfileHash === row.diagnostic_runtime_profile_hash &&
    presentation.capabilityAttestationId === row.receipt_capability_attestation_id &&
    presentation.capabilityAttestationHash === row.receipt_capability_attestation_hash &&
    presentation.leaseOwner === row.assignment_lease_owner &&
    presentation.fencingToken === fencingToken;
  if (
    !exactIdentity ||
    !exactAttempt ||
    !exactLease ||
    !exactFence ||
    !exactProvenance ||
    !exactPresentation ||
    !SHA.test(row.receipt_hash)
  )
    throw new Error("Persisted executor authority binding is inconsistent or incomplete");
  return {
    assignmentId: row.assignment_id,
    executionId: row.execution_id,
    attempt,
    agentId: row.assignment_agent_id,
    leaseOwner: row.assignment_lease_owner!,
    fencingToken,
    validationReceiptId: row.validation_receipt_id,
    validationReceiptSha256: row.receipt_hash,
    provenanceMessageId: row.provenance_message_id,
    providerAttemptId: row.provider_attempt_id,
    diagnosticId: row.diagnostic_id,
  };
}
import {
  executionAuthorityPresentationIdentity,
  parseExecutionAuthorityPresentation,
} from "../domain/execution-authority-presentation";
