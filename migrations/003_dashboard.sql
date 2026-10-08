ALTER TABLE runs ADD COLUMN source text NOT NULL DEFAULT 'remote'
  CHECK (source IN ('local', 'remote'));

CREATE TABLE product_attempts (
  run_id text NOT NULL,
  seq integer NOT NULL,
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_status integer,
  duration_ms double precision,
  PRIMARY KEY (run_id, seq, attempt),
  FOREIGN KEY (run_id, seq) REFERENCES items(run_id, seq) ON DELETE CASCADE
);

-- Observabilidade fica fora do caminho que confirma o recebimento.
CREATE TABLE ack_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text,
  seq integer,
  status integer NOT NULL,
  duration_ms double precision NOT NULL CHECK (duration_ms >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ack_samples_run_idx ON ack_samples (run_id, id);

CREATE TABLE processing_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq integer,
  level text NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
  kind text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_events_run_idx ON processing_events (run_id, id DESC);

CREATE FUNCTION record_item_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind text; event_level text; event_message text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_kind := 'received'; event_level := 'info'; event_message := 'Item recebido e guardado.';
  ELSIF NEW.deliveries > OLD.deliveries THEN
    event_kind := 'duplicate'; event_level := 'warning'; event_message := 'Mensagem repetida reconhecida; nenhuma tarefa extra criada.';
  ELSIF NEW.state = 'processing' AND (OLD.state <> NEW.state OR OLD.attempts <> NEW.attempts) THEN
    event_kind := 'processing'; event_level := 'info'; event_message := 'Consultando preço e estoque. Tentativa ' || NEW.attempts || '.';
  ELSIF NEW.state = 'completed' AND OLD.state <> NEW.state THEN
    event_kind := 'completed'; event_level := 'success'; event_message := 'Preço e estoque guardados.';
  ELSIF NEW.state = 'pending' AND NEW.last_error IS NOT NULL AND (OLD.state <> NEW.state OR OLD.last_error IS DISTINCT FROM NEW.last_error) THEN
    event_kind := 'retry'; event_level := 'warning'; event_message := 'Falha temporária; nova tentativa agendada.';
  ELSIF NEW.state = 'failed' AND OLD.state <> NEW.state THEN
    event_kind := 'failed'; event_level := 'error'; event_message := 'Processamento encerrado com falha. Confira o detalhe do item.';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO processing_events (run_id, seq, level, kind, message)
    VALUES (NEW.run_id, NEW.seq, event_level, event_kind, event_message);
  RETURN NEW;
END $$;
CREATE TRIGGER items_dashboard_event AFTER INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION record_item_event();

CREATE FUNCTION record_run_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO processing_events (run_id, level, kind, message)
      VALUES (NEW.run_id, 'info', 'run_created', 'Lote criado; aguardando os itens.');
  ELSIF NEW.delivery_state <> OLD.delivery_state THEN
    INSERT INTO processing_events (run_id, level, kind, message) VALUES (
      NEW.run_id,
      CASE NEW.delivery_state WHEN 'delivered' THEN 'success' WHEN 'failed' THEN 'error' WHEN 'waiting' THEN 'warning' ELSE 'info' END,
      'callback_' || NEW.delivery_state,
      CASE NEW.delivery_state WHEN 'delivered' THEN 'Callback confirmado; lote concluído.'
        WHEN 'failed' THEN 'Callback encerrado com falha.' WHEN 'waiting' THEN 'Callback será tentado novamente.'
        ELSE 'Todos os itens prontos; enviando callback.' END
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runs_dashboard_event AFTER INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION record_run_event();
