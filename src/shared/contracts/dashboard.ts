export interface DashboardRun {
  run_id: string;
  test_number: number;
  source: "local" | "remote";
  expected_total: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  delivered_at: string | null;
  delivery_state: string;
  received: number;
  completed: number;
  failed: number;
  processing: number;
  pending: number;
  deliveries: number;
  callback_attempts: number;
  callback_last_error: string | null;
  duration_ms: number | null;
}
export interface DashboardItem {
  seq: number;
  sku: string;
  state: string;
  deliveries: number;
  attempts: number;
  price: number | null;
  stock: number | null;
  last_error: string | null;
  received_at: string;
  last_received_at: string;
  received_payload: { run_id: string; seq: number; sku: string } | null;
  processed_at: string | null;
  processing_started_at: string | null;
  processing_finished_at: string | null;
  processing_duration_ms: number | null;
  backend_duration_ms: number | null;
  attempt_history: {
    attempt: number;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    http_status: number | null;
  }[];
  next_attempt_at: string;
}
export interface DashboardEvent {
  id: string;
  run_id: string;
  seq: number | null;
  level: "info" | "success" | "warning" | "error";
  kind: string;
  message: string;
  created_at: string;
}
export interface DashboardMetrics {
  received: number;
  completed: number;
  failed: number;
  processing: number;
  pending: number;
  duplicates: number;
  retries: number;
  ack_p95_ms: number | null;
  ack_avg_ms: number | null;
  ack_under_sla_pct: number | null;
  ack_count: number;
  ack_errors: number;
  enrich_avg_ms: number | null;
  http_429: number;
  http_500: number;
  enrich_attempts: number;
}
export interface DashboardSnapshot {
  generatedAt: string;
  system: {
    externalEnabled: boolean;
    simulationEnabled: boolean;
    telemetryDropped: number;
  };
  integrations: {
    cid: string;
    name: string;
    webhook: string;
    updated_at: string;
  }[];
  runs: DashboardRun[];
  selectedRunId: string | null;
  items: DashboardItem[];
  itemsTotal: number;
  page: number;
  events: DashboardEvent[];
  metrics: DashboardMetrics;
  timeline: { minute: string; received: number; completed: number }[];
  latency: { label: string; count: number }[];
}
