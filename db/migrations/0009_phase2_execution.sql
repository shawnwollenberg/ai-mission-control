ALTER TABLE agents
  ADD COLUMN disabled_at timestamptz,
  ADD CONSTRAINT agents_adapter_check CHECK (adapter_type IN ('mock', 'codex')),
  ADD CONSTRAINT agents_status_check CHECK (status IN ('active', 'degraded', 'offline', 'disabled'));

CREATE TABLE repositories (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  name text NOT NULL,
  local_path text NOT NULL,
  clone_source text,
  default_branch text NOT NULL,
  allowed_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  read_allowed boolean NOT NULL DEFAULT true,
  write_allowed boolean NOT NULL DEFAULT false,
  commit_allowed boolean NOT NULL DEFAULT false,
  push_allowed boolean NOT NULL DEFAULT false,
  merge_allowed boolean NOT NULL DEFAULT false,
  deployment_allowed boolean NOT NULL DEFAULT false,
  validation_commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  PRIMARY KEY (workspace_id, repository_id),
  UNIQUE (workspace_id, local_path)
);

ALTER TABLE execution_projections DROP CONSTRAINT execution_projections_status_check;
ALTER TABLE execution_projections ADD CONSTRAINT execution_projections_status_check CHECK (status IN (
  'requested', 'accepted', 'preparing', 'running', 'waiting_for_approval', 'paused', 'verifying',
  'succeeded', 'failed', 'timed_out', 'cancelled'
));
ALTER TABLE execution_projections
  ADD COLUMN repository_id uuid,
  ADD COLUMN adapter_type text NOT NULL DEFAULT 'mock' CHECK (adapter_type IN ('mock', 'codex')),
  ADD COLUMN worker_id text,
  ADD COLUMN stage text,
  ADD COLUMN progress_summary text,
  ADD COLUMN failure_classification text,
  ADD COLUMN retry_disposition text,
  ADD COLUMN branch_name text,
  ADD COLUMN worktree_path text,
  ADD COLUMN commit_id text,
  ADD COLUMN cancellation_requested_at timestamptz,
  ADD COLUMN timeout_at timestamptz,
  ADD COLUMN last_event_position bigint NOT NULL DEFAULT 0;

CREATE TABLE execution_heartbeats (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  worker_id text NOT NULL,
  stage text NOT NULL,
  command_summary text,
  progress_percent integer CHECK (progress_percent BETWEEN 0 AND 100),
  progress_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, execution_id),
  FOREIGN KEY (workspace_id, execution_id) REFERENCES execution_projections(workspace_id, execution_id) ON DELETE CASCADE
);

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'project_events', 'process_outbox', 'rebuild_projection', 'detect_failed_jobs',
  'simulate_task', 'coordinate_mission', 'execute_codex'
));

CREATE INDEX execution_agent_active_idx ON execution_projections(workspace_id,agent_id,status);
CREATE INDEX execution_task_idx ON execution_projections(workspace_id,task_id,created_at DESC);
CREATE INDEX artifacts_execution_idx ON artifacts(workspace_id,execution_id,created_at);
