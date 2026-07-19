import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
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
