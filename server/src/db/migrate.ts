import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { db, pool } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Apply schema migrations, then the ledger invariants.
 *
 * The invariants are applied separately and idempotently because they are
 * hand-written database guarantees rather than generated DDL — drizzle-kit
 * has no way to express a deferred constraint trigger, and these are too
 * important to leave out on that account.
 */
async function main(): Promise<void> {
  console.log('[payhive] running schema migrations…');
  await migrate(db, { migrationsFolder: join(here, '../../drizzle') });

  console.log('[payhive] applying ledger invariants…');
  const invariants = await readFile(join(here, 'invariants.sql'), 'utf8');
  await db.execute(sql.raw(invariants));

  console.log('[payhive] database ready.');
  await pool.end();
}

main().catch(async (error) => {
  console.error('[payhive] migration failed:', error);
  await pool.end();
  process.exit(1);
});
