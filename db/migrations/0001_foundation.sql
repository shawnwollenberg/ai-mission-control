CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE aggregate_heads (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, aggregate_type, aggregate_id)
);

CREATE TABLE events (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  event_schema_version integer NOT NULL CHECK (event_schema_version > 0),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  mission_id uuid,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system', 'scheduler')),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, aggregate_type, aggregate_id, aggregate_version)
);

CREATE INDEX events_workspace_position_idx ON events (workspace_id, position);
CREATE INDEX events_mission_position_idx ON events (workspace_id, mission_id, position) WHERE mission_id IS NOT NULL;
CREATE INDEX events_aggregate_idx ON events (workspace_id, aggregate_type, aggregate_id, aggregate_version);

CREATE TABLE commands (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  command_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  result_event_ids uuid[] NOT NULL DEFAULT '{}',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, command_id)
);

CREATE TABLE idempotency_records (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  result jsonb NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope, idempotency_key)
);
