CREATE TABLE policy_definitions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL,
  policy_version text NOT NULL,
  name text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('workspace','repository','agent','environment','action')),
  scope_id text,
  priority integer NOT NULL DEFAULT 0,
  rules jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,policy_id,policy_version)
);

CREATE TABLE action_request_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_request_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  task_id uuid,
  execution_id uuid,
  agent_id uuid,
  repository_id uuid,
  aggregate_version integer NOT NULL,
  action_type text NOT NULL,
  target_resource text NOT NULL,
  parameters_summary jsonb NOT NULL,
  action_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested','evaluating','denied','waiting_for_approval','approved','executing','succeeded','failed','expired','cancelled')),
  policy_version text,
  policy_outcome text CHECK (policy_outcome IN ('allow','require_approval','deny')),
  policy_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_id uuid,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  result jsonb,
  failure_classification text,
  retry_disposition text,
  requested_at timestamptz NOT NULL,
  executed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,action_request_id),
  UNIQUE(workspace_id,idempotency_key)
);

ALTER TABLE approval_projections DROP CONSTRAINT approval_projections_status_check;
ALTER TABLE approval_projections ADD CONSTRAINT approval_projections_status_check CHECK (status IN ('pending','granted','denied','expired','cancelled','consumed'));
ALTER TABLE approval_projections
  ADD COLUMN action_request_id uuid,
  ADD COLUMN agent_id uuid,
  ADD COLUMN risk_level text,
  ADD COLUMN policy_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN policy_version_at_request text,
  ADD COLUMN policy_version_at_execution text,
  ADD COLUMN consumed_at timestamptz;

ALTER TABLE repositories
  ADD COLUMN protected_branches jsonb NOT NULL DEFAULT '["main","master"]'::jsonb,
  ADD COLUMN allowed_branch_prefixes jsonb NOT NULL DEFAULT '["codex/"]'::jsonb,
  ADD COLUMN allowed_remotes jsonb NOT NULL DEFAULT '["origin"]'::jsonb,
  ADD COLUMN pull_request_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN provider_type text NOT NULL DEFAULT 'local_fixture',
  ADD COLUMN provider_configuration_reference text,
  ADD COLUMN max_concurrent_executions integer NOT NULL DEFAULT 1,
  ADD COLUMN execution_budget jsonb NOT NULL DEFAULT '{"maxDurationSeconds":3600,"maxRetries":3,"maxCommands":50,"maxArtifactBytes":10485760,"maxLogBytes":1048576}'::jsonb;

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'project_events','process_outbox','rebuild_projection','detect_failed_jobs','simulate_task','coordinate_mission','execute_codex','execute_action'
));

CREATE INDEX action_request_status_idx ON action_request_projections(workspace_id,status,requested_at DESC);
CREATE INDEX approval_action_idx ON approval_projections(workspace_id,action_request_id);
