ALTER TABLE repositories
  ADD COLUMN identity_version text NOT NULL DEFAULT 'legacy-v1'
    CHECK (identity_version IN ('legacy-v1','stable-v2')),
  ADD COLUMN identity_migration_status text NOT NULL DEFAULT 'not_required'
    CHECK (identity_migration_status IN (
      'not_required','eligible','previewed','approved','awaiting_agent_activation',
      'agent_activated','completed','activation_failed','rollback_requested',
      'rollback_awaiting_agent','failed','rolled_back'
    )),
  ADD COLUMN identity_last_verified_at timestamptz;

CREATE TABLE repository_identities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  identity_version text NOT NULL CHECK (identity_version IN ('legacy-v1','stable-v2')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  canonical_remote_url text,
  repository_name text NOT NULL,
  selected_remote text,
  canonical_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  verified_at timestamptz,
  verification_source text,
  migration_status text NOT NULL,
  superseded_fingerprint text,
  migration_event_id uuid,
  PRIMARY KEY(workspace_id,repository_id,identity_version,fingerprint),
  FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,repository_id) ON DELETE CASCADE
);

INSERT INTO repository_identities(
  workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
  selected_remote,created_at,verification_source,migration_status)
SELECT workspace_id,repository_id,identity_version,repository_fingerprint,observed_remote_url,name,
  CASE WHEN observed_remote_url IS NULL THEN NULL ELSE 'origin' END,created_at,'legacy-registration','active'
FROM repositories WHERE repository_fingerprint IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE repository_identity_migrations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  migration_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN (
    'previewed','approved','awaiting_agent_activation','agent_activated','completed',
    'activation_failed','rollback_requested','rollback_awaiting_agent','failed','rolled_back'
  )),
  request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  legacy_fingerprint text NOT NULL CHECK(legacy_fingerprint ~ '^[a-f0-9]{64}$'),
  stable_fingerprint text NOT NULL CHECK(stable_fingerprint ~ '^[a-f0-9]{64}$'),
  canonical_remote_url text NOT NULL,
  repository_name text NOT NULL,
  registered_path text NOT NULL,
  current_head text NOT NULL,
  selected_remote text NOT NULL,
  permission_snapshot jsonb NOT NULL,
  project_brain_enabled boolean NOT NULL,
  legacy_created_at timestamptz NOT NULL,
  legacy_canonical_remote_url text,
  legacy_selected_remote text,
  legacy_verification_source text NOT NULL,
  legacy_verified_at timestamptz,
  aggregate_version integer NOT NULL,
  previewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by text,
  approved_at timestamptz,
  activation_request jsonb,
  activation_request_checksum text CHECK(activation_request_checksum IS NULL OR activation_request_checksum ~ '^[a-f0-9]{64}$'),
  activation_request_id uuid,
  activation_requested_at timestamptz,
  activation_expires_at timestamptz,
  activation_acknowledgement jsonb,
  activation_acknowledgement_checksum text CHECK(activation_acknowledgement_checksum IS NULL OR activation_acknowledgement_checksum ~ '^[a-f0-9]{64}$'),
  activation_acknowledged_at timestamptz,
  completed_at timestamptz,
  rolled_back_at timestamptz,
  last_event_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,migration_id),
  FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,repository_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX repository_identity_active_migration_idx
  ON repository_identity_migrations(workspace_id,repository_id)
  WHERE status IN ('previewed','approved');
