CREATE TABLE stream_events (
  id uuid PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  corp_id text,
  topic text NOT NULL,
  event_type text,
  headers jsonb NOT NULL,
  raw_payload text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text
);
CREATE INDEX pending_stream_events ON stream_events(received_at) WHERE processed_at IS NULL;
