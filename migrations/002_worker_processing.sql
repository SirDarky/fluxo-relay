ALTER TABLE items
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN last_error text;

ALTER TABLE runs
  ADD COLUMN delivery_state text NOT NULL DEFAULT 'waiting'
    CHECK (delivery_state IN ('waiting', 'sending', 'delivered', 'failed')),
  ADD COLUMN callback_attempts integer NOT NULL DEFAULT 0 CHECK (callback_attempts >= 0),
  ADD COLUMN callback_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN callback_started_at timestamptz,
  ADD COLUMN callback_last_error text,
  ADD COLUMN delivered_at timestamptz;

ALTER TABLE outbox ADD COLUMN last_checked_at timestamptz;

CREATE TABLE callback_attempts (
  id uuid PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  result jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_status integer,
  response jsonb,
  error text,
  UNIQUE (run_id, attempt)
);

CREATE INDEX items_retry_idx ON items (next_attempt_at)
  WHERE state IN ('pending', 'processing');
CREATE INDEX runs_delivery_idx ON runs (callback_next_attempt_at)
  WHERE delivery_state IN ('waiting', 'sending');
