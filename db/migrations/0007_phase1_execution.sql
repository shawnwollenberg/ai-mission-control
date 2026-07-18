ALTER TABLE task_projections
  ADD COLUMN assigned_executor text,
  ADD COLUMN current_attempt integer NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
  ADD COLUMN progress_summary text,
  ADD COLUMN last_event_position bigint NOT NULL DEFAULT 0 CHECK (last_event_position >= 0);

ALTER TABLE task_dependencies
  ADD COLUMN created_event_id uuid;

ALTER TABLE mission_projections
  ADD COLUMN blocked_task_count integer NOT NULL DEFAULT 0 CHECK (blocked_task_count >= 0),
  ADD COLUMN ready_task_count integer NOT NULL DEFAULT 0 CHECK (ready_task_count >= 0),
  ADD COLUMN running_task_count integer NOT NULL DEFAULT 0 CHECK (running_task_count >= 0),
  ADD COLUMN waiting_approval_task_count integer NOT NULL DEFAULT 0 CHECK (waiting_approval_task_count >= 0),
  ADD COLUMN failed_task_count integer NOT NULL DEFAULT 0 CHECK (failed_task_count >= 0),
  ADD COLUMN cancelled_task_count integer NOT NULL DEFAULT 0 CHECK (cancelled_task_count >= 0),
  ADD COLUMN current_critical_blocker text,
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'simulated';

ALTER TABLE approval_projections
  ADD COLUMN supporting_evidence_summary text;

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'project_events', 'process_outbox', 'rebuild_projection', 'detect_failed_jobs',
  'simulate_task', 'coordinate_mission'
));

CREATE TABLE projection_rebuild_runs (
  rebuild_id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  projection text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  last_position bigint NOT NULL DEFAULT 0,
  event_count bigint NOT NULL DEFAULT 0,
  failure jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE legacy_import_quarantine (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  source_id text,
  reason text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
