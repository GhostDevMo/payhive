import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool, types } = pg;

// pg returns int8 (bigint) as a string by default to avoid precision loss.
// We want real BigInts everywhere money is involved, so parse them here once
// rather than remembering to convert at every call site.
types.setTypeParser(types.builtins.INT8, (value: string) => BigInt(value));

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://payhive:payhive@localhost:5432/payhive';

/**
 * Managed Postgres (Neon, Supabase, RDS, Render) requires TLS, and the local
 * Docker one does not offer it. Drive that off the connection string so the
 * same build works in both places without a second switch to forget.
 *
 * Verification stays on by default. PGSSL_NO_VERIFY exists for providers that
 * front the database with a self-signed certificate, and is deliberately
 * awkward to reach for: turning it on means accepting any certificate, which
 * on a database holding a ledger is a decision, not a default.
 */
const sslRequired = /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(DATABASE_URL);
const sslNoVerify = process.env.PGSSL_NO_VERIFY === 'true';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: !sslNoVerify } : undefined,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  // Serialisable-adjacent behaviour is handled per-transaction in the ledger;
  // the default isolation level plus explicit row locks is what we rely on.
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything you can run a query on: the pool, or an open transaction. */
export type Executor = Database | Transaction;

export { schema };
