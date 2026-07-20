ALTER TABLE recommendation_projections
  ADD CONSTRAINT recommendation_repository_fk
  FOREIGN KEY (workspace_id,repository_id)
  REFERENCES repositories(workspace_id,repository_id);
