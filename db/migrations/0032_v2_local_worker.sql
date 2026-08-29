CREATE TABLE v2_worker_presence (
  worker_id text PRIMARY KEY,
  display_name text NOT NULL,
  session_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'AUTH_REQUIRED', 'DEGRADED')),
  architect_available boolean NOT NULL DEFAULT true,
  engineer_available boolean NOT NULL DEFAULT true,
  current_dispatch_id uuid,
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE v2_worker_dispatches (
  dispatch_id uuid PRIMARY KEY,
  project_id text NOT NULL,
  mission_id text NOT NULL,
  issue_number integer NOT NULL CHECK (issue_number > 0),
  mission_revision integer NOT NULL CHECK (mission_revision > 0),
  actor text NOT NULL CHECK (actor IN ('ARCHITECT', 'ENGINEER')),
  adapter text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  mission_digest text NOT NULL CHECK (mission_digest ~ '^[0-9a-f]{64}$'),
  packet jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'CLAIMED', 'COMPLETED', 'FAILED', 'STALE')),
  worker_id text,
  worker_session_id uuid,
  acknowledged_at timestamptz,
  result jsonb,
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  provider_thread_id text,
  failure_code text,
  resulting_github_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(project_id, issue_number, mission_id, mission_revision, actor)
);

CREATE INDEX v2_worker_dispatch_queue_idx
  ON v2_worker_dispatches(status, created_at)
  WHERE status IN ('QUEUED', 'CLAIMED');

