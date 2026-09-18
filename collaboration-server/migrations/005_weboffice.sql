CREATE TABLE weboffice_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,work_item_id) REFERENCES work_items(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id)
);

CREATE INDEX active_weboffice_sessions
  ON weboffice_sessions(token_hash,expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE weboffice_uploads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  upload_token_hash text NOT NULL UNIQUE CHECK(upload_token_hash ~ '^[a-f0-9]{64}$'),
  expected_name text NOT NULL,
  expected_size bigint NOT NULL CHECK(expected_size BETWEEN 1 AND 67108864),
  digest_type text NOT NULL CHECK(digest_type IN ('sha256')),
  expected_digest text NOT NULL CHECK(expected_digest ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','uploaded','completed','failed')),
  uploaded_size bigint,
  uploaded_digest text,
  completed_revision integer,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(organization_id,work_item_id) REFERENCES work_items(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id),
  FOREIGN KEY(organization_id,session_id) REFERENCES weboffice_sessions(organization_id,id)
);

CREATE INDEX pending_weboffice_uploads
  ON weboffice_uploads(expires_at,status)
  WHERE status IN ('prepared','uploaded');
