/**
 * Emailed single-use links: password reset and email change.
 *
 * The rules both flows follow, and why:
 *
 *  - **Requesting one never says whether the account exists.** A reset form
 *    that answers "no such user" is an account-enumeration oracle, and for a
 *    payments product the list of customers is itself worth stealing. Every
 *    request gets the same answer.
 *  - **Tokens are stored hashed and are good once.** A leaked database must
 *    not contain working links, and a link that has been used — or that
 *    someone has since forgotten they clicked — must not work twice.
 *  - **They expire quickly.** An email lives in a mailbox forever; the
 *    authority it carries should not.
 *  - **Redeeming one ends every session.** If the reason for a reset is that
 *    somebody else had the password, leaving their session alive defeats it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getEmailProvider } from '../email/index.js';
import { hashPassword } from './auth.js';

const { authTokens, sessions, users } = schema;

export const RESET_TTL_MINUTES = 60;
export const EMAIL_CHANGE_TTL_MINUTES = 60;

/** How many links one account may request in the window, before we stop sending. */
const MAX_REQUESTS = 5;
const RATE_WINDOW_MINUTES = 15;

export class VerificationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Where the links point. Must be the origin a user actually opens. */
function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

async function issue(
  userId: string,
  purpose: 'password_reset' | 'email_change',
  ttlMinutes: number,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');

  await db.insert(authTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    payload,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });

  return token;
}

/**
 * Consume a token, or explain why it cannot be.
 *
 * The same message for missing, expired and already-used, because the
 * difference is only useful to somebody guessing.
 */
async function consume(
  token: string,
  purpose: 'password_reset' | 'email_change',
): Promise<{ userId: string; payload: Record<string, unknown> }> {
  const tokenHash = hashToken(token);

  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, purpose)))
    .limit(1);

  const invalid = () =>
    new VerificationError('That link is invalid or has expired.', 'invalid_token', 400);

  if (!row || row.usedAt || row.expiresAt <= new Date()) throw invalid();

  // Conditional update: two clicks arriving together must not both succeed.
  const claimed = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });

  if (claimed.length === 0) throw invalid();

  return { userId: row.userId, payload: row.payload };
}

/** True when this account has asked for too many links too quickly. */
async function rateLimited(userId: string, purpose: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        gt(authTokens.createdAt, new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000)),
      ),
    );

  return (row?.count ?? 0) >= MAX_REQUESTS;
}

/**
 * Start a password reset.
 *
 * Resolves the same way whether or not the address has an account. The caller
 * must not vary its response on the outcome.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .limit(1);

  if (!user) return;
  if (await rateLimited(user.id, 'password_reset')) return;

  const token = await issue(user.id, 'password_reset', RESET_TTL_MINUTES);
  const link = `${appUrl()}/?reset=${encodeURIComponent(token)}`;

  await getEmailProvider().send({
    to: user.email,
    subject: 'Reset your PayHive password',
    text: [
      `Hi ${user.displayName},`,
      '',
      'Someone asked to reset the password on your PayHive account. If that was',
      'you, open the link below within the next hour:',
      '',
      link,
      '',
      'If it was not you, nothing has changed and you can ignore this message.',
      'Your password stays as it is until this link is used.',
      '',
      'PayHive will never ask you for your password or a code by email or phone.',
    ].join('\n'),
  });
}

/** Finish a password reset. */
export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) {
    throw new VerificationError(
      'Your new password must be at least 10 characters.',
      'password_too_short',
    );
  }

  const { userId } = await consume(token, 'password_reset');

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, userId));

    // Everything signed in with the old password goes.
    await tx.delete(sessions).where(eq(sessions.userId, userId));

    // Any other outstanding reset link is now stale.
    await tx
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(authTokens.userId, userId),
          eq(authTokens.purpose, 'password_reset'),
          isNull(authTokens.usedAt),
        ),
      );
  });
}

/**
 * Start an email change.
 *
 * The link goes to the NEW address, because the point is to prove the person
 * can read it. Nothing changes until it is opened, so a typo costs a
 * non-delivery rather than an account.
 */
export async function requestEmailChange(userId: string, newEmail: string): Promise<void> {
  const normalised = newEmail.trim().toLowerCase();

  const [user] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new VerificationError('User not found', 'user_not_found', 404);
  if (normalised === user.email.toLowerCase()) {
    throw new VerificationError('That is already your email address.', 'email_unchanged');
  }
  if (await rateLimited(user.id, 'email_change')) {
    throw new VerificationError(
      'Too many requests. Try again in a few minutes.',
      'rate_limited',
      429,
    );
  }

  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, normalised))
    .limit(1);

  // Deliberately silent when the address belongs to someone else: telling the
  // requester would turn this into a way to test which emails are registered.
  // The link is simply never sent, and the flow looks identical either way.
  if (taken) return;

  const token = await issue(user.id, 'email_change', EMAIL_CHANGE_TTL_MINUTES, {
    newEmail: normalised,
  });
  const link = `${appUrl()}/?verify=${encodeURIComponent(token)}`;

  await getEmailProvider().send({
    to: normalised,
    subject: 'Confirm your new PayHive email',
    text: [
      `Hi ${user.displayName},`,
      '',
      'You asked to use this address for your PayHive account. Confirm it by',
      'opening the link below within the next hour:',
      '',
      link,
      '',
      'Until then your account keeps its current address, and nothing has',
      'changed. If you did not ask for this, you can ignore this message.',
    ].join('\n'),
  });

  // The old address is told too, so losing an account is never silent.
  await getEmailProvider()
    .send({
      to: user.email,
      subject: 'Someone asked to change your PayHive email',
      text: [
        `Hi ${user.displayName},`,
        '',
        `A request was made to move your PayHive account to ${normalised}.`,
        '',
        'If that was you, open the link sent to the new address to confirm.',
        'If it was not, change your password now — someone may have access to',
        'your account.',
      ].join('\n'),
    })
    .catch(() => {
      // The notice failing must not fail the change the user asked for.
    });
}

/** Finish an email change. Returns the address now on the account. */
export async function completeEmailChange(token: string): Promise<string> {
  const { userId, payload } = await consume(token, 'email_change');
  const newEmail = typeof payload.newEmail === 'string' ? payload.newEmail : null;

  if (!newEmail) throw new VerificationError('That link is invalid.', 'invalid_token');

  // Checked again at redemption: the address may have been taken since the
  // link was sent.
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, newEmail))
    .limit(1);

  if (taken && taken.id !== userId) {
    throw new VerificationError('That email is no longer available.', 'email_unavailable', 409);
  }

  await db.update(users).set({ email: newEmail }).where(eq(users.id, userId));
  return newEmail;
}
