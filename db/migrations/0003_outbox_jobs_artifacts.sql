CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE,
  topic text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (workspace_id, topic, idempotency_key)
);

CREATE INDEX outbox_claim_idx ON outbox (status, available_at, id) WHERE status IN ('pending', 'failed');

CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE,
  job_type text NOT NULL CHECK (job_type IN ('project_events', 'process_outbox', 'rebuild_projection', 'detect_failed_jobs')),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  correlation_id uuid,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, job_type, idempotency_key)
);

CREATE INDEX jobs_claim_idx ON jobs (status, available_at, id) WHERE status IN ('pending', 'failed');

CREATE TABLE dead_letters (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  error jsonb NOT NULL,
  attempt_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE TABLE projection_checkpoints (
  projector_name text NOT NULL,
  projector_version integer NOT NULL CHECK (projector_version > 0),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  last_position bigint NOT NULL DEFAULT 0 CHECK (last_position >= 0),
  status text NOT NULL CHECK (status IN ('idle', 'running', 'failed', 'complete')),
  last_error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (projector_name, projector_version, workspace_id)
);

CREATE TABLE artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  task_id uuid,
  execution_id uuid,
  kind text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_provider text NOT NULL,
  storage_key text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('live', 'validated_fallback', 'controlled', 'imported')),
  temporary boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, artifact_id),
  UNIQUE (workspace_id, storage_provider, storage_key)
);

CREATE TABLE webhook_deliveries (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  execution_id uuid,
  endpoint_reference text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  response_status integer,
  response_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, delivery_id),
  UNIQUE (workspace_id, idempotency_key)
);
