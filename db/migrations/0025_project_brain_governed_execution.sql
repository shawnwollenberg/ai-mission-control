ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK(job_type IN(
  'project_events','process_outbox','rebuild_projection','detect_failed_jobs','simulate_task',
  'coordinate_mission','execute_codex','execute_action','deliver_remote_agent','deliver_remote_execution',
  'deliver_remote_decision','deliver_notification','retention_cleanup','project_brain_operation'
));

ALTER TABLE repositories
  ADD COLUMN project_brain_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE approval_projections
  ADD COLUMN consumed_by_operation_id uuid,
  ADD COLUMN consumed_action_hash text;

CREATE TABLE project_brain_operation_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  last_event_position bigint NOT NULL,
  repository_id uuid NOT NULL,
  mission_id uuid,
  execution_id uuid,
  agent_id uuid,
  operation text NOT NULL,
  location_mode text NOT NULL CHECK(location_mode IN('server','mission_agent')),
  status text NOT NULL CHECK(status IN('requested','authorized','denied','started','succeeded','failed','cancelled')),
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_fingerprint text NOT NULL,
  starting_sha text,
  ending_sha text,
  required_project_brain_version text NOT NULL,
  required_contract_version text NOT NULL,
  approval_id uuid,
  policy_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  worker_id text,
  failure_stage text,
  failure_cause text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE INDEX project_brain_operations_repository_idx
  ON project_brain_operation_projections(workspace_id,repository_id,created_at DESC);
CREATE INDEX project_brain_operations_execution_idx
  ON project_brain_operation_projections(workspace_id,execution_id) WHERE execution_id IS NOT NULL;

CREATE TABLE repository_project_brain_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  availability_state text NOT NULL DEFAULT 'unknown',
  compatibility_state text NOT NULL DEFAULT 'unknown',
  last_validation_status text,
  last_validated_sha text,
  project_brain_version text,
  contract_version text,
  schema_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_state_freshness text NOT NULL DEFAULT 'unknown',
  proposed_learning_count integer NOT NULL DEFAULT 0,
  confirmed_learning_count integer NOT NULL DEFAULT 0,
  stale_count integer NOT NULL DEFAULT 0,
  unresolved_contradiction_count integer NOT NULL DEFAULT 0,
  last_operation text,
  last_operation_status text,
  diagnostic_warning_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_refreshed_at timestamptz,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,repository_id)
);

CREATE TABLE mission_project_brain_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  context_preview_status text NOT NULL DEFAULT 'not_requested',
  final_context_artifact_id uuid,
  context_repository_path text,
  context_checksum text,
  context_schema_version text,
  contract_version text,
  starting_sha text,
  selected_source_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_bytes bigint,
  context_quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_bound_status text NOT NULL DEFAULT 'unbound',
  bound_execution_id uuid,
  assigned_agent_id uuid,
  agent_received_checksum text,
  agent_verified_checksum text,
  agent_verification_status text NOT NULL DEFAULT 'not_reported',
  bound_at timestamptz,
  verified_at timestamptz,
  closure_status text NOT NULL DEFAULT 'not_recorded',
  learning_proposal_status text NOT NULL DEFAULT 'not_proposed',
  evaluation_status text NOT NULL DEFAULT 'not_evaluated',
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,mission_id)
);
