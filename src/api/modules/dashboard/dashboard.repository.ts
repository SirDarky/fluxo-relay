import type { Pool } from "pg";
import type {
  DashboardSnapshot,
  DashboardRun,
  DashboardItem,
  DashboardEvent,
  DashboardMetrics,
} from "../../../shared/contracts/dashboard.js";

export class DashboardRepository {
  constructor(private readonly pool: Pool) {}

  async snapshot(
    runId: string | null,
    page = 0,
  ): Promise<Omit<DashboardSnapshot, "system">> {
    const scope = [runId];
    // Nunca selecionamos tokens. Dados detalhados e séries têm limites próprios.
    const [
      runs,
      items,
      events,
      totals,
      ack,
      attempts,
      timeline,
      latency,
      integrations,
    ] = await Promise.all([
      this.pool
        .query<DashboardRun>(`WITH recent AS (SELECT * FROM runs WHERE test_number IS NOT NULL ORDER BY test_number DESC LIMIT 50)
        SELECT r.run_id, r.test_number::int, r.source, r.expected_total, r.created_at, r.started_at, r.finished_at, r.delivered_at, r.delivery_state,
          r.callback_attempts, r.callback_last_error,
          count(i.seq)::int AS received, count(i.seq) FILTER (WHERE i.state='completed')::int AS completed,
          count(i.seq) FILTER (WHERE i.state='failed')::int AS failed,
          count(i.seq) FILTER (WHERE i.state='processing')::int AS processing,
          count(i.seq) FILTER (WHERE i.state='pending')::int AS pending,
          COALESCE(sum(i.deliveries),0)::int AS deliveries,
          CASE WHEN r.finished_at IS NOT NULL THEN extract(epoch FROM (r.finished_at-COALESCE(r.started_at,r.created_at)))*1000 END::float8 AS duration_ms
        FROM recent r LEFT JOIN items i ON i.run_id=r.run_id GROUP BY r.run_id, r.source, r.expected_total,
          r.test_number,r.created_at,r.started_at,r.finished_at,r.delivered_at,r.delivery_state,r.callback_attempts,r.callback_last_error ORDER BY r.test_number DESC`),
      this.pool.query<DashboardItem>(
        `WITH page_items AS (
          SELECT * FROM items WHERE run_id=$1 ORDER BY seq LIMIT 100 OFFSET $2
        ), timed AS (
          SELECT i.*, a.started_at AS first_started_at,
            CASE WHEN i.state='completed' THEN i.processed_at
              WHEN i.state='failed' THEN COALESCE(f.created_at,a.finished_at) END AS finished_at,
            b.duration_ms AS backend_duration_ms,a.attempt_history
          FROM page_items i
          LEFT JOIN LATERAL (
            SELECT min(started_at) AS started_at,max(finished_at) AS finished_at,
              COALESCE(jsonb_agg(jsonb_build_object('attempt',attempt,'started_at',started_at,
                'finished_at',finished_at,'duration_ms',duration_ms,'http_status',http_status)
                ORDER BY attempt),'[]'::jsonb) AS attempt_history
            FROM product_attempts WHERE run_id=i.run_id AND seq=i.seq
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT duration_ms FROM product_attempts
            WHERE run_id=i.run_id AND seq=i.seq AND finished_at IS NOT NULL
            ORDER BY attempt DESC LIMIT 1
          ) b ON true
          LEFT JOIN LATERAL (
            SELECT created_at FROM processing_events
            WHERE run_id=i.run_id AND seq=i.seq AND kind='failed' AND i.state='failed'
            ORDER BY id DESC LIMIT 1
          ) f ON true
        ) SELECT seq,sku,state,deliveries,attempts,price::float8,stock,last_error,
          received_at,last_received_at,
          (SELECT jsonb_build_object('run_id',o.payload->'run_id','seq',o.payload->'seq','sku',o.payload->'sku')
            FROM outbox o WHERE o.run_id=timed.run_id AND o.seq=timed.seq AND o.event_type='enrich_item') AS received_payload,
          processed_at,next_attempt_at,first_started_at AS processing_started_at,
          finished_at AS processing_finished_at,
          CASE WHEN first_started_at IS NOT NULL AND (state IN ('pending','processing') OR finished_at IS NOT NULL)
            THEN GREATEST(0,extract(epoch FROM (COALESCE(finished_at,now())-first_started_at))*1000)
          END::float8 AS processing_duration_ms,backend_duration_ms,attempt_history
        FROM timed ORDER BY seq`,
        [runId, page * 100],
      ),
      this.pool.query<DashboardEvent>(
        `SELECT id::text,run_id,seq,level,kind,message,created_at FROM processing_events
        WHERE ($1::text IS NULL OR run_id=$1) ORDER BY processing_events.id DESC LIMIT 200`,
        scope,
      ),
      this.pool.query(
        `SELECT count(*)::int AS received,
        count(*) FILTER (WHERE state='completed')::int AS completed,
        count(*) FILTER (WHERE state='failed')::int AS failed,
        count(*) FILTER (WHERE state='processing')::int AS processing,
        count(*) FILTER (WHERE state='pending')::int AS pending,
        COALESCE(sum(deliveries-1),0)::int AS duplicates,
        COALESCE(sum(GREATEST(attempts-1,0)),0)::int AS retries FROM items WHERE ($1::text IS NULL OR run_id=$1)`,
        scope,
      ),
      this.pool.query(
        `WITH ordered AS (SELECT *, row_number() OVER (PARTITION BY run_id ORDER BY id) AS position
        FROM ack_samples WHERE ($1::text IS NULL OR run_id=$1)), successful AS (SELECT * FROM ordered WHERE position>1 AND status BETWEEN 200 AND 299)
        SELECT (SELECT count(*)::int FROM successful) AS ack_count,
          (SELECT count(*)::int FROM ordered WHERE status>=400) AS ack_errors,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS ack_p95_ms,
          avg(duration_ms)::float8 AS ack_avg_ms,
          (100.0*count(*) FILTER (WHERE duration_ms<=600)/NULLIF(count(*),0))::float8 AS ack_under_sla_pct FROM successful`,
        scope,
      ),
      this.pool.query(
        `SELECT avg(duration_ms)::float8 AS enrich_avg_ms,
        count(*) FILTER (WHERE http_status=429)::int AS http_429,
        count(*) FILTER (WHERE http_status>=500)::int AS http_500,
        count(*)::int AS enrich_attempts FROM product_attempts WHERE ($1::text IS NULL OR run_id=$1)`,
        scope,
      ),
      this.pool.query(
        `WITH buckets AS (SELECT generate_series(date_trunc('minute',now())-interval '14 minutes',date_trunc('minute',now()),interval '1 minute') AS minute)
        SELECT b.minute, (SELECT count(*)::int FROM items WHERE ($1::text IS NULL OR run_id=$1) AND received_at>=b.minute AND received_at<b.minute+interval '1 minute') AS received,
        (SELECT count(*)::int FROM items WHERE ($1::text IS NULL OR run_id=$1) AND processed_at>=b.minute AND processed_at<b.minute+interval '1 minute') AS completed FROM buckets b ORDER BY minute`,
        scope,
      ),
      this.pool.query(
        `WITH ordered AS (SELECT *,row_number() OVER (PARTITION BY run_id ORDER BY id) AS position FROM ack_samples WHERE ($1::text IS NULL OR run_id=$1)),
        buckets AS (SELECT * FROM (VALUES (0,'0–100 ms',0,100),(1,'100–300 ms',100,300),(2,'300–600 ms',300,600),(3,'> 600 ms',600,NULL)) AS v(position,label,low,high))
        SELECT b.label,count(a.id)::int AS count FROM buckets b LEFT JOIN ordered a ON a.position>1 AND a.status BETWEEN 200 AND 299
          AND (CASE WHEN b.position=3 THEN a.duration_ms>600
            WHEN b.position=2 THEN a.duration_ms>=300 AND a.duration_ms<=600
            ELSE a.duration_ms>=b.low AND a.duration_ms<b.high END)
        GROUP BY b.position,b.label ORDER BY b.position`,
        scope,
      ),
      this.pool.query(
        `SELECT cid,name,webhook,updated_at FROM integrations WHERE cid<>'local-simulator' ORDER BY updated_at DESC LIMIT 20`,
      ),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      runs: runs.rows,
      selectedRunId: runId,
      items: items.rows,
      itemsTotal: runId ? totals.rows[0].received : 0,
      page,
      events: events.rows,
      metrics: {
        ...totals.rows[0],
        ...ack.rows[0],
        ...attempts.rows[0],
      } as DashboardMetrics,
      timeline: timeline.rows,
      latency: latency.rows,
      integrations: integrations.rows,
    };
  }

  async report(runId: string) {
    const result = await this.pool.query(
      `SELECT run_id,attempt,http_status,response,result,started_at,finished_at
      FROM callback_attempts WHERE run_id=$1 AND http_status BETWEEN 200 AND 299 ORDER BY attempt DESC LIMIT 1`,
      [runId],
    );
    return result.rows[0];
  }
}
