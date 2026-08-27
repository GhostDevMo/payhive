import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from './index.js';

/**
 * Drop and recreate the public schema. Local development and tests only —
 * refuses to run against anything that doesn't look like a local database,
 * because "I ran the reset script against prod" is a real way to end a company.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url);

  if (!isLocal && process.env.ALLOW_DESTRUCTIVE_RESET !== 'yes-i-am-sure') {
    console.error(
      `[payhive] refusing to reset a non-local database (${url.replace(/:[^:@]*@/, ':***@')}).\n` +
        'Set ALLOW_DESTRUCTIVE_RESET=yes-i-am-sure if you really mean it.',
    );
    process.exit(1);
  }

  await db.execute(sql`DROP SCHEMA public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  console.log('[payhive] schema dropped. Run `npm run db:migrate` to rebuild.');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
