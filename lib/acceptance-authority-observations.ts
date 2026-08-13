export const AUTHORITY_OBSERVATION_DEFINITIONS = [
  ["authority.changed_executable_rejected", "executable_identity", "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED"],
  ["authority.changed_runtime_profile_rejected", "runtime_profile", "ASSIGNMENT_RUNTIME_PROFILE_CHANGED"],
  [
    "authority.changed_authentication_binding_rejected",
    "authentication_binding",
    "ASSIGNMENT_AUTHENTICATION_BINDING_CHANGED",
  ],
  [
    "authority.changed_repository_authority_rejected",
    "repository_authority",
    "ASSIGNMENT_REPOSITORY_AUTHORITY_CHANGED",
  ],
  [
    "authority.expired_capability_attestation_rejected",
    "capability_attestation_expiry",
    "CAPABILITY_ATTESTATION_EXPIRED",
  ],
  ["authority.stale_lease_rejected", "lease_sequence", "ASSIGNMENT_LEASE_STALE"],
  ["authority.stale_fencing_token_rejected", "fencing_token", "ASSIGNMENT_FENCING_TOKEN_STALE"],
  ["authority.lease_loss_rejects_output", "lease_loss_output", "ASSIGNMENT_LEASE_LOST"],
  ["authority.delayed_provider_output_rejected", "delayed_provider_output", "DELAYED_PROVIDER_OUTPUT_REJECTED"],
  ["authority.conflicting_receipt_rejected", "conflicting_receipt", "CONFLICTING_RECEIPT_REJECTED"],
  [
    "authority.cancelled_assignment_claim_rejected",
    "cancelled_assignment_claim",
    "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
  ],
] as const;
