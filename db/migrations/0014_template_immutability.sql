CREATE FUNCTION protect_published_template_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published','deprecated') AND (
    NEW.template_id,NEW.version,NEW.name,NEW.description,NEW.domain,NEW.default_objective,NEW.input_schema,
    NEW.task_definitions,NEW.dependencies,NEW.defaults,NEW.artifact_expectations,NEW.created_by,NEW.created_at
  ) IS DISTINCT FROM (
    OLD.template_id,OLD.version,OLD.name,OLD.description,OLD.domain,OLD.default_objective,OLD.input_schema,
    OLD.task_definitions,OLD.dependencies,OLD.defaults,OLD.artifact_expectations,OLD.created_by,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'published template versions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_template_published_immutable BEFORE UPDATE ON mission_template_projections
FOR EACH ROW EXECUTE FUNCTION protect_published_template_version();
