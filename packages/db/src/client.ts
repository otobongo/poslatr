import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

/**
 * The transaction handle Drizzle passes to a db.transaction() callback, derived
 * from Database so it stays correct if the driver is swapped.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything a repository can run against: a pooled connection or an open
 * transaction (ISS-003-F7). Every repository function takes this, so callers
 * can compose multi-statement operations atomically.
 */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

/**
 * Runs `fn` inside a transaction. ISS-004's rotateMasterKey and ISS-009's
 * create-post-with-targets both require this.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

function createDatabase(sql: postgres.Sql): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(sql, { schema });
}

// The only place a Drizzle client is constructed. Apps consume repositories,
// never this module directly (PRD ISS-003: "apps never import drizzle client
// directly").
export function connect(databaseUrl: string, options: { max?: number } = {}): DatabaseHandle {
  const sql = postgres(databaseUrl, { max: options.max ?? 10 });
  return {
    db: createDatabase(sql),
    close: async () => {
      await sql.end();
    },
  };
}
