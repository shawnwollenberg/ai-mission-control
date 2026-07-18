ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_status_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_status_check CHECK (status IN ('pending_verification','active','expiring','revoked','expired'));
ALTER TABLE agent_credentials
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN overlap_ends_at timestamptz;
UPDATE agent_credentials SET verified_at=created_at WHERE status='active' AND verified_at IS NULL;

CREATE TABLE agent_resource_permissions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY(workspace_id,agent_id,resource_type,resource_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE protocol_security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid,
  reason_code text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX protocol_security_events_agent_time_idx ON protocol_security_events(workspace_id,agent_id,occurred_at DESC);

CREATE TABLE protocol_rate_limits (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  category text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK(request_count>0),
  PRIMARY KEY(workspace_id,agent_id,category,window_started_at)
);

ALTER TABLE approval_projections
  ADD COLUMN remote_decision_delivery_status text CHECK(remote_decision_delivery_status IN ('pending','delivered','acknowledged','failed')),
  ADD COLUMN remote_decision_message_id uuid,
  ADD COLUMN remote_decision_delivered_at timestamptz,
  ADD COLUMN remote_decision_acknowledged_at timestamptz;

ALTER TABLE task_projections ADD COLUMN required_resources jsonb NOT NULL DEFAULT '[]'::jsonb;
