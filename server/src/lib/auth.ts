import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';

// promisify() resolves to the 3-argument overload, which drops the options
// object we need for the cost parameters. Assert the 4-argument shape.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Auth primitives.
 *
 * Password hashing uses scrypt from node:crypto rather than a native argon2
 * build — one less thing to compile on a new machine, and scrypt with these
 * parameters is a memory-hard hash that OWASP still considers acceptable.
 */

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;
const SESSION_TTL_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  })) as Buffer;
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const derived = (await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  })) as Buffer;

  // Constant-time compare: a length check first, since timingSafeEqual throws
  // on mismatched lengths and that throw would itself leak length.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * PayHive IDs are what one user types to pay another, so they are optimised
 * for being read aloud and retyped: Crockford's base32 alphabet, which drops
 * I, L, O and U to kill the 1/l/I and 0/O confusions.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generatePayhiveId(): string {
  let id = 'PH';
  for (let i = 0; i < 8; i += 1) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }
  return id;
}

/** Retry on the (astronomically unlikely) collision rather than failing signup. */
export async function allocatePayhiveId(attempts = 5): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = generatePayhiveId();
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.payhiveId, candidate))
      .limit(1);
    if (!existing[0]) return candidate;
  }
  throw new Error('Could not allocate a unique PayHive ID');
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'payhive_session';

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export interface SessionUser {
  id: string;
  payhiveId: string;
  email: string;
  displayName: string;
  kycStatus: string;
}

export async function resolveSession(sessionId: string): Promise<SessionUser | null> {
  const rows = await db
    .select({
      id: users.id,
      payhiveId: users.payhiveId,
      email: users.email,
      displayName: users.displayName,
      kycStatus: users.kycStatus,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0] ?? null;
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
