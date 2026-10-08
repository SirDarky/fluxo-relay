CREATE TABLE integrations (
  cid text PRIMARY KEY,
  name text NOT NULL,
  webhook text NOT NULL,
  token text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- cid e expected_total podem ser preenchidos após a primeira mensagem chegar.
CREATE TABLE runs (
  run_id text PRIMARY KEY,
  cid text REFERENCES integrations(cid),
  expected_total integer CHECK (expected_total > 0),
  started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
  run_id text NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  sku text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  deliveries integer NOT NULL DEFAULT 1 CHECK (deliveries > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz NOT NULL DEFAULT now(),
  price numeric(18, 4),
  stock integer CHECK (stock >= 0),
  processed_at timestamptz,
  PRIMARY KEY (run_id, seq)
);

-- Uma tarefa durável para cada item; o worker publicará essas tarefas na fila.
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL,
  seq integer NOT NULL,
  event_type text NOT NULL CHECK (event_type = 'enrich_item'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (run_id, seq, event_type),
  FOREIGN KEY (run_id, seq) REFERENCES items(run_id, seq) ON DELETE CASCADE
);

CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX items_run_state_idx ON items (run_id, state);
