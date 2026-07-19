import { eq } from 'drizzle-orm';
import { connect } from './client.js';
import { createUser, createWorkspace } from './repositories/workspaces.js';
import { users } from './schema/users.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required, refusing to seed');
  process.exit(1);
}

const SEED_EMAIL = 'owner@poslatr.local';

const handle = connect(databaseUrl, { max: 1 });

try {
  // Idempotent: re-running the seed must not create a second workspace/user.
  const [existing] = await handle.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SEED_EMAIL))
    .limit(1);

  if (existing) {
    console.log('[db] seed already applied, nothing to do');
  } else {
    const workspace = await createWorkspace(handle.db, { name: 'Poslatr' });
    // No password is set here: credential handling belongs to ISS-009.
    const user = await createUser(handle.db, workspace.id, {
      email: SEED_EMAIL,
      displayName: 'Owner',
    });
    console.log(`[db] seeded workspace ${workspace.id} and user ${user.id}`);
  }
} catch (err) {
  console.error('[db] seed failed', err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
