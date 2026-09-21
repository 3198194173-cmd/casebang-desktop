ALTER TABLE artwork_entries ADD COLUMN dentry_uuid text;

CREATE INDEX artwork_entries_uuid_lookup
  ON artwork_entries(source_id,dentry_uuid)
  WHERE dentry_uuid IS NOT NULL;

CREATE TABLE artwork_work_targets (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES artwork_sources(id) ON DELETE CASCADE,
  folder_url text NOT NULL,
  node_id text NOT NULL,
  dentry_id text NOT NULL,
  folder_name text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id,work_item_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id)
);

CREATE INDEX artwork_work_targets_source ON artwork_work_targets(source_id);
