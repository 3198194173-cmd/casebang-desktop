-- Series artwork directories are independent caches. A user may work on
-- multiple series, so the old one-source-per-user constraint is too narrow.
ALTER TABLE artwork_sources
  DROP CONSTRAINT IF EXISTS artwork_sources_organization_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS artwork_sources_folder_key
  ON artwork_sources(organization_id, user_id, node_id);

