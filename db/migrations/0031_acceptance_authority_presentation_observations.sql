CREATE TABLE acceptance_active_provider_attempts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  assignment_attempt integer NOT NULL CHECK(assignment_attempt > 0),
  provider_attempt_id text NOT NULL,
  agent_id uuid NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  runtime_profile_id text NOT NULL,
  runtime_profile_hash text NOT NULL CHECK(runtime_profile_hash ~ '^[0-9a-f]{64}$'),
  provenance_message_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, execution_id, assignment_attempt, provider_attempt_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE CASCADE
);

CREATE TABLE acceptance_authority_presentation_observations (
  observation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  message_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  requirement_id text NOT NULL,
  scenario_id text NOT NULL,
  mutation_kind text NOT NULL,
  baseline_presentation jsonb NOT NULL,
  attempted_presentation jsonb NOT NULL,
  baseline_presentation_sha256 text NOT NULL CHECK (baseline_presentation_sha256 ~ '^[0-9a-f]{64}$'),
  attempted_presentation_sha256 text NOT NULL CHECK (attempted_presentation_sha256 ~ '^[0-9a-f]{64}$'),
  route_identity text NOT NULL,
  assignment_status text NOT NULL,
  lease_receipt_id uuid NOT NULL,
  lease_token_fingerprint text NOT NULL CHECK (lease_token_fingerprint ~ '^[0-9a-f]{64}$'),
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  fencing_token bigint NOT NULL,
  baseline_valid boolean NOT NULL,
  top_level_code text NOT NULL,
  reason_code text NOT NULL,
  durable_state_before_sha256 text NOT NULL CHECK (durable_state_before_sha256 ~ '^[0-9a-f]{64}$'),
  durable_state_after_sha256 text NOT NULL CHECK (durable_state_after_sha256 ~ '^[0-9a-f]{64}$'),
  durable_counts_before jsonb NOT NULL,
  durable_counts_after jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, message_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE CASCADE
);

CREATE FUNCTION prevent_acceptance_authority_presentation_observation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'acceptance authority presentation observations are immutable';
END $$;
CREATE TRIGGER acceptance_authority_presentation_observation_immutable
  BEFORE UPDATE OR DELETE ON acceptance_authority_presentation_observations FOR EACH ROW
  EXECUTE FUNCTION prevent_acceptance_authority_presentation_observation_mutation();

CREATE TRIGGER acceptance_active_provider_attempt_immutable
  BEFORE UPDATE OR DELETE ON acceptance_active_provider_attempts FOR EACH ROW
  EXECUTE FUNCTION prevent_acceptance_authority_presentation_observation_mutation();

CREATE TABLE acceptance_authority_local_state_observations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  requirement_id text NOT NULL,
  rejection_message_id uuid NOT NULL,
  provenance_message_id uuid NOT NULL,
  repository_state_before_sha256 text NOT NULL CHECK(repository_state_before_sha256 ~ '^[0-9a-f]{64}$'),
  repository_state_after_sha256 text NOT NULL CHECK(repository_state_after_sha256 ~ '^[0-9a-f]{64}$'),
  repository_head_before text NOT NULL CHECK(repository_head_before ~ '^[0-9a-f]{40,64}$'),
  repository_head_after text NOT NULL CHECK(repository_head_after ~ '^[0-9a-f]{40,64}$'),
  repository_status_before_sha256 text NOT NULL CHECK(repository_status_before_sha256 ~ '^[0-9a-f]{64}$'),
  repository_status_after_sha256 text NOT NULL CHECK(repository_status_after_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,execution_id,requirement_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,rejection_message_id)
    REFERENCES acceptance_authority_presentation_observations(workspace_id,message_id) ON DELETE CASCADE
);

CREATE TRIGGER acceptance_authority_local_state_observation_immutable
  BEFORE UPDATE OR DELETE ON acceptance_authority_local_state_observations FOR EACH ROW
  EXECUTE FUNCTION prevent_acceptance_authority_presentation_observation_mutation();
