ALTER TABLE schedule_projections
  ADD COLUMN paused boolean NOT NULL DEFAULT false,
  ADD COLUMN maximum_queued_runs integer NOT NULL DEFAULT 1 CHECK(maximum_queued_runs BETWEEN 0 AND 10),
  ADD COLUMN maximum_recovery_runs integer NOT NULL DEFAULT 3 CHECK(maximum_recovery_runs BETWEEN 1 AND 100),
  ADD COLUMN skip_warning_threshold integer NOT NULL DEFAULT 3 CHECK(skip_warning_threshold > 0),
  ADD COLUMN consecutive_skips integer NOT NULL DEFAULT 0,
  ADD COLUMN total_created integer NOT NULL DEFAULT 0,
  ADD COLUMN total_skipped integer NOT NULL DEFAULT 0,
  ADD COLUMN total_queued integer NOT NULL DEFAULT 0;

ALTER TABLE schedule_run_projections DROP CONSTRAINT schedule_run_projections_status_check;
ALTER TABLE schedule_run_projections ADD CONSTRAINT schedule_run_projections_status_check
  CHECK(status IN('due','created','queued','skipped','delayed','failed'));
ALTER TABLE schedule_run_projections
  ADD COLUMN trigger_type text NOT NULL DEFAULT 'scheduled' CHECK(trigger_type IN('scheduled','manual','recovery')),
  ADD COLUMN actual_created_at timestamptz,
  ADD COLUMN concurrency_decision text,
  ADD COLUMN missed_run_decision text,
  ADD COLUMN coalesced_run_count integer NOT NULL DEFAULT 0,
  ADD COLUMN usage_cost numeric,
  ADD COLUMN usage_currency text;

ALTER TABLE notification_projections DROP CONSTRAINT notification_projections_severity_check;
ALTER TABLE notification_projections ADD CONSTRAINT notification_projections_severity_check
  CHECK(severity IN('info','warning','high','critical'));

CREATE TABLE notification_preferences (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  in_app_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT false,
  outbound_enabled boolean NOT NULL DEFAULT false,
  delivery_mode text NOT NULL DEFAULT 'immediate' CHECK(delivery_mode IN('immediate','digest')),
  minimum_severity text NOT NULL DEFAULT 'info' CHECK(minimum_severity IN('info','warning','high','critical')),
  categories text[] NOT NULL DEFAULT ARRAY['approvals','mission_outcomes','failures','agent_status','worker_status','schedules','budgets','security','git_publication','defi_analysis'],
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text NOT NULL DEFAULT 'UTC',
  daily_digest_time time NOT NULL DEFAULT '09:00',
  high_severity_override boolean NOT NULL DEFAULT true,
  email_destination_ref text,
  outbound_destination_ref text,
  aggregate_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_event_position bigint NOT NULL DEFAULT 0
);

CREATE TABLE notification_deliveries (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  category text NOT NULL,
  severity text NOT NULL CHECK(severity IN('info','warning','high','critical')),
  channel text NOT NULL CHECK(channel IN('email','outbound')),
  destination_ref text NOT NULL,
  status text NOT NULL CHECK(status IN('pending','delivering','delivered','retrying','failed','suppressed','digest_pending')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  delivered_at timestamptz,
  last_error jsonb,
  idempotency_key text NOT NULL,
  safe_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,delivery_id),
  UNIQUE(workspace_id,idempotency_key)
);
CREATE INDEX notification_delivery_claim ON notification_deliveries(status,available_at) WHERE status IN('pending','retrying');

CREATE TABLE usage_records (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_record_id uuid NOT NULL,
  mission_id uuid, task_id uuid, execution_id uuid, agent_id uuid, schedule_id uuid, template_id uuid,
  template_version integer, provider text NOT NULL, runtime text, model text, metric_type text NOT NULL,
  quantity numeric, unit text, cost_amount numeric, currency text,
  cost_confidence text NOT NULL CHECK(cost_confidence IN('exact','provider_reported','estimated','unknown')),
  source text NOT NULL, repository text, domain text,
  recorded_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,usage_record_id)
);
CREATE INDEX usage_rollup_dimensions ON usage_records(workspace_id,recorded_at,mission_id,schedule_id,agent_id,template_id);

CREATE TABLE budget_policies (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  budget_policy_id uuid NOT NULL,
  resource_type text NOT NULL CHECK(resource_type IN('mission','schedule','agent_daily','workspace_daily','workspace_monthly')),
  resource_id text,
  currency text NOT NULL DEFAULT 'USD', warning_amount numeric NOT NULL, hard_limit_amount numeric NOT NULL,
  unknown_cost_behavior text NOT NULL DEFAULT 'require_approval' CHECK(unknown_cost_behavior IN('advisory','require_approval','trusted_runtime')),
  enabled boolean NOT NULL DEFAULT true, policy_version integer NOT NULL DEFAULT 1,
  aggregate_version integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,budget_policy_id)
);
CREATE TABLE budget_decisions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  budget_decision_id uuid NOT NULL, budget_policy_id uuid NOT NULL, mission_id uuid, execution_id uuid,
  decision text NOT NULL CHECK(decision IN('allow','warn','deny','approval_required')),
  known_cost numeric, unknown_cost_count integer NOT NULL DEFAULT 0, reason text NOT NULL,
  created_at timestamptz NOT NULL, last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,budget_decision_id)
);

CREATE TABLE worker_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  worker_id text NOT NULL, worker_type text NOT NULL, version text, host_id text,
  started_at timestamptz NOT NULL, last_heartbeat timestamptz NOT NULL, heartbeat_interval_seconds integer NOT NULL DEFAULT 15,
  current_job_count integer NOT NULL DEFAULT 0, current_execution_ids uuid[] NOT NULL DEFAULT '{}',
  jobs_completed integer NOT NULL DEFAULT 0, jobs_failed integer NOT NULL DEFAULT 0,
  shutdown_requested boolean NOT NULL DEFAULT false, last_graceful_shutdown timestamptz,
  readiness jsonb NOT NULL DEFAULT '{}', aggregate_version integer NOT NULL, last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,worker_id)
);

ALTER TABLE dead_letters ADD COLUMN reviewed_at timestamptz;
ALTER TABLE dead_letters ADD COLUMN reviewed_by text;
ALTER TABLE dead_letters ADD COLUMN cancelled_at timestamptz;
ALTER TABLE dead_letters ADD COLUMN recovery_command_id uuid;

CREATE TABLE saved_view_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  saved_view_id uuid NOT NULL, name text NOT NULL, filters jsonb NOT NULL, is_default boolean NOT NULL DEFAULT false,
  system_key text, aggregate_version integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  deleted_at timestamptz, last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,saved_view_id), UNIQUE(workspace_id,system_key)
);

CREATE TABLE anomaly_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  anomaly_id uuid NOT NULL, anomaly_type text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
  severity text NOT NULL CHECK(severity IN('warning','high','critical')), status text NOT NULL CHECK(status IN('open','resolved','reviewed')),
  summary text NOT NULL, evidence jsonb NOT NULL, detected_at timestamptz NOT NULL, resolved_at timestamptz,
  aggregate_version integer NOT NULL, last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,anomaly_id)
);

CREATE TABLE retention_runs (
  retention_run_id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  policy jsonb NOT NULL, deleted_counts jsonb NOT NULL, status text NOT NULL CHECK(status IN('running','complete','failed')),
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, error jsonb
);

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK(job_type IN(
  'project_events','process_outbox','rebuild_projection','detect_failed_jobs','simulate_task','coordinate_mission',
  'execute_codex','execute_action','deliver_remote_agent','deliver_remote_execution','deliver_remote_decision','deliver_notification','retention_cleanup'
));
