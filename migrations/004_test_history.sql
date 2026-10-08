CREATE SEQUENCE dashboard_test_number_seq;
ALTER TABLE runs
  ADD COLUMN test_number bigint UNIQUE,
  ADD COLUMN finished_at timestamptz;

-- Só execuções identificadas entram no histórico; mensagens sem metadados não são testes.
WITH numbered AS (
  SELECT run_id, row_number() OVER (ORDER BY COALESCE(started_at,created_at),run_id) AS number
  FROM runs WHERE cid IS NOT NULL AND expected_total IS NOT NULL
)
UPDATE runs r SET test_number=n.number FROM numbered n WHERE r.run_id=n.run_id;
SELECT setval('dashboard_test_number_seq',GREATEST(COALESCE(max(test_number),0),1),count(test_number)>0) FROM runs;
UPDATE runs SET finished_at=delivered_at WHERE delivered_at IS NOT NULL;
UPDATE runs r SET finished_at=COALESCE(
  (SELECT max(finished_at) FROM callback_attempts c WHERE c.run_id=r.run_id),
  (SELECT max(finished_at) FROM product_attempts p WHERE p.run_id=r.run_id),
  (SELECT max(created_at) FROM processing_events e WHERE e.run_id=r.run_id AND e.kind='failed')
) WHERE finished_at IS NULL AND (delivery_state='failed' OR (
  EXISTS (SELECT 1 FROM items i WHERE i.run_id=r.run_id AND i.state='failed')
  AND (SELECT count(*) FROM items i WHERE i.run_id=r.run_id)=r.expected_total
  AND NOT EXISTS (SELECT 1 FROM items i WHERE i.run_id=r.run_id AND i.state IN ('pending','processing'))
));

CREATE FUNCTION track_test_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.test_number IS NULL AND NEW.cid IS NOT NULL AND NEW.expected_total IS NOT NULL THEN
    NEW.test_number := nextval('dashboard_test_number_seq');
  END IF;
  IF NEW.delivery_state='delivered' THEN
    NEW.finished_at := COALESCE(NEW.delivered_at,NEW.finished_at,now());
  ELSIF NEW.delivery_state='failed' AND NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runs_test_history BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION track_test_history();

CREATE FUNCTION finish_failed_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('completed','failed') AND OLD.state <> NEW.state THEN
    -- Serializa somente a conclusão local, para duas últimas tarefas não perderem o término.
    PERFORM pg_advisory_xact_lock(hashtext(NEW.run_id),-2);
    UPDATE runs r SET finished_at=COALESCE(finished_at,now()) WHERE r.run_id=NEW.run_id
      AND (SELECT count(*) FROM items i WHERE i.run_id=r.run_id)=r.expected_total
      AND EXISTS (SELECT 1 FROM items i WHERE i.run_id=r.run_id AND i.state='failed')
      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.run_id=r.run_id AND i.state IN ('pending','processing'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_failed_test AFTER UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION finish_failed_test();
