CREATE TABLE mission_template_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  aggregate_version integer NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  domain text NOT NULL,
  status text NOT NULL CHECK(status IN('draft','published','deprecated')),
  default_objective text NOT NULL,
  input_schema jsonb NOT NULL DEFAULT '{}',
  task_definitions jsonb NOT NULL DEFAULT '[]',
  dependencies jsonb NOT NULL DEFAULT '[]',
  defaults jsonb NOT NULL DEFAULT '{}',
  artifact_expectations jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz,
  deprecated_at timestamptz,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,template_id,version)
);
CREATE UNIQUE INDEX mission_template_one_draft ON mission_template_projections(workspace_id,template_id) WHERE status='draft';

ALTER TABLE mission_projections ADD COLUMN template_id uuid;
ALTER TABLE mission_projections ADD COLUMN template_version integer;
ALTER TABLE mission_projections ADD COLUMN resolved_inputs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE mission_projections ADD COLUMN resolved_task_plan jsonb NOT NULL DEFAULT '[]';
ALTER TABLE mission_projections ADD COLUMN origin_schedule_id uuid;
ALTER TABLE mission_projections ADD COLUMN intended_run_at timestamptz;

CREATE TABLE schedule_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  name text NOT NULL,
  template_id uuid NOT NULL,
  template_version integer NOT NULL,
  inputs jsonb NOT NULL,
  timezone text NOT NULL,
  schedule_rule jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  start_at timestamptz NOT NULL,
  end_at timestamptz,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  concurrency_policy text NOT NULL CHECK(concurrency_policy IN('skip_if_running','queue_next','allow_parallel')),
  missed_run_policy text NOT NULL CHECK(missed_run_policy IN('skip','run_once_on_recovery','run_all_with_limit')),
  maximum_active_runs integer NOT NULL DEFAULT 1 CHECK(maximum_active_runs > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,schedule_id)
);
CREATE INDEX schedule_due_idx ON schedule_projections(enabled,next_run_at) WHERE deleted_at IS NULL;

CREATE TABLE schedule_run_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_run_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version integer NOT NULL,
  intended_run_at timestamptz NOT NULL,
  mission_id uuid,
  status text NOT NULL CHECK(status IN('due','created','skipped','delayed','failed')),
  reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,schedule_run_id),
  UNIQUE(workspace_id,schedule_id,intended_run_at,template_version)
);

CREATE TABLE notification_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  category text NOT NULL,
  severity text NOT NULL CHECK(severity IN('info','warning','critical')),
  title text NOT NULL,
  summary text NOT NULL,
  mission_id uuid,
  schedule_id uuid,
  approval_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,notification_id),
  UNIQUE(workspace_id,source_event_id,category)
);
