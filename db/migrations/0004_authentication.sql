ALTER TABLE users
  ADD COLUMN password_hash text NOT NULL,
  ADD COLUMN auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  ADD COLUMN disabled_at timestamptz;

