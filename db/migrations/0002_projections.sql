CREATE TABLE mission_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  name text NOT NULL,
  objective text NOT NULL,
  description text,
  domain text NOT NULL,
  priority text NOT NULL,
  risk_level text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'planned', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  requested_outcome text,
  success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  deadline timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, mission_id)
);

CREATE TABLE task_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  name text NOT NULL,
  instructions text NOT NULL,
  expected_output text,
  status text NOT NULL CHECK (status IN ('pending', 'blocked', 'ready', 'assigned', 'running', 'waiting_for_approval', 'paused', 'verifying', 'completed', 'failed', 'cancelled')),
  priority text NOT NULL,
  risk_level text NOT NULL,
  required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  assigned_agent_id uuid,
  maximum_attempts integer NOT NULL DEFAULT 1 CHECK (maximum_attempts > 0),
  timeout_seconds integer CHECK (timeout_seconds > 0),
  approval_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES mission_projections(workspace_id, mission_id) ON DELETE CASCADE
);

CREATE INDEX task_projections_mission_idx ON task_projections (workspace_id, mission_id, status);

CREATE TABLE task_dependencies (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task_projections(workspace_id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, depends_on_task_id) REFERENCES task_projections(workspace_id, task_id) ON DELETE CASCADE
);

CREATE TABLE agents (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  adapter_type text NOT NULL,
  runtime_reference text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  supported_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  trust_level text NOT NULL,
  status text NOT NULL,
  last_heartbeat_at timestamptz,
  concurrency_limit integer NOT NULL DEFAULT 1 CHECK (concurrency_limit > 0),
  configuration_reference text,
  credential_reference text,
  cost_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE execution_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  task_id uuid NOT NULL,
  agent_id uuid,
  aggregate_version integer NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('requested', 'accepted', 'running', 'waiting_for_approval', 'paused', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  completed_at timestamptz,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary text,
  error jsonb,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost numeric(18, 6),
  external_execution_id text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, execution_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task_projections(workspace_id, task_id) ON DELETE CASCADE
);

CREATE TABLE approval_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approval_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  task_id uuid,
  execution_id uuid,
  aggregate_version integer NOT NULL,
  approval_type text NOT NULL,
  requested_action jsonb NOT NULL,
  action_hash text NOT NULL,
  risk_explanation text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'granted', 'denied', 'expired')),
  decided_by text,
  decision_reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (workspace_id, approval_id)
);
