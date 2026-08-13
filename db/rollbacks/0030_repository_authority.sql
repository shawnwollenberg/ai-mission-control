BEGIN;
DROP TRIGGER IF EXISTS agent_resource_permissions_bound_authority_guard ON agent_resource_permissions;
DROP FUNCTION IF EXISTS enforce_bound_repository_permission_update();
DROP TRIGGER IF EXISTS repositories_bound_authority_guard ON repositories;
DROP FUNCTION IF EXISTS enforce_bound_repository_authority_update();
DROP TRIGGER IF EXISTS repository_authority_receipts_immutable ON repository_authority_receipts;
DROP FUNCTION IF EXISTS prevent_repository_authority_receipt_update();
DROP TABLE IF EXISTS repository_authority_receipts;
ALTER TABLE consensus_plan_projections DROP COLUMN IF EXISTS repository_authority_hash;
ALTER TABLE mission_projections DROP COLUMN IF EXISTS repository_authority_hash;
ALTER TABLE repositories
  DROP CONSTRAINT IF EXISTS repositories_provider_direct_commit_denied,
  DROP COLUMN IF EXISTS repository_authority_hash,
  DROP COLUMN IF EXISTS repository_authority,
  DROP COLUMN IF EXISTS infrastructure_mutation_allowed,
  DROP COLUMN IF EXISTS publication_allowed,
  DROP COLUMN IF EXISTS provider_direct_commit_allowed,
  DROP COLUMN IF EXISTS mission_agent_local_commit_allowed,
  DROP COLUMN IF EXISTS isolated_worktree_write_allowed,
  DROP COLUMN IF EXISTS authority_schema_version;
DELETE FROM schema_migrations WHERE name='0030_repository_authority.sql';
COMMIT;
