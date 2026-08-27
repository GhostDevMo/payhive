import 'dotenv/config';

// Encryption key for the linked-bank token column. Set here rather than in a
// .env so CI, which has no .env file, exercises the same encrypted path.
process.env.SECRETS_KEY ??= 'test-only-secrets-key-not-used-anywhere-real';
import { afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';

/**
 * Truncate between tests rather than re-migrating: it is an order of magnitude
 * faster and keeps the invariant triggers in place, which is the point — these
 * tests are meant to run against the same constraints production has.
 */
beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE postings, transactions, idempotency_keys, provider_events,
                   sessions, accounts, retired_handles, bank_accounts, users
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});
