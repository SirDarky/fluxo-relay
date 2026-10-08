import pg from "pg";
import { env } from "../config/env.js";

// Cada processo cria seu próprio pool, usando a mesma configuração de conexão.
export function createDatabasePool(max = 5) {
  return new pg.Pool({
    connectionString: env.databaseUrl,
    max,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
  });
}
export const database = createDatabasePool();
