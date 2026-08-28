import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { refreshTokens, sessions, users } from '../db/schema.js';

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

/**
 * A native client's access token is deliberately short-lived. It is the thing
 * kept in app storage on a device that might be lost, and the refresh token is
 * what makes a short life cheap.
 */
const MOBILE_ACCESS_TTL_MINUTES = 30;
const REFRESH_TTL_DAYS = 60;

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

export async function createSession(
  userId: string,
  ttlMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

// ---------------------------------------------------------------------------
// Tokens for native clients
// ---------------------------------------------------------------------------

/**
 * Hash a token for storage.
 *
 * A plain SHA-256 rather than scrypt: these are 32 random bytes, not something
 * a person chose, so there is no dictionary to defend against and no reason to
 * make verification expensive on every request.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Issue a fresh pair. Used at login, and again on every refresh. */
export async function issueTokenPair(
  userId: string,
  familyId: string = randomUUID(),
): Promise<TokenPair> {
  const session = await createSession(userId, MOBILE_ACCESS_TTL_MINUTES * 60 * 1000);

  const refreshToken = randomBytes(32).toString('base64url');
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: refreshExpiresAt,
  });

  return {
    accessToken: session.id,
    accessExpiresAt: session.expiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

export class RefreshError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RefreshError';
  }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Presenting a token that has already been used means two parties hold it, and
 * there is no way to tell which one is the real user. The whole family is
 * revoked, so the thief and the victim are both signed out and the victim can
 * sign in again with a password the thief does not have. Being logged out is
 * survivable; someone else moving your money is not.
 */
export async function rotateRefreshToken(presented: string): Promise<TokenPair> {
  const tokenHash = hashToken(presented);

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) throw new RefreshError('That refresh token is not valid', 'invalid_refresh_token');

  if (row.usedAt || row.revokedAt) {
    await burnFamily(row.familyId, row.userId);
    throw new RefreshError(
      'That refresh token has already been used. Sign in again.',
      'refresh_token_reused',
    );
  }

  if (row.expiresAt <= new Date()) {
    throw new RefreshError('That refresh token has expired', 'refresh_token_expired');
  }

  // Claim it with a conditional update rather than a read followed by a write.
  // Two refreshes arriving together would both pass the check above; only one
  // can win this, and the loser is treated as the reuse that it is.
  const claimed = await db
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt)))
    .returning({ id: refreshTokens.id });

  if (claimed.length === 0) {
    await burnFamily(row.familyId, row.userId);
    throw new RefreshError(
      'That refresh token has already been used. Sign in again.',
      'refresh_token_reused',
    );
  }

  return issueTokenPair(row.userId, row.familyId);
}

/**
 * Revoke every token descended from one login, and every access token with it.
 *
 * Deliberately not inside a transaction that the caller then aborts: this has
 * to survive the error that follows it. Revoking and then throwing from within
 * one transaction rolls the revocation back, which leaves a stolen token
 * working while the response says otherwise.
 */
async function burnFamily(familyId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));

    // Access tokens already exchanged from this family go too, or the thief
    // keeps what they have until it expires.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
}

/** Sign a native client out: its access token and its whole refresh family. */
export async function revokeRefreshToken(presented: string): Promise<void> {
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(presented)))
    .limit(1);

  if (!row) return;

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
}

export interface SessionUser {
  id: string;
  payhiveId: string;
  handle: string | null;
  email: string;
  displayName: string;
  kycStatus: string;
}

export async function resolveSession(sessionId: string): Promise<SessionUser | null> {
  const rows = await db
    .select({
      id: users.id,
      payhiveId: users.payhiveId,
      handle: users.handle,
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

/**
 * End every session for a user except the one making the request.
 *
 * Used when a password changes: if the reason is that somebody else knows it,
 * leaving their session signed in defeats the change.
 */
export async function destroyOtherSessions(userId: string, keepSessionId: string): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
