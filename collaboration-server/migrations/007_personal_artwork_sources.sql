CREATE TABLE artwork_sources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  folder_url text NOT NULL,
  node_id text NOT NULL,
  space_id text NOT NULL,
  folder_name text NOT NULL,
  status text NOT NULL CHECK(status IN ('ready','error')),
  file_count integer NOT NULL DEFAULT 0 CHECK(file_count>=0),
  folder_count integer NOT NULL DEFAULT 0 CHECK(folder_count>=0),
  last_error text,
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,user_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id)
);

CREATE TABLE artwork_entries (
  source_id uuid NOT NULL REFERENCES artwork_sources(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  dentry_id text NOT NULL,
  parent_id text,
  name text NOT NULL,
  entry_type text NOT NULL,
  extension text,
  size_bytes bigint,
  version bigint,
  path text,
  modified_at timestamptz,
  PRIMARY KEY(source_id,dentry_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id)
);

CREATE INDEX artwork_entries_name_search ON artwork_entries(source_id,lower(name));
