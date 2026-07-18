ALTER TABLE agents DROP CONSTRAINT agents_adapter_check;
ALTER TABLE agents ADD CONSTRAINT agents_adapter_check CHECK (adapter_type IN ('mock', 'codex', 'remote_http'));
ALTER TABLE agents
  ADD COLUMN endpoint text,
  ADD COLUMN protocol_versions jsonb NOT NULL DEFAULT '["1.0"]'::jsonb,
  ADD COLUMN allowed_callback_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN credential_status text NOT NULL DEFAULT 'not_configured' CHECK (credential_status IN ('not_configured','active','rotating','revoked')),
  ADD COLUMN credential_rotated_at timestamptz,
  ADD COLUMN last_execution_heartbeat_at timestamptz;

ALTER TABLE execution_projections DROP CONSTRAINT execution_projections_adapter_type_check;
ALTER TABLE execution_projections ADD CONSTRAINT execution_projections_adapter_type_check CHECK (adapter_type IN ('mock', 'codex', 'remote_http'));

CREATE TABLE agent_credentials (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  secret_verifier text NOT NULL CHECK (secret_verifier ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('active','revoked','expired')),
  allowed_protocol_versions jsonb NOT NULL DEFAULT '["1.0"]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  PRIMARY KEY (workspace_id, credential_id),
  UNIQUE (workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, agent_id) ON DELETE CASCADE
);

CREATE TABLE agent_protocol_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  message_id uuid NOT NULL,
  nonce text NOT NULL,
  body_checksum text NOT NULL CHECK (body_checksum ~ '^[0-9a-f]{64}$'),
  acknowledgement jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, message_id),
  UNIQUE (workspace_id, agent_id, nonce)
);
CREATE INDEX agent_protocol_receipts_expiry_idx ON agent_protocol_receipts(expires_at);

CREATE TABLE agent_heartbeats (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  protocol_version text NOT NULL,
  received_at timestamptz NOT NULL,
  reported_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, agent_id) ON DELETE CASCADE
);

ALTER TABLE webhook_deliveries
  ADD COLUMN message_id uuid,
  ADD COLUMN agent_id uuid,
  ADD COLUMN message_type text,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error_class text;

CREATE UNIQUE INDEX webhook_delivery_message_idx ON webhook_deliveries(workspace_id,message_id) WHERE message_id IS NOT NULL;

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'project_events', 'process_outbox', 'rebuild_projection', 'detect_failed_jobs',
  'simulate_task', 'coordinate_mission', 'execute_codex', 'execute_action', 'deliver_remote_agent'
));
