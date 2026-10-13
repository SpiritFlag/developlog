import { Pool, type PoolClient } from "pg";
export interface Executor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Executor {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}
const globalDb = globalThis as unknown as { developlogPool?: Pool };
export function database(): Database {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured");
  const pool = (globalDb.developlogPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  }));
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(fn: (tx: Executor) => Promise<T>) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            return { rows: (await client.query(sql, params)).rows as R[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
