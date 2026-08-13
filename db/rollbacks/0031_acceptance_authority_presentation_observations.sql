BEGIN;

DROP TABLE IF EXISTS acceptance_authority_local_state_observations;
DROP TABLE IF EXISTS acceptance_authority_presentation_observations;
DROP TABLE IF EXISTS acceptance_active_provider_attempts;
DROP FUNCTION IF EXISTS prevent_acceptance_authority_presentation_observation_mutation();

DELETE FROM schema_migrations WHERE name='0031_acceptance_authority_presentation_observations.sql';

COMMIT;
