ALTER TABLE app_users
  ADD COLUMN dingtalk_union_id text,
  ADD COLUMN dingtalk_open_id text,
  ADD COLUMN avatar_url text;

CREATE UNIQUE INDEX app_users_union_identity
  ON app_users(organization_id, dingtalk_union_id)
  WHERE dingtalk_union_id IS NOT NULL;

CREATE UNIQUE INDEX app_users_open_identity
  ON app_users(organization_id, dingtalk_open_id)
  WHERE dingtalk_open_id IS NOT NULL;

CREATE TABLE auth_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  poll_token_hash text NOT NULL CHECK(poll_token_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
  user_id uuid,
  error_code text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id),
  CHECK((status = 'succeeded') = (user_id IS NOT NULL)),
  CHECK(status <> 'failed' OR error_code IS NOT NULL)
);

CREATE INDEX pending_auth_attempts ON auth_attempts(expires_at) WHERE status = 'pending';

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,user_id) REFERENCES app_users(organization_id,id)
);

CREATE INDEX active_user_sessions ON user_sessions(token_hash,expires_at) WHERE revoked_at IS NULL;
