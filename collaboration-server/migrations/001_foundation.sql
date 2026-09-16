-- PostgreSQL foundation, not run automatically by the desktop application.
-- Apply once to an empty TEST database; record checksum in the deployment migration runner.
BEGIN;
CREATE TABLE organizations (
  id uuid PRIMARY KEY, corp_id text NOT NULL UNIQUE, name text NOT NULL,
  time_zone text NOT NULL DEFAULT 'Asia/Shanghai', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_users (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  dingtalk_user_id text NOT NULL, display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true, first_login_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,dingtalk_user_id)
);
CREATE TABLE work_items (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  origin_id uuid NOT NULL, assignee_id uuid NOT NULL,
  source_workflow text NOT NULL CHECK(source_workflow IN ('new-series','new-products','new-models','manual')),
  source_id text NOT NULL, title text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PENDING_PROCESSING','PROCESSING','NEEDS_SOURCE_FIX','PENDING_ORIGIN_REVIEW','REVISION_REQUESTED','READY_TO_MERGE','MERGED_PENDING_SYNC','SYNCING','SYNC_FAILED','COMPLETED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(origin_id<>assignee_id),
  UNIQUE(organization_id,id), UNIQUE(organization_id,source_workflow,source_id),
  FOREIGN KEY(organization_id,origin_id) REFERENCES app_users(organization_id,id),
  FOREIGN KEY(organization_id,assignee_id) REFERENCES app_users(organization_id,id)
);
CREATE TABLE workbook_revisions (
  organization_id uuid NOT NULL, work_item_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  object_key text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,work_item_id,revision),
  FOREIGN KEY(organization_id,work_item_id) REFERENCES work_items(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES app_users(organization_id,id)
);
CREATE TABLE material_rows (
  organization_id uuid NOT NULL, work_item_id uuid NOT NULL, revision integer NOT NULL, id uuid NOT NULL,
  source_sheet text NOT NULL, source_row integer NOT NULL CHECK(source_row>0),
  identity jsonb NOT NULL, row_values jsonb NOT NULL, issues jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY(organization_id,work_item_id,revision,id),
  FOREIGN KEY(organization_id,work_item_id,revision) REFERENCES workbook_revisions(organization_id,work_item_id,revision)
);
CREATE TABLE number_sequences (
  organization_id uuid NOT NULL REFERENCES organizations(id), month text NOT NULL CHECK(month ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  last_value integer NOT NULL DEFAULT 0 CHECK(last_value BETWEEN 0 AND 9999999),
  -- Must be approved after historical ledger reconciliation; never start blindly at 1.
  baseline_verified_at timestamptz, PRIMARY KEY(organization_id,month)
);
CREATE TABLE code_allocations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK(kind IN ('material','barcode')), code text NOT NULL, sku_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('reserved','confirmed','published','void')),
  source text NOT NULL CHECK(source IN ('internal_monthly','platform','historical_import','material_rule')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,kind,code)
);
CREATE UNIQUE INDEX one_live_code_per_sku ON code_allocations(organization_id,kind,sku_id) WHERE state <> 'void';
CREATE TABLE work_item_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, work_item_id uuid NOT NULL, actor_id uuid NOT NULL,
  request_key text NOT NULL, request_hash text NOT NULL, version integer NOT NULL,
  action text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,request_key), UNIQUE(organization_id,work_item_id,version),
  FOREIGN KEY(organization_id,work_item_id) REFERENCES work_items(organization_id,id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES app_users(organization_id,id)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), event_id uuid NOT NULL UNIQUE,
  destination_user_id uuid NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
  FOREIGN KEY(organization_id,destination_user_id) REFERENCES app_users(organization_id,id),
  FOREIGN KEY(organization_id,event_id) REFERENCES work_item_events(organization_id,id)
);
CREATE INDEX work_items_inbox ON work_items(organization_id,assignee_id,state);
CREATE INDEX pending_outbox ON outbox_events(status,next_attempt_at);
COMMIT;
