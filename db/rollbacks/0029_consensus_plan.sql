-- Destructive schema rollback for migration 0029.
-- Run only after disabling consensus mission creation, draining active turns,
-- exporting required planning evidence, and rolling the application back.
BEGIN;

ALTER TABLE agent_protocol_receipts
  DROP CONSTRAINT IF EXISTS agent_protocol_receipt_v2_structure_check;
DROP FUNCTION IF EXISTS agent_protocol_receipt_v2_is_valid(jsonb);

DROP TABLE IF EXISTS provider_runtime_diagnostics;
DROP FUNCTION IF EXISTS prevent_provider_runtime_diagnostic_update();
DROP TABLE IF EXISTS consensus_execution_validation_receipts;
DROP FUNCTION IF EXISTS prevent_consensus_validation_receipt_update();
DROP TABLE IF EXISTS consensus_objections;
DROP TABLE IF EXISTS consensus_artifacts;
DROP FUNCTION IF EXISTS prevent_consensus_artifact_update();
DROP TABLE IF EXISTS consensus_turns;
DROP TABLE IF EXISTS consensus_participant_assignments;
DROP TABLE IF EXISTS consensus_plan_projections;

ALTER TABLE usage_records
  DROP COLUMN IF EXISTS participant_assignment_id,
  DROP COLUMN IF EXISTS assignment_role,
  DROP COLUMN IF EXISTS planning_phase,
  DROP COLUMN IF EXISTS execution_attempt;

DROP INDEX IF EXISTS one_child_implementation_per_consensus;
ALTER TABLE mission_projections
  DROP CONSTRAINT IF EXISTS mission_projection_approved_plan_fk,
  DROP CONSTRAINT IF EXISTS mission_projection_repository_fk,
  DROP COLUMN IF EXISTS approved_plan_hash,
  DROP COLUMN IF EXISTS approved_plan_artifact_id,
  DROP COLUMN IF EXISTS parent_consensus_mission_id,
  DROP COLUMN IF EXISTS repository_snapshot,
  DROP COLUMN IF EXISTS base_commit,
  DROP COLUMN IF EXISTS base_branch,
  DROP COLUMN IF EXISTS repository_id,
  DROP COLUMN IF EXISTS mission_type;

ALTER TABLE pull_assignments
  DROP COLUMN IF EXISTS output_fence_reason,
  DROP COLUMN IF EXISTS output_fenced_at,
  DROP COLUMN IF EXISTS lease_token_fingerprint,
  DROP COLUMN IF EXISTS lease_receipt_id,
  DROP COLUMN IF EXISTS fencing_token;

ALTER TABLE repositories
  DROP CONSTRAINT IF EXISTS repository_snapshot_artifact_fk,
  DROP COLUMN IF EXISTS repository_snapshot_artifact_id,
  DROP COLUMN IF EXISTS repository_snapshot_hash,
  DROP COLUMN IF EXISTS repository_state;
DROP TABLE IF EXISTS repository_snapshot_artifacts;
DROP FUNCTION IF EXISTS prevent_repository_snapshot_artifact_update();

ALTER TABLE agents
  DROP COLUMN IF EXISTS mission_agent_disposable_packet,
  DROP COLUMN IF EXISTS mission_agent_acceptance_registry_hash,
  DROP COLUMN IF EXISTS mission_agent_acceptance_registry_path_hash,
  DROP COLUMN IF EXISTS mission_agent_acceptance_registry_path,
  DROP COLUMN IF EXISTS mission_agent_trust_authority,
  DROP COLUMN IF EXISTS mission_agent_runtime_mode,
  DROP CONSTRAINT IF EXISTS agents_capability_attestation_fk;
DROP TABLE IF EXISTS agent_model_capability_attestations;

ALTER TABLE agents
  DROP COLUMN IF EXISTS repository_mutation,
  DROP COLUMN IF EXISTS project_brain_context,
  DROP COLUMN IF EXISTS structured_output,
  DROP COLUMN IF EXISTS supported_models,
  DROP COLUMN IF EXISTS model_capabilities,
  DROP COLUMN IF EXISTS capability_attestation_id,
  DROP COLUMN IF EXISTS capability_attestation_hash,
  DROP COLUMN IF EXISTS capability_attestation_version,
  DROP COLUMN IF EXISTS capability_source,
  DROP COLUMN IF EXISTS capability_attested_at,
  DROP COLUMN IF EXISTS capability_attestation_expires_at,
  DROP COLUMN IF EXISTS provider_credentials_available,
  DROP COLUMN IF EXISTS provider_runtime_requirements_satisfied,
  DROP COLUMN IF EXISTS provider_runtime_status,
  DROP COLUMN IF EXISTS provider_runtime_profiles,
  DROP COLUMN IF EXISTS provider_runtime_requirements_hash,
  DROP COLUMN IF EXISTS provider_runtime_requirements_id,
  DROP COLUMN IF EXISTS supported_operations,
  DROP COLUMN IF EXISTS supported_mission_roles,
  DROP COLUMN IF EXISTS agent_version,
  DROP COLUMN IF EXISTS provider_id;

DELETE FROM schema_migrations WHERE name='0029_consensus_plan.sql';

COMMIT;
