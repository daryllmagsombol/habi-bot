import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * The narrow query surface shared by a Pool and a PoolClient. Repositories take
 * this type so a transaction client can be used without changing their SQL.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PersistencePoolOptions {
  connectionString: string;
  max?: number;
}

/**
 * Creates the backend/worker connection pool. Config values are supplied by the
 * caller; this module never reads environment variables or credentials.
 */
export function createPersistencePool(options: PersistencePoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    application_name: 'habi-persistence',
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
}

/**
 * Runs `work` in one transaction. A failed unit of work is rolled back before
 * the original error is rethrown, so callers never see a partially applied
 * append or delete.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original failure is the useful one; the connection is released
      // below and PostgreSQL discards an aborted transaction.
    }
    throw error;
  } finally {
    client.release();
  }
}
