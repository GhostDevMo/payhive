import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import {
  SESSION_COOKIE,
  allocatePayhiveId,
  createSession,
  destroySession,
  destroyOtherSessions,
  hashPassword,
  verifyPassword,
} from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { openWallet } from '../lib/wallet.js';
import { claimHandle, HandleError } from '../lib/handle.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(80),
  /** Wallet opened on signup so the dashboard is never empty-stated. */
  currency: z.string().length(3).default('USD'),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

authRouter.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: { code: 'email_taken', message: 'That email is already registered.' } });
    return;
  }

  const payhiveId = await allocatePayhiveId();
  const passwordHash = await hashPassword(parsed.data.password);

  const [created] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: parsed.data.displayName, payhiveId })
    .returning({ id: users.id, payhiveId: users.payhiveId, displayName: users.displayName });

  if (!created) {
    res.status(500).json({ error: { code: 'signup_failed', message: 'Could not create account.' } });
    return;
  }

  await openWallet(created.id, parsed.data.currency);

  const session = await createSession(created.id);
  res.cookie(SESSION_COOKIE, session.id, { ...cookieOptions, expires: session.expiresAt });
  res.status(201).json({
    user: {
      id: created.id,
      payhiveId: created.payhiveId,
      handle: null,
      displayName: created.displayName,
      email,
    },
  });
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Email and password required.' } });
    return;
  }

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email.toLowerCase()))
    .limit(1);

  const user = rows[0];
  // Same response and roughly the same work whether the user exists or not,
  // so this endpoint isn't an account-enumeration oracle.
  const ok = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } });
    return;
  }

  const session = await createSession(user.id);
  res.cookie(SESSION_COOKIE, session.id, { ...cookieOptions, expires: session.expiresAt });
  res.json({
    user: {
      id: user.id,
      payhiveId: user.payhiveId,
      handle: user.handle ?? null,
      displayName: user.displayName,
      email: user.email,
      kycStatus: user.kycStatus,
    },
  });
});

authRouter.post('/logout', async (req, res) => {
  if (req.sessionId) await destroySession(req.sessionId);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

const handleSchema = z.object({ handle: z.string().min(1).max(64) });

/**
 * Claim or change the caller's payment handle.
 *
 * The generated PayHive ID is untouched by this and keeps working forever; a
 * handle is an additional way to be paid, not a replacement for the first one.
 */
authRouter.put('/me/handle', requireAuth, async (req, res) => {
  const parsed = handleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A handle is required.' } });
    return;
  }

  try {
    const claimed = await claimHandle(req.user!.id, parsed.data.handle);
    res.json({ handle: claimed.handle });
  } catch (error) {
    if (error instanceof HandleError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  email: z.string().email().max(255).optional(),
  /** Required to change the email, because the email is how an account is recovered. */
  currentPassword: z.string().max(200).optional(),
});

/**
 * Update the caller's profile.
 *
 * The display name is what other users see when confirming a payment, so it is
 * changeable but not silently: it is the name a payer checks before sending.
 *
 * Changing the email requires the current password. An email address is the
 * route back into an account, so an unattended session must not be enough to
 * move it somewhere the real owner cannot reach.
 *
 * NOT DONE YET: the new address is trusted without being verified. Until an
 * email provider is wired up, a typo locks the user out of recovery. See the
 * README before this handles real money.
 */
authRouter.patch('/me', requireAuth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    return;
  }

  const { displayName, email, currentPassword } = parsed.data;
  if (displayName === undefined && email === undefined) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Nothing to update.' } });
    return;
  }

  const [me] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (!me) {
    res.status(404).json({ error: { code: 'user_not_found', message: 'User not found.' } });
    return;
  }

  const changes: { displayName?: string; email?: string } = {};
  if (displayName !== undefined) changes.displayName = displayName;

  if (email !== undefined && email.toLowerCase() !== me.email) {
    if (!currentPassword || !(await verifyPassword(currentPassword, me.passwordHash))) {
      res.status(403).json({
        error: { code: 'password_required', message: 'Enter your current password to change your email.' },
      });
      return;
    }

    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (taken && taken.id !== me.id) {
      // Same wording whether or not the address is in use: this endpoint must
      // not become a way to test which emails have PayHive accounts.
      res.status(409).json({
        error: { code: 'email_unavailable', message: 'That email cannot be used.' },
      });
      return;
    }
    changes.email = email.toLowerCase();
  }

  const [updated] = await db
    .update(users)
    .set(changes)
    .where(eq(users.id, req.user!.id))
    .returning({
      id: users.id,
      payhiveId: users.payhiveId,
      handle: users.handle,
      email: users.email,
      displayName: users.displayName,
      kycStatus: users.kycStatus,
    });

  res.json({ user: updated });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

/**
 * Change the password.
 *
 * Every other session is destroyed on success. If the reason for changing a
 * password is that someone else has it, leaving their session alive defeats
 * the point.
 */
authRouter.put('/me/password', requireAuth, async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'A new password of at least 10 characters is required.' },
    });
    return;
  }

  const [me] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
  if (!me || !(await verifyPassword(parsed.data.currentPassword, me.passwordHash))) {
    res.status(403).json({
      error: { code: 'invalid_credentials', message: 'That is not your current password.' },
    });
    return;
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(parsed.data.newPassword) })
    .where(eq(users.id, req.user!.id));

  await destroyOtherSessions(req.user!.id, req.sessionId!);
  res.status(204).end();
});
