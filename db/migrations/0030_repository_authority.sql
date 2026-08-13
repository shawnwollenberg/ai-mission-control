ALTER TABLE repositories
  ADD COLUMN authority_schema_version text NOT NULL DEFAULT 'legacy_repository_permissions/1',
  ADD COLUMN isolated_worktree_write_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN mission_agent_local_commit_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN provider_direct_commit_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN publication_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN infrastructure_mutation_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN repository_authority jsonb,
  ADD COLUMN repository_authority_hash text
    CHECK(repository_authority_hash IS NULL OR repository_authority_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT repositories_provider_direct_commit_denied CHECK(provider_direct_commit_allowed=false);

UPDATE repositories SET
  isolated_worktree_write_allowed=write_allowed,
  mission_agent_local_commit_allowed=commit_allowed,
  publication_allowed=(push_allowed OR pull_request_allowed);

ALTER TABLE mission_projections
  ADD COLUMN repository_authority_hash text
    CHECK(repository_authority_hash IS NULL OR repository_authority_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE consensus_plan_projections
  ADD COLUMN repository_authority_hash text
    CHECK(repository_authority_hash IS NULL OR repository_authority_hash ~ '^[0-9a-f]{64}$');

CREATE TABLE repository_authority_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  authority_event_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  previous_authority_hash text CHECK(previous_authority_hash IS NULL OR previous_authority_hash ~ '^[0-9a-f]{64}$'),
  authority_hash text NOT NULL CHECK(authority_hash ~ '^[0-9a-f]{64}$'),
  authority jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,receipt_id),
  UNIQUE(workspace_id,command_id),
  FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,repository_id)
);

CREATE FUNCTION prevent_repository_authority_receipt_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'repository authority receipts are immutable';
END $$;
CREATE TRIGGER repository_authority_receipts_immutable
BEFORE UPDATE ON repository_authority_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_repository_authority_receipt_update();

CREATE FUNCTION enforce_bound_repository_authority_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.repository_authority_hash IS NOT NULL
    AND NEW.repository_authority_hash IS NOT DISTINCT FROM OLD.repository_authority_hash
    AND (
      NEW.allowed_agent_ids IS DISTINCT FROM OLD.allowed_agent_ids OR
      NEW.read_allowed IS DISTINCT FROM OLD.read_allowed OR
      NEW.write_allowed IS DISTINCT FROM OLD.write_allowed OR
      NEW.commit_allowed IS DISTINCT FROM OLD.commit_allowed OR
      NEW.isolated_worktree_write_allowed IS DISTINCT FROM OLD.isolated_worktree_write_allowed OR
      NEW.mission_agent_local_commit_allowed IS DISTINCT FROM OLD.mission_agent_local_commit_allowed OR
      NEW.provider_direct_commit_allowed IS DISTINCT FROM OLD.provider_direct_commit_allowed OR
      NEW.push_allowed IS DISTINCT FROM OLD.push_allowed OR
      NEW.pull_request_allowed IS DISTINCT FROM OLD.pull_request_allowed OR
      NEW.merge_allowed IS DISTINCT FROM OLD.merge_allowed OR
      NEW.publication_allowed IS DISTINCT FROM OLD.publication_allowed OR
      NEW.deployment_allowed IS DISTINCT FROM OLD.deployment_allowed OR
      NEW.infrastructure_mutation_allowed IS DISTINCT FROM OLD.infrastructure_mutation_allowed OR
      NEW.validation_commands IS DISTINCT FROM OLD.validation_commands OR
      NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
    )
  THEN
    RAISE EXCEPTION 'bound repository authority fields require a new authenticated authority binding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repositories_bound_authority_guard
BEFORE UPDATE ON repositories
FOR EACH ROW EXECUTE FUNCTION enforce_bound_repository_authority_update();

CREATE FUNCTION enforce_bound_repository_permission_update() RETURNS trigger
LANGUAGE plpgsql AS $$ DECLARE
  resource text := COALESCE(NEW.resource_id,OLD.resource_id);
  authority_workspace uuid := COALESCE(NEW.workspace_id,OLD.workspace_id);
  bound_hash text;
BEGIN
  IF COALESCE(NEW.resource_type,OLD.resource_type) <> 'repository' OR resource !~ '^[0-9a-f-]{36}$' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT repository_authority_hash INTO bound_hash FROM repositories
    WHERE workspace_id=authority_workspace AND repository_id=resource::uuid;
  IF bound_hash IS NOT NULL
    AND current_setting('mission_control.repository_authority_binding',true) IS DISTINCT FROM bound_hash
    AND (
      TG_OP <> 'UPDATE' OR
      NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
      NEW.agent_id IS DISTINCT FROM OLD.agent_id OR
      NEW.resource_type IS DISTINCT FROM OLD.resource_type OR
      NEW.resource_id IS DISTINCT FROM OLD.resource_id OR
      NEW.permissions IS DISTINCT FROM OLD.permissions OR
      NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    )
  THEN
    RAISE EXCEPTION 'bound repository resource permissions require a new authenticated authority binding';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER agent_resource_permissions_bound_authority_guard
BEFORE INSERT OR UPDATE OR DELETE ON agent_resource_permissions
FOR EACH ROW EXECUTE FUNCTION enforce_bound_repository_permission_update();
