import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect } from './client.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required, refusing to run migrations');
  process.exit(1);
}

// Idempotent by construction: drizzle records applied migrations in its own
// journal table and skips anything already applied (PRD ISS-003 test case 3).
const handle = connect(databaseUrl, { max: 1 });

try {
  await migrate(handle.db, { migrationsFolder: './migrations' });
  console.log('[db] migrations applied');
} catch (err) {
  console.error('[db] migration failed', err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
