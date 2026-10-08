export interface Registration {
  cid: string;
  token: string;
}

export interface Burst {
  run_id: string;
  total: number;
  started_at: string;
}

export interface EnrichedProduct {
  sku: string;
  price: number;
  stock: number;
}

export interface ResultItem extends EnrichedProduct { seq: number }
export interface CallbackPayload { cid: string; run_id: string; result: ResultItem[] }
export interface CallbackResponse { status: number; body: unknown }
