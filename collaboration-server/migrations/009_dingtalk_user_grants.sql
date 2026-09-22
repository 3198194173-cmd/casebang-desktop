CREATE TABLE dingtalk_user_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text,
  token_nonce text NOT NULL,
  token_tag text NOT NULL,
  expires_at timestamptz,
  token_type text,
  scopes text[] NOT NULL DEFAULT '{}',
  key_version integer NOT NULL DEFAULT 1,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,user_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id) ON DELETE CASCADE
);

CREATE INDEX dingtalk_user_grants_active
  ON dingtalk_user_grants(organization_id,user_id)
  WHERE revoked_at IS NULL;
